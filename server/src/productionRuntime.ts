import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createFullLengthAcceptanceStory, fullLengthAcceptanceStoryId } from "./acceptanceStory.js";
import { evaluateGenerationGuardrails, type CostEstimate, type BudgetUsage } from "./budget.js";
import type { ServerConfig } from "./config.js";
import { FileDurableQueue } from "./durableQueue.js";
import { ElevenLabsVoiceProvider } from "./elevenLabsVoiceProvider.js";
import { FileBackedEnrollmentRuntime } from "./enrollment.js";
import { GeminiResearchProvider } from "./geminiResearchProvider.js";
import { GenerationStateMachine, type GenerationStateMachineProviders } from "./generationStateMachine.js";
import { getGeneratedStory } from "./generatedStory.js";
import { FileJobStore } from "./jobStore.js";
import { OpenAIImageProvider } from "./openAiImageProvider.js";
import { OpusScriptWriterProvider } from "./opusScriptWriterProvider.js";
import { createStorageProviderFromEnv } from "./providers.js";
import type { GenerationJob } from "./schemas.js";
import type { AppRuntime } from "./server.js";

export interface HostedRuntime {
  readonly runtime: AppRuntime;
  readonly worker: HostedGenerationWorker;
}

export interface WorkerHealth {
  readonly ok: boolean;
  readonly status: "idle" | "processing" | "error" | "stopped";
  readonly processedJobs: number;
  readonly lastRunAt?: string;
  readonly lastJobId?: string;
  readonly lastFinalStatus?: GenerationJob["status"];
  readonly lastError?: string;
}

export interface HostedRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly providers?: GenerationStateMachineProviders;
}

const defaultElevenLabsVoiceId = "oaGwHLz3csUaSnc2NBD4";

export class HostedGenerationWorker {
  private timeout: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = true;
  private health: WorkerHealth = {
    ok: true,
    status: "idle",
    processedJobs: 0
  };

  constructor(
    private readonly machine: GenerationStateMachine,
    private readonly pollIntervalMs: number
  ) {}

  start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    this.health = {
      ...this.health,
      ok: true,
      status: "stopped"
    };
  }

  async runOnce(): Promise<WorkerHealth> {
    if (this.running) {
      return this.health;
    }

    this.running = true;
    this.health = {
      ...this.health,
      ok: true,
      status: "processing",
      lastRunAt: new Date().toISOString(),
      lastError: undefined
    };

    try {
      const result = await this.machine.runNext();
      this.health = {
        ok: true,
        status: "idle",
        processedJobs: this.health.processedJobs + (result.processed ? 1 : 0),
        lastRunAt: new Date().toISOString(),
        lastJobId: result.jobId,
        lastFinalStatus: result.finalStatus,
        lastError: result.errorMessage
      };
      return this.health;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown worker error";
      this.health = {
        ...this.health,
        ok: false,
        status: "error",
        lastRunAt: new Date().toISOString(),
        lastError: message
      };
      return this.health;
    } finally {
      this.running = false;
    }
  }

  getHealth(): WorkerHealth {
    return this.health;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.timeout = setTimeout(() => {
      this.runOnce()
        .finally(() => this.schedule(this.pollIntervalMs));
    }, delayMs);
  }
}

