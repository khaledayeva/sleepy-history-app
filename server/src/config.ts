export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly nodeEnv: string;
  readonly providerKillSwitch: boolean;
  readonly auth: DeviceAuthConfig;
  readonly enrollment: EnrollmentConfig;
  readonly budget: BudgetConfig;
  readonly providers: ProviderEnablement;
  readonly providerModels: ProviderModelConfig;
}

export interface DeviceAuthConfig {
  readonly deviceTokenHmacSecret: string;
  readonly allowedDeviceTokenHashes: readonly string[];
}

export interface EnrollmentConfig {
  readonly adminSecret: string;
  readonly codeTtlSeconds: number;
  readonly localEnrollmentEnabled: boolean;
  readonly storePath: string;
}

export interface BudgetConfig {
  readonly maxStoryMinutes: number;
  readonly maxJobCostUsd: number;
  readonly maxDailyCostUsd: number;
  readonly maxRetryCostUsd: number;
  readonly maxPaidRetriesPerJob: number;
  readonly maxPaidProviderAttemptsPerStage: number;
}

export interface ProviderEnablement {
  readonly geminiResearch: boolean;
  readonly anthropicWriting: boolean;
  readonly elevenLabsTts: boolean;
  readonly openAiImages: boolean;
}

export interface ProviderModelConfig {
  readonly geminiResearch: string;
  readonly anthropicWriting: string;
  readonly elevenLabsTts: string;
  readonly elevenLabsOutputFormat: string;
  readonly openAiImages: string;
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return 8787;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }

  return parsed;
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

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = parsePositiveNumber(name, value, fallback);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }

  return parsed;
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new Error(`Invalid ${name} value: ${value}`);
}

function parseCsv(value: string | undefined): readonly string[] {
  if (!value) {
    return [];
  }

  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const providerKillSwitch = parseBoolean("PROVIDER_KILL_SWITCH", env.PROVIDER_KILL_SWITCH, false);

  return {
    host: env.HOST ?? "127.0.0.1",
    port: parsePort(env.PORT),
    nodeEnv,
    providerKillSwitch,
    auth: {
      deviceTokenHmacSecret: env.DEVICE_TOKEN_HMAC_SECRET ?? "",
      allowedDeviceTokenHashes: parseCsv(env.OWNER_DEVICE_TOKEN_HASHES)
    },
    enrollment: {
      adminSecret: env.ENROLLMENT_ADMIN_SECRET ?? "",
      codeTtlSeconds: parsePositiveInteger("ENROLLMENT_CODE_TTL_SECONDS", env.ENROLLMENT_CODE_TTL_SECONDS, 600),
      storePath: env.ENROLLMENT_STORE_PATH ?? "data/enrollment.json",
      localEnrollmentEnabled: parseBoolean(
        "ENABLE_LOCAL_ENROLLMENT",
        env.ENABLE_LOCAL_ENROLLMENT,
        nodeEnv !== "production"
      )
    },
    budget: {
      maxStoryMinutes: parsePositiveNumber("MAX_STORY_MINUTES", env.MAX_STORY_MINUTES, 65),
      maxJobCostUsd: parsePositiveNumber("MAX_JOB_COST_USD", env.MAX_JOB_COST_USD, 12),
      maxDailyCostUsd: parsePositiveNumber("MAX_DAILY_COST_USD", env.MAX_DAILY_COST_USD, 40),
      maxRetryCostUsd: parsePositiveNumber("MAX_RETRY_COST_USD", env.MAX_RETRY_COST_USD, 21),
      maxPaidRetriesPerJob: parsePositiveInteger("MAX_PAID_RETRIES_PER_JOB", env.MAX_PAID_RETRIES_PER_JOB, 1),
      maxPaidProviderAttemptsPerStage: parsePositiveInteger(
        "MAX_PAID_PROVIDER_ATTEMPTS_PER_STAGE",
        env.MAX_PAID_PROVIDER_ATTEMPTS_PER_STAGE,
        2
      )
    },
    providers: {
      geminiResearch: parseBoolean("ENABLE_GEMINI_RESEARCH", env.ENABLE_GEMINI_RESEARCH, false),
      anthropicWriting: parseBoolean("ENABLE_ANTHROPIC_WRITING", env.ENABLE_ANTHROPIC_WRITING, false),
      elevenLabsTts: parseBoolean("ENABLE_ELEVENLABS_TTS", env.ENABLE_ELEVENLABS_TTS, false),
      openAiImages: parseBoolean("ENABLE_OPENAI_IMAGES", env.ENABLE_OPENAI_IMAGES, false)
    },
    providerModels: {
      geminiResearch: env.GEMINI_RESEARCH_MODEL ?? "gemini-3.1-pro-preview",
      anthropicWriting: env.ANTHROPIC_WRITER_MODEL ?? "claude-opus-4-6",
      elevenLabsTts: env.ELEVENLABS_TTS_MODEL ?? "eleven_multilingual_v2",
      elevenLabsOutputFormat: env.ELEVENLABS_OUTPUT_FORMAT ?? "pcm_24000",
      openAiImages: env.OPENAI_IMAGE_MODEL ?? "gpt-image-2"
    }
  };
}
