import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectWav } from "./audioAssembly.js";
import { FileDurableQueue } from "./durableQueue.js";
import { ElevenLabsVoiceProvider } from "./elevenLabsVoiceProvider.js";
import { GeminiResearchProvider } from "./geminiResearchProvider.js";
import { GenerationStateMachine, type GenerationStateMachineProviders } from "./generationStateMachine.js";
import { createGenerationRequest } from "./generationRequests.js";
import { FileJobStore } from "./jobStore.js";
import { OpenAIImageProvider } from "./openAiImageProvider.js";
import { OpusScriptWriterProvider } from "./opusScriptWriterProvider.js";
import { MockStorageProvider } from "./providers.js";
import type { ProviderContext, StoredObject } from "./providers.js";

export const realProviderSmokeRequiredEnv = [
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "OPENAI_API_KEY"
] as const;

export interface RealProviderSmokeFetches {
  readonly gemini?: typeof fetch;
  readonly anthropic?: typeof fetch;
  readonly elevenLabs?: typeof fetch;
  readonly openAI?: typeof fetch;
}

export interface RealProviderSmokeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly outputDirectory?: string;
  readonly providers?: GenerationStateMachineProviders;
  readonly fetches?: RealProviderSmokeFetches;
  readonly now?: () => string;
}

export interface RealProviderSmokeLink {
  readonly role: string;
  readonly key: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly url: string;
}

export type RealProviderSmokeResult = {
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
  readonly audio: {
    readonly mimeType: "audio/wav";
    readonly durationSeconds: number;
    readonly sampleRate: number;
    readonly channelCount: number;
    readonly sizeBytes: number;
  };
  readonly links: readonly RealProviderSmokeLink[];
};

export function missingRealProviderSmokeEnv(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return realProviderSmokeRequiredEnv.filter((key) => !env[key]);
}

export function hasRealProviderSmokeConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return missingRealProviderSmokeEnv(env).length === 0;
}

export function createRealProviderSmokeProviders(
  env: NodeJS.ProcessEnv = process.env,
  fetches: RealProviderSmokeFetches = {}
): GenerationStateMachineProviders {
  return {
    research: new GeminiResearchProvider({
      apiKey: requireEnv(env, "GEMINI_API_KEY"),
      modelId: env.GEMINI_RESEARCH_MODEL,
      fetchImpl: fetches.gemini
    }),
    writer: new OpusScriptWriterProvider({
      apiKey: requireEnv(env, "ANTHROPIC_API_KEY"),
      modelId: env.ANTHROPIC_WRITER_MODEL,
      fetchImpl: fetches.anthropic
    }),
    voice: new ElevenLabsVoiceProvider({
      apiKey: requireEnv(env, "ELEVENLABS_API_KEY"),
      voiceIdMap: {
        calm_narrator_01: requireEnv(env, "ELEVENLABS_VOICE_ID")
      },
      modelId: env.ELEVENLABS_TTS_MODEL,
      outputFormat: env.ELEVENLABS_OUTPUT_FORMAT,
      fetchImpl: fetches.elevenLabs
    }),
    image: new OpenAIImageProvider({
      apiKey: requireEnv(env, "OPENAI_API_KEY"),
      modelId: env.OPENAI_IMAGE_MODEL,
      fetchImpl: fetches.openAI
    }),
    storage: new MockStorageProvider({
      baseUrl: optionalEnv(env, "REAL_PROVIDER_SMOKE_STORAGE_BASE_URL") ?? "https://sleepy-history.local",
      signingSecret: optionalEnv(env, "STORAGE_SIGNING_SECRET") ?? "real-provider-smoke-local-signing-secret"
    })
  };
}

export async function runRealProviderSmoke(options: RealProviderSmokeOptions = {}): Promise<RealProviderSmokeResult> {
  const env = options.env ?? process.env;
  const providers = options.providers ?? (
    hasRealProviderSmokeConfig(env) ? createRealProviderSmokeProviders(env, options.fetches) : undefined
  );
  if (!providers) {
    return {
      skipped: true,
      missingEnv: missingRealProviderSmokeEnv(env)
    };
  }

  const outputDirectory = options.outputDirectory ??
    optionalEnv(env, "REAL_PROVIDER_SMOKE_OUTPUT_DIR") ??
    await mkdtemp(join(tmpdir(), "sleepy-history-real-provider-smoke-"));
  await mkdir(outputDirectory, { recursive: true });

  const jobStore = new FileJobStore(join(outputDirectory, "jobs.json"));
  const queue = new FileDurableQueue(join(outputDirectory, "queue.json"), jobStore);
  const now = options.now ?? (() => new Date().toISOString());
  const machine = new GenerationStateMachine({
    queue,
    jobStore,
    providers,
    now
  });
  const jobId = "job_real_provider_smoke";
  await queue.createJob(createGenerationRequest({
    kind: "daily_life",
    subject: "a scribe closing the Library at Alexandria",
    era: "Ptolemaic Egypt",
    location: "Alexandria",
    perspective: "a quiet third-person narrator following an ordinary library scribe",
    targetDurationMinutes: 5,
    voiceId: "calm_narrator_01",
    ambience: "none"
  }), jobId, now());

  const result = await machine.runNext();
  if (result.finalStatus !== "completed") {
    throw new Error(`Real-provider smoke did not complete: ${result.finalStatus ?? "unknown"}`);
  }

  const completedJob = await jobStore.get(jobId);
  if (!completedJob?.storyId) {
    throw new Error("Real-provider smoke completed without a story ID");
  }

  const links = readAssetLinks(completedJob.metadata?.assetAccess);
  const audioLink = links.find((link) => link.role === "audio");
  if (!audioLink) {
    throw new Error("Real-provider smoke completed without an audio asset link");
  }

  const downloadedAudio = await downloadStoredObject(providers.storage, audioLink.url);
  const audioInspection = inspectWav(downloadedAudio.bytes);
  if (audioInspection.durationSeconds <= 0) {
    throw new Error("Downloaded smoke audio is not playable");
  }

  const audioPath = join(outputDirectory, "audio.wav");
  await writeFile(audioPath, downloadedAudio.bytes);
  const summary = {
    jobId,
    storyId: completedJob.storyId,
    finalStatus: result.finalStatus,
    request: completedJob.request,
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
    audio: {
      mimeType: "audio/wav",
      durationSeconds: audioInspection.durationSeconds,
      sampleRate: audioInspection.sampleRate,
      channelCount: audioInspection.channelCount,
      sizeBytes: downloadedAudio.bytes.byteLength
    },
    links
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRealProviderSmoke()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown real-provider smoke failure";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}

function requireEnv(env: NodeJS.ProcessEnv, key: typeof realProviderSmokeRequiredEnv[number]): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required for real-provider smoke`);
  }

  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  return value;
}

function readAssetLinks(input: unknown): readonly RealProviderSmokeLink[] {
  if (!isRecord(input) || !Array.isArray(input.links)) {
    throw new Error("Real-provider smoke asset access manifest is missing links");
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

async function downloadStoredObject(storage: GenerationStateMachineProviders["storage"], url: string): Promise<StoredObject> {
  if ("resolveObjectUrl" in storage && typeof storage.resolveObjectUrl === "function") {
    return storage.resolveObjectUrl(url, { jobId: "job_real_provider_smoke" } satisfies ProviderContext) as Promise<StoredObject>;
  }

  throw new Error("Real-provider smoke storage provider must support local signed URL resolution for download verification");
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
