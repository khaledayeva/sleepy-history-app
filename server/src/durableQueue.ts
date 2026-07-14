import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JobStore } from "./jobStore.js";
import type { GenerationJob, GenerationRequest, JobStatus } from "./schemas.js";
import { parseGenerationJob } from "./schemas.js";

export type QueueStatus = "queued" | "running" | "completed" | "failed" | "canceled";
export type ProviderStage = "research" | "write" | "review" | "voice" | "image" | "storage";

export interface StageCheckpoint {
  readonly stage: JobStatus;
  readonly substage?: string;
  readonly percent: number;
  readonly idempotencyKey: string;
  readonly updatedAt: string;
  readonly message?: string;
}

export interface AudioChunkCheckpoint {
  readonly chunkId: string;
  readonly chapterId: string;
  readonly idempotencyKey: string;
  readonly assetId?: string;
  readonly completedAt?: string;
}

export interface DurableQueueItem {
  readonly jobId: string;
  readonly status: QueueStatus;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stageCheckpoints: readonly StageCheckpoint[];
  readonly audioChunkCheckpoints: readonly AudioChunkCheckpoint[];
}

export interface ClaimNextOptions {
  readonly runningStaleAfterMs?: number;
}

interface PersistedDurableQueue {
  readonly schemaVersion: "2026-05-10";
  readonly items: readonly DurableQueueItem[];
}

export class FileDurableQueue {
  constructor(
    private readonly filePath: string,
    private readonly jobStore: JobStore
  ) {}

  async enqueue(job: GenerationJob): Promise<DurableQueueItem> {
    await this.jobStore.save(job);
    const items = new Map((await this.list()).map((item) => [item.jobId, item]));
    const existing = items.get(job.id);
    const item: DurableQueueItem = existing ?? {
      jobId: job.id,
      status: "queued",
      attempts: 0,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      stageCheckpoints: [],
      audioChunkCheckpoints: []
    };

    items.set(job.id, item);
    await this.write([...items.values()]);
    return item;
  }

  async createJob(request: GenerationRequest, jobId: string, now: string): Promise<GenerationJob> {
    const job: GenerationJob = {
      id: jobId,
      status: "queued",
      request,
      progress: {
        stage: "queued",
        percent: 0,
        message: "Queued"
      },
      createdAt: now,
      updatedAt: now
    };

    await this.enqueue(job);
    return job;
  }

  async claimNext(now: string, options: ClaimNextOptions = {}): Promise<DurableQueueItem | undefined> {
    const items = await this.list();
    const item = items.find((candidate) => (
      candidate.status === "running" &&
      isRunningItemClaimable(candidate, now, options.runningStaleAfterMs ?? 0)
    )) ??
      items.find((candidate) => candidate.status === "queued");
    if (!item) {
      return undefined;
    }

    const claimed: DurableQueueItem = {
      ...item,
      status: "running",
      attempts: item.status === "queued" ? item.attempts + 1 : item.attempts,
      updatedAt: now
    };

    await this.replaceItem(claimed);
    return claimed;
  }

  async checkpointStage(
    jobId: string,
    stage: JobStatus,
    percent: number,
    now: string,
    message?: string,
    substage?: string
  ): Promise<StageCheckpoint> {
    const checkpoint: StageCheckpoint = {
      stage,
      substage,
      percent,
      idempotencyKey: providerIdempotencyKey(jobId, stage, substage),
      updatedAt: now,
      message
    };
    const item = await this.requireItem(jobId);

    await this.jobStore.update(jobId, (job) => ({
      ...job,
      status: stage,
      progress: {
        stage,
        percent,
        message
      },
      updatedAt: now
    }));
    await this.replaceItem({
      ...item,
      status: queueStatusForStage(stage, item.status),
      updatedAt: now,
      stageCheckpoints: replaceBy(
        item.stageCheckpoints,
        (entry) => entry.stage === stage && entry.substage === substage,
        checkpoint
      )
    });

    return checkpoint;
  }

  async checkpointAudioChunk(input: {
    readonly jobId: string;
    readonly chapterId: string;
    readonly chunkId: string;
    readonly assetId?: string;
    readonly completedAt?: string;
  }): Promise<AudioChunkCheckpoint> {
    const item = await this.requireItem(input.jobId);
    const checkpoint: AudioChunkCheckpoint = {
      chunkId: input.chunkId,
      chapterId: input.chapterId,
      idempotencyKey: providerIdempotencyKey(input.jobId, "voice", input.chunkId),
      assetId: input.assetId,
      completedAt: input.completedAt
    };

    await this.replaceItem({
      ...item,
      updatedAt: input.completedAt ?? item.updatedAt,
      audioChunkCheckpoints: replaceBy(
        item.audioChunkCheckpoints,
        (entry) => entry.chunkId === input.chunkId,
        checkpoint
      )
    });

    return checkpoint;
  }

