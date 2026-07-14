import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GenerationJob } from "./schemas.js";
import { parseGenerationJob } from "./schemas.js";

export interface JobStore {
  save(job: GenerationJob): Promise<void>;
  get(id: string): Promise<GenerationJob | undefined>;
  list(): Promise<readonly GenerationJob[]>;
  update(id: string, updater: (job: GenerationJob) => GenerationJob): Promise<GenerationJob>;
  delete(id: string): Promise<boolean>;
}

interface PersistedJobStore {
  readonly schemaVersion: "2026-05-10";
  readonly jobs: readonly GenerationJob[];
}

export class FileJobStore implements JobStore {
  constructor(private readonly filePath: string) {}

  async save(job: GenerationJob): Promise<void> {
    const jobs = new Map((await this.list()).map((existingJob) => [existingJob.id, existingJob]));
    jobs.set(job.id, job);
    await this.write([...jobs.values()]);
  }

  async get(id: string): Promise<GenerationJob | undefined> {
    return (await this.list()).find((job) => job.id === id);
  }

  async list(): Promise<readonly GenerationJob[]> {
    return this.read();
  }

  async update(id: string, updater: (job: GenerationJob) => GenerationJob): Promise<GenerationJob> {
    const jobs = await this.list();
    const nextJobs: GenerationJob[] = [];
    let updatedJob: GenerationJob | undefined;

    for (const job of jobs) {
      if (job.id === id) {
        updatedJob = updater(job);
        nextJobs.push(updatedJob);
      } else {
        nextJobs.push(job);
      }
    }

    if (!updatedJob) {
      throw new Error(`Job not found: ${id}`);
    }

    await this.write(nextJobs);
    return updatedJob;
  }

  async delete(id: string): Promise<boolean> {
    const jobs = await this.list();
    const nextJobs = jobs.filter((job) => job.id !== id);
    if (nextJobs.length === jobs.length) {
      return false;
    }

    await this.write(nextJobs);
    return true;
  }

  private async read(): Promise<readonly GenerationJob[]> {
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
    const record = asPersistedJobStore(parsed);
    return record.jobs.map((job) => parseGenerationJob(job));
  }

  private async write(jobs: readonly GenerationJob[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload: PersistedJobStore = {
      schemaVersion: "2026-05-10",
      jobs
    };
    const temporaryPath = `${this.filePath}.tmp`;

    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function asPersistedJobStore(input: unknown): PersistedJobStore {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Persisted job store must be an object");
  }

  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== "2026-05-10") {
    throw new Error("Unsupported persisted job store schemaVersion");
  }
  if (!Array.isArray(record.jobs)) {
    throw new Error("Persisted job store jobs must be an array");
  }

  return {
    schemaVersion: "2026-05-10",
    jobs: record.jobs.map((job) => parseGenerationJob(job))
  };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
