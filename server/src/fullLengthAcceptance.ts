import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectWav } from "./audioAssembly.js";
import { estimateGenerationCost } from "./budget.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { FileDurableQueue, type DurableQueueItem } from "./durableQueue.js";
import { GenerationStateMachine, type GenerationStateMachineProviders } from "./generationStateMachine.js";
import { createGenerationRequest } from "./generationRequests.js";
import { FileJobStore } from "./jobStore.js";
import { createProductionProviders } from "./productionRuntime.js";
import type { ProviderContext, StoredObject } from "./providers.js";
import { missingRealProviderSmokeEnv } from "./realProviderSmoke.js";
import type { GenerationJob } from "./schemas.js";

export const fullLengthAcceptanceRequiredStorageEnv = [
  "STORAGE_PROVIDER",
  "STORAGE_ENDPOINT",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY"
] as const;

export interface FullLengthAcceptanceOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly outputDirectory?: string;
  readonly providers?: GenerationStateMachineProviders;
  readonly now?: () => string;
  readonly budgetCapUsd?: number;
  readonly targetDurationMinutes?: number;
  readonly jobId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly expectedDurationSecondsRange?: {
    readonly min: number;
    readonly max: number;
  };
}

export interface FullLengthAcceptanceAssetLink {
  readonly role: string;
  readonly key: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly url: string;
}

export type FullLengthAcceptanceResult = {
  readonly skipped: true;
  readonly missingEnv: readonly string[];
} | {
  readonly skipped: false;
  readonly jobId: string;
  readonly storyId: string;
  readonly finalStatus: "completed";
  readonly outputDirectory: string;
  readonly audioPath: string;
  readonly summaryPath: string;
  readonly approvedBudgetCapUsd: number;
  readonly estimatedCostUsd: number;
  readonly retryExposureUsd: number;
  readonly targetDurationMinutes: number;
  readonly audio: {
    readonly mimeType: "audio/wav";
    readonly durationSeconds: number;
    readonly sampleRate: number;
    readonly channelCount: number;
    readonly sizeBytes: number;
  };
  readonly chunkCount: number;
  readonly stageCheckpointCount: number;
  readonly retryEvidence: {
    readonly queueAttempts: number;
    readonly paidRetriesUsed: number;
    readonly failureCount: number;
  };
  readonly restartEvidence: {
    readonly queuedBeforeRestart: boolean;
    readonly processedAfterRestart: boolean;
  };
  readonly links: readonly FullLengthAcceptanceAssetLink[];
};

export function fullLengthAcceptanceAudioDurationRangeSeconds(targetDurationMinutes: number): {
  readonly min: number;
  readonly max: number;
} {
  return {
    min: Math.max(1, Math.floor(targetDurationMinutes * 0.75 * 60)),
    max: Math.ceil((targetDurationMinutes + 20) * 60)
  };
}

export function missingFullLengthAcceptanceEnv(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const missingProviderEnv = missingRealProviderSmokeEnv(env);
  const missingStorageEnv = fullLengthAcceptanceRequiredStorageEnv.filter((key) => !env[key]);
  return [...missingProviderEnv, ...missingStorageEnv];
}

export function hasFullLengthAcceptanceConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return missingFullLengthAcceptanceEnv(env).length === 0;
}