  async resumePending(): Promise<readonly DurableQueueItem[]> {
    return (await this.list()).filter((item) => item.status === "queued" || item.status === "running");
  }

  async retryJob(jobId: string, now: string): Promise<GenerationJob> {
    const item = await this.requireItem(jobId);
    const job = await this.jobStore.update(jobId, (current) => ({
      ...current,
      status: "queued",
      progress: {
        stage: "queued",
        percent: 0,
        message: "Queued for retry"
      },
      storyId: undefined,
      error: undefined,
      metadata: undefined,
      updatedAt: now
    }));

    await this.replaceItem({
      ...item,
      status: "queued",
      updatedAt: now,
      stageCheckpoints: [],
      audioChunkCheckpoints: []
    });

    return job;
  }

  async deleteJob(jobId: string): Promise<boolean> {
    const items = await this.list();
    const nextItems = items.filter((item) => item.jobId !== jobId);
    const deletedQueueItem = nextItems.length !== items.length;
    const deletedJob = await this.jobStore.delete(jobId);

    if (deletedQueueItem) {
      await this.write(nextItems);
    }

    return deletedQueueItem || deletedJob;
  }

  async list(): Promise<readonly DurableQueueItem[]> {
    return this.read();
  }

  private async requireItem(jobId: string): Promise<DurableQueueItem> {
    const item = (await this.list()).find((candidate) => candidate.jobId === jobId);
    if (!item) {
      throw new Error(`Queue item not found: ${jobId}`);
    }

    return item;
  }

  private async replaceItem(item: DurableQueueItem): Promise<void> {
    const items = new Map((await this.list()).map((existing) => [existing.jobId, existing]));
    items.set(item.jobId, item);
    await this.write([...items.values()]);
  }

  private async read(): Promise<readonly DurableQueueItem[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }

    const parsed = JSON.parse(text) as unknown;
    return asPersistedDurableQueue(parsed).items;
  }

  private async write(items: readonly DurableQueueItem[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload: PersistedDurableQueue = {
      schemaVersion: "2026-05-10",
      items
    };
    const temporaryPath = `${this.filePath}.tmp`;

    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

export function providerIdempotencyKey(jobId: string, stage: JobStatus | ProviderStage, chunkId?: string): string {
  return ["sleepy-history", jobId, stage, chunkId].filter(Boolean).join(":");
}

function asPersistedDurableQueue(input: unknown): PersistedDurableQueue {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Persisted durable queue must be an object");
  }

  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== "2026-05-10") {
    throw new Error("Unsupported durable queue schemaVersion");
  }
  if (!Array.isArray(record.items)) {
    throw new Error("Persisted durable queue items must be an array");
  }

  return {
    schemaVersion: "2026-05-10",
    items: record.items.map(readQueueItem)
  };
}

function readQueueItem(input: unknown): DurableQueueItem {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Durable queue item must be an object");
  }

  const item = input as DurableQueueItem;
  if (typeof item.jobId !== "string") {
    throw new Error("Durable queue item jobId must be a string");
  }

  parseGenerationJobMarker(item.jobId);
  return item;
}

function parseGenerationJobMarker(jobId: string): void {
  if (jobId.trim().length === 0) {
    throw new Error("Durable queue item jobId must be non-empty");
  }
}

function queueStatusForStage(stage: JobStatus, fallback: QueueStatus): QueueStatus {
  if (stage === "completed") {
    return "completed";
  }
  if (stage === "failed") {
    return "failed";
  }
  if (stage === "canceled") {
    return "canceled";
  }

  return fallback;
}

function isRunningItemClaimable(item: DurableQueueItem, now: string, staleAfterMs: number): boolean {
  if (staleAfterMs <= 0) {
    return true;
  }

  const nowMs = Date.parse(now);
  const updatedAtMs = Date.parse(item.updatedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(updatedAtMs)) {
    return true;
  }

  return nowMs - updatedAtMs >= staleAfterMs;
}

function replaceBy<T>(items: readonly T[], predicate: (item: T) => boolean, value: T): readonly T[] {
  const next = items.filter((item) => !predicate(item));
  next.push(value);
  return next;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