export function createHostedRuntime(config: ServerConfig, options: HostedRuntimeOptions = {}): HostedRuntime {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString());
  const dataDirectory = env.DATA_DIR ?? "data";
  const jobStore = new FileJobStore(env.JOB_STORE_PATH ?? join(dataDirectory, "jobs.json"));
  const queue = new FileDurableQueue(env.QUEUE_STORE_PATH ?? join(dataDirectory, "queue.json"), jobStore);
  const providers = options.providers ?? createProductionProviders(env);
  const machine = new GenerationStateMachine({
    queue,
    jobStore,
    providers,
    now,
    runningJobStaleAfterMs: parseNonNegativeInteger(
      "RUNNING_JOB_STALE_MS",
      env.RUNNING_JOB_STALE_MS,
      120000
    )
  });
  const worker = new HostedGenerationWorker(
    machine,
    parsePositiveInteger("WORKER_POLL_INTERVAL_MS", env.WORKER_POLL_INTERVAL_MS, 5000)
  );
  const budgetRuntime = createProcessBudgetRuntime(now);
  const enrollmentRuntime = config.auth.deviceTokenHmacSecret
    ? new FileBackedEnrollmentRuntime(config.auth.deviceTokenHmacSecret, config.enrollment.storePath, () => new Date(now()))
    : undefined;

  const runtime: AppRuntime = {
    ...budgetRuntime,
    createGenerationJob: (request, estimate) => {
      assertGuardrailsStillPass(config, budgetRuntime.budgetUsage(), request, estimate);
      return queue.createJob(request, `job_${randomUUID()}`, now());
    },
    getGenerationJob: (jobId) => jobStore.get(jobId),
    cancelGenerationJob: (jobId, reason) => machine.cancelJob(jobId, reason),
    retryGenerationJob: (jobId) => machine.retryJob(jobId),
    deleteGenerationJob: (jobId) => machine.deleteJob(jobId),
    getStory: (storyId) => getGeneratedStory(jobStore, providers.storage, storyId, now),
    getDemoStory: (storyId) => storyId === fullLengthAcceptanceStoryId
      ? createFullLengthAcceptanceStory(providers.storage, now)
      : undefined,
    createEnrollmentCode: enrollmentRuntime?.createEnrollmentCode.bind(enrollmentRuntime),
    exchangeEnrollmentCode: enrollmentRuntime?.exchangeEnrollmentCode.bind(enrollmentRuntime),
    deviceTokenHashes: enrollmentRuntime?.deviceTokenHashes.bind(enrollmentRuntime),
    workerHealth: () => worker.getHealth()
  };

  return {
    runtime,
    worker
  };
}

export function createProductionProviders(env: NodeJS.ProcessEnv = process.env): GenerationStateMachineProviders {
  return {
    research: new GeminiResearchProvider({
      apiKey: requireEnv(env, "GEMINI_API_KEY"),
      modelId: env.GEMINI_RESEARCH_MODEL
    }),
    writer: new OpusScriptWriterProvider({
      apiKey: requireEnv(env, "ANTHROPIC_API_KEY"),
      modelId: env.ANTHROPIC_WRITER_MODEL
    }),
    voice: new ElevenLabsVoiceProvider({
      apiKey: requireEnv(env, "ELEVENLABS_API_KEY"),
      voiceIdMap: {
        calm_narrator_01: env.ELEVENLABS_VOICE_ID_OVERRIDE ?? defaultElevenLabsVoiceId
      },
      modelId: env.ELEVENLABS_TTS_MODEL,
      outputFormat: env.ELEVENLABS_OUTPUT_FORMAT
    }),
    image: new OpenAIImageProvider({
      apiKey: requireEnv(env, "OPENAI_API_KEY"),
      modelId: env.OPENAI_IMAGE_MODEL
    }),
    storage: createStorageProviderFromEnv(env)
  };
}

function createProcessBudgetRuntime(now: () => string): Required<Pick<AppRuntime, "budgetUsage" | "recordAcceptedEstimate">> {
  let dailyCostUsd = 0;
  let dayKey = now().slice(0, 10);

  function refreshDay(): void {
    const nextDayKey = now().slice(0, 10);
    if (nextDayKey !== dayKey) {
      dayKey = nextDayKey;
      dailyCostUsd = 0;
    }
  }

  return {
    budgetUsage: () => {
      refreshDay();
      return {
        dailyCostUsd
      };
    },
    recordAcceptedEstimate: (estimate: CostEstimate) => {
      refreshDay();
      dailyCostUsd = Math.round((dailyCostUsd + estimate.totalUsd) * 100) / 100;
    }
  };
}

function assertGuardrailsStillPass(
  config: ServerConfig,
  usage: BudgetUsage,
  request: Parameters<NonNullable<AppRuntime["createGenerationJob"]>>[0],
  expectedEstimate: CostEstimate
): void {
  const decision = evaluateGenerationGuardrails({
    request,
    budget: config.budget,
    providers: config.providers,
    providerKillSwitch: config.providerKillSwitch,
    usage
  });

  if (!decision.ok || decision.estimate.totalUsd !== expectedEstimate.totalUsd) {
    throw new Error("Generation guardrails changed before queueing the job");
  }
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}