export async function runFullLengthAcceptance(
  options: FullLengthAcceptanceOptions = {}
): Promise<FullLengthAcceptanceResult> {
  const env = acceptanceEnv(options.env ?? process.env, options.budgetCapUsd);
  const providers = options.providers ?? (hasFullLengthAcceptanceConfig(env) ? createProductionProviders(env) : undefined);
  if (!providers) {
    return {
      skipped: true,
      missingEnv: missingFullLengthAcceptanceEnv(env)
    };
  }

  const budgetCapUsd = options.budgetCapUsd ?? parsePositiveNumber(
    "FULL_LENGTH_ACCEPTANCE_BUDGET_CAP_USD",
    env.FULL_LENGTH_ACCEPTANCE_BUDGET_CAP_USD,
    25
  );
  const targetDurationMinutes = options.targetDurationMinutes ?? parsePositiveNumber(
    "FULL_LENGTH_ACCEPTANCE_TARGET_MINUTES",
    env.FULL_LENGTH_ACCEPTANCE_TARGET_MINUTES,
    60
  );
  if (targetDurationMinutes < 55 || targetDurationMinutes > 65) {
    throw new Error(`Full-length acceptance target must be 55 to 65 minutes: ${targetDurationMinutes}`);
  }

  const config = loadAcceptanceConfig(env, budgetCapUsd);
  const request = createGenerationRequest({
    kind: "daily_life",
    subject: "a scribe closing the Library at Alexandria",
    era: "Ptolemaic Egypt",
    location: "Alexandria",
    perspective: "a quiet third-person narrator following an ordinary library scribe through the end of a gentle workday",
    targetDurationMinutes,
    voiceId: "calm_narrator_01",
    ambience: "none"
  });
  const estimate = estimateGenerationCost(request, config.budget);
  if (estimate.totalUsd > budgetCapUsd) {
    throw new Error(`Estimated acceptance cost ${estimate.totalUsd} exceeds approved budget cap ${budgetCapUsd}`);
  }

  const outputDirectory = options.outputDirectory ??
    env.FULL_LENGTH_ACCEPTANCE_OUTPUT_DIR ??
    await mkdtemp(join(tmpdir(), "sleepy-history-full-length-acceptance-"));
  await mkdir(outputDirectory, { recursive: true });

  const jobPath = join(outputDirectory, "jobs.json");
  const queuePath = join(outputDirectory, "queue.json");
  const now = options.now ?? (() => new Date().toISOString());
  const jobId = options.jobId ?? "job_full_length_acceptance";
  const initialJobStore = new FileJobStore(jobPath);
  const initialQueue = new FileDurableQueue(queuePath, initialJobStore);
  await initialQueue.createJob(request, jobId, now());
  const pendingBeforeRestart = await initialQueue.resumePending();

  const restartedJobStore = new FileJobStore(jobPath);
  const restartedQueue = new FileDurableQueue(queuePath, restartedJobStore);
  const machine = new GenerationStateMachine({
    queue: restartedQueue,
    jobStore: restartedJobStore,
    providers,
    now
  });
  const result = await machine.runNext();
  if (result.finalStatus !== "completed") {
    const failedJob = await restartedJobStore.get(jobId);
    await writeFailureSummary(outputDirectory, jobId, failedJob, result);
    throw new Error(`Full-length acceptance did not complete: ${result.finalStatus ?? "unknown"}`);
  }

  const completedJob = await requireCompletedJob(restartedJobStore, jobId);
  const queueItem = await requireQueueItem(restartedQueue, jobId);
  const links = readAssetLinks(completedJob.metadata?.assetAccess);
  const audioLink = links.find((link) => link.role === "audio");
  if (!audioLink) {
    throw new Error("Full-length acceptance completed without an audio asset link");
  }

  const downloadedAudio = await downloadStoredObject(providers.storage, audioLink.url, options.fetchImpl ?? fetch);
  const audioInspection = inspectWav(downloadedAudio.bytes);
  const expectedDurationRange = options.expectedDurationSecondsRange ??
    fullLengthAcceptanceAudioDurationRangeSeconds(targetDurationMinutes);
  const minDurationSeconds = expectedDurationRange.min;
  const maxDurationSeconds = expectedDurationRange.max;
  if (audioInspection.durationSeconds < minDurationSeconds || audioInspection.durationSeconds > maxDurationSeconds) {
    throw new Error(
      `Full-length acceptance audio duration ${audioInspection.durationSeconds}s is outside ` +
        `${Math.round(minDurationSeconds / 60)} to ${Math.round(maxDurationSeconds / 60)} minutes`
    );
  }

  const audioPath = join(outputDirectory, "audio.wav");
  await writeFile(audioPath, downloadedAudio.bytes);
  const summary = {
    jobId,
    storyId: completedJob.storyId,
    finalStatus: result.finalStatus,
    approvedBudgetCapUsd: budgetCapUsd,
    estimatedCostUsd: estimate.totalUsd,
    retryExposureUsd: estimate.retryExposureUsd,
    targetDurationMinutes,
    request: completedJob.request,
    restartEvidence: {
      queuedBeforeRestart: pendingBeforeRestart.some((item) => item.jobId === jobId),
      processedAfterRestart: result.processed === true
    },
    retryEvidence: {
      queueAttempts: queueItem.attempts,
      paidRetriesUsed: Math.max(0, queueItem.attempts - 1),
      failureCount: completedJob.error ? 1 : 0
    },
    stageCheckpointCount: queueItem.stageCheckpoints.length,
    chunkCount: queueItem.audioChunkCheckpoints.length,
    links,
    audio: {
      mimeType: downloadedAudio.mimeType,
      durationSeconds: audioInspection.durationSeconds,
      sampleRate: audioInspection.sampleRate,
      channelCount: audioInspection.channelCount,
      sizeBytes: downloadedAudio.bytes.byteLength
    }
  };
  const summaryPath = join(outputDirectory, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  return {
    skipped: false,
    jobId,
    storyId: completedJob.storyId,
    finalStatus: "completed",
    outputDirectory,
    audioPath,
    summaryPath,
    approvedBudgetCapUsd: budgetCapUsd,
    estimatedCostUsd: estimate.totalUsd,
    retryExposureUsd: estimate.retryExposureUsd,
    targetDurationMinutes,
    audio: {
      mimeType: "audio/wav",
      durationSeconds: audioInspection.durationSeconds,
      sampleRate: audioInspection.sampleRate,
      channelCount: audioInspection.channelCount,
      sizeBytes: downloadedAudio.bytes.byteLength
    },
    chunkCount: queueItem.audioChunkCheckpoints.length,
    stageCheckpointCount: queueItem.stageCheckpoints.length,
    retryEvidence: {
      queueAttempts: queueItem.attempts,
      paidRetriesUsed: Math.max(0, queueItem.attempts - 1),
      failureCount: completedJob.error ? 1 : 0
    },
    restartEvidence: {
      queuedBeforeRestart: pendingBeforeRestart.some((item) => item.jobId === jobId),
      processedAfterRestart: result.processed === true
    },
    links
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const budgetCapUsd = readNumberArg("--budget-cap-usd");
  const targetDurationMinutes = readNumberArg("--target-minutes");

  runFullLengthAcceptance({
    budgetCapUsd,
    targetDurationMinutes
  })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown full-length acceptance failure";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}

function acceptanceEnv(env: NodeJS.ProcessEnv, budgetCapUsd: number | undefined): NodeJS.ProcessEnv {
  return {
    ...env,
    ENABLE_GEMINI_RESEARCH: env.ENABLE_GEMINI_RESEARCH ?? "true",
    ENABLE_ANTHROPIC_WRITING: env.ENABLE_ANTHROPIC_WRITING ?? "true",
    ENABLE_ELEVENLABS_TTS: env.ENABLE_ELEVENLABS_TTS ?? "true",
    ENABLE_OPENAI_IMAGES: env.ENABLE_OPENAI_IMAGES ?? "true",
    MAX_JOB_COST_USD: env.MAX_JOB_COST_USD ?? String(budgetCapUsd ?? env.FULL_LENGTH_ACCEPTANCE_BUDGET_CAP_USD ?? 25),
    MAX_DAILY_COST_USD: env.MAX_DAILY_COST_USD ?? String(budgetCapUsd ?? env.FULL_LENGTH_ACCEPTANCE_BUDGET_CAP_USD ?? 25)
  };
}

function loadAcceptanceConfig(env: NodeJS.ProcessEnv, budgetCapUsd: number): ServerConfig {
  return loadConfig({
    ...env,
    MAX_JOB_COST_USD: String(Math.min(parsePositiveNumber("MAX_JOB_COST_USD", env.MAX_JOB_COST_USD, budgetCapUsd), budgetCapUsd)),
    MAX_DAILY_COST_USD: String(Math.min(parsePositiveNumber("MAX_DAILY_COST_USD", env.MAX_DAILY_COST_USD, budgetCapUsd), budgetCapUsd))
  });
}

async function requireCompletedJob(jobStore: FileJobStore, jobId: string): Promise<GenerationJob & { readonly storyId: string }> {
  const job = await jobStore.get(jobId);
  if (!job?.storyId || job.status !== "completed") {
    throw new Error("Full-length acceptance completed without a completed story job");
  }

  return job as GenerationJob & { readonly storyId: string };
}

async function requireQueueItem(queue: FileDurableQueue, jobId: string): Promise<DurableQueueItem> {
  const item = (await queue.list()).find((candidate) => candidate.jobId === jobId);
  if (!item) {
    throw new Error(`Full-length acceptance queue item not found: ${jobId}`);
  }

  return item;
}

function readAssetLinks(input: unknown): readonly FullLengthAcceptanceAssetLink[] {
  if (!isRecord(input) || !Array.isArray(input.links)) {
    throw new Error("Full-length acceptance asset access manifest is missing links");
  }

  return input.links.map((link, index) => {
    if (!isRecord(link)) {
      throw new Error(`Asset link ${index} must be an object`);
    }

    return {
      role: requireString(link.role, `links[${index}].role`),
      key: requireString(link.key, `links[${index}].key`),
      mimeType: requireString(link.mimeType, `links[${index}].mimeType`),
      sizeBytes: requireNumber(link.sizeBytes, `links[${index}].sizeBytes`),
      url: requireString(link.url, `links[${index}].url`)
    };
  });
}

async function downloadStoredObject(
  storage: GenerationStateMachineProviders["storage"],
  url: string,
  fetchImpl: typeof fetch
): Promise<StoredObject> {
  if ("resolveObjectUrl" in storage && typeof storage.resolveObjectUrl === "function") {
    return storage.resolveObjectUrl(url, { jobId: "job_full_length_acceptance" } satisfies ProviderContext) as Promise<StoredObject>;
  }

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Full-length acceptance audio download failed: ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    key: new URL(url).pathname,
    mimeType: response.headers.get("content-type") ?? "audio/wav",
    bytes
  };
}

async function writeFailureSummary(
  outputDirectory: string,
  jobId: string,
  job: GenerationJob | undefined,
  result: { readonly finalStatus?: GenerationJob["status"] }
): Promise<void> {
  const writerDiagnostics = job?.metadata?.writerDiagnostics;
  if (writerDiagnostics) {
    await writeFile(
      join(outputDirectory, "draft-script-diagnostics.json"),
      `${JSON.stringify(writerDiagnostics, null, 2)}\n`,
      "utf8"
    );
  }
  await writeFile(join(outputDirectory, "failure-summary.json"), `${JSON.stringify({
    jobId,
    finalStatus: result.finalStatus,
    status: job?.status,
    error: job?.error,
    progress: job?.progress,
    diagnosticsPath: writerDiagnostics ? "draft-script-diagnostics.json" : undefined
  }, null, 2)}\n`, "utf8");
}

function readNumberArg(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value) {
    throw new Error(`${name} requires a value`);
  }

  return parsePositiveNumber(name, value, 0);
}

function parsePositiveNumber(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }

  return parsed;
}

function requireString(input: unknown, path: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }

  return input;
}

function requireNumber(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new Error(`${path} must be a finite number`);
  }

  return input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
