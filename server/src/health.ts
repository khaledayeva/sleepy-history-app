import type { ProviderEnablement, ProviderModelConfig, ServerConfig } from "./config.js";
import type { WorkerHealth } from "./productionRuntime.js";

export interface HealthResponse {
  readonly ok: true;
  readonly service: "sleepy-history-server";
  readonly mode: string;
  readonly providerKillSwitch: boolean;
  readonly providers: readonly PublicProviderStatus[];
  readonly worker?: PublicWorkerHealth;
}

export function getHealth(config: ServerConfig, worker?: WorkerHealth): HealthResponse {
  return {
    ok: true,
    service: "sleepy-history-server",
    mode: config.nodeEnv,
    providerKillSwitch: config.providerKillSwitch,
    providers: publicProviderStatuses(config.providers, config.providerModels, config.providerKillSwitch, worker),
    ...(worker ? { worker: publicWorkerHealth(worker) } : {})
  };
}

export type PublicProviderState = "online" | "offline" | "credits_depleted" | "warning";

export interface PublicProviderStatus {
  readonly id: string;
  readonly step: string;
  readonly provider: string;
  readonly model?: string;
  readonly state: PublicProviderState;
  readonly detail: string;
  readonly consoleLinks: readonly PublicProviderConsoleLink[];
}

export interface PublicProviderConsoleLink {
  readonly label: string;
  readonly url: string;
}

interface PublicWorkerHealth {
  readonly ok: boolean;
  readonly status: WorkerHealth["status"];
  readonly processedJobs: number;
  readonly lastRunAt?: string;
  readonly lastJobId?: string;
  readonly lastFinalStatus?: WorkerHealth["lastFinalStatus"];
  readonly lastErrorCode?: "worker_error";
}

function publicWorkerHealth(worker: WorkerHealth): PublicWorkerHealth {
  return {
    ok: worker.ok,
    status: worker.status,
    processedJobs: worker.processedJobs,
    ...(worker.lastRunAt ? { lastRunAt: worker.lastRunAt } : {}),
    ...(worker.lastJobId ? { lastJobId: worker.lastJobId } : {}),
    ...(worker.lastFinalStatus ? { lastFinalStatus: worker.lastFinalStatus } : {}),
    ...(worker.lastError ? { lastErrorCode: "worker_error" as const } : {})
  };
}

function publicProviderStatuses(
  providers: ProviderEnablement,
  models: ProviderModelConfig,
  providerKillSwitch: boolean,
  worker?: WorkerHealth
): readonly PublicProviderStatus[] {
  const disabledDetail = providerKillSwitch ? "Paused by provider kill switch." : "Disabled in backend configuration.";
  const runtimeSignal = providerRuntimeSignal(worker?.lastError);

  return [
    providerStatus({
      id: "railway-backend",
      step: "Backend hosting",
      provider: "Railway",
      enabled: true,
      providerKillSwitch: false,
      onlineDetail: providerKillSwitch
        ? "Backend is reachable, but paid provider calls are paused."
        : "Backend is reachable and ready to coordinate generation jobs.",
      disabledDetail: "Backend hosting is unavailable.",
      consoleLinks: [
        { label: "Dashboard", url: "https://railway.com/dashboard" },
        { label: "Billing", url: "https://railway.com/account/billing" }
      ],
      forcedState: providerKillSwitch ? "warning" : undefined
    }),
    providerStatus({
      id: "cloudflare-r2-storage",
      step: "Object storage",
      provider: "Cloudflare R2",
      enabled: true,
      providerKillSwitch: false,
      onlineDetail: "R2 storage is configured for generated audio, artwork, transcripts, and sources.",
      disabledDetail: "Object storage is unavailable.",
      warningDetail: runtimeSignal.storage,
      consoleLinks: [
        { label: "R2", url: "https://dash.cloudflare.com/?to=/:account/r2" },
        { label: "API Tokens", url: "https://dash.cloudflare.com/profile/api-tokens" },
        { label: "Billing", url: "https://dash.cloudflare.com/?to=/:account/billing" }
      ]
    }),
    providerStatus({
      id: "gemini-research",
      step: "Research dossier",
      provider: "Google Gemini",
      model: models.geminiResearch,
      enabled: providers.geminiResearch,
      providerKillSwitch,
      onlineDetail: "Ready to build grounded historical dossiers.",
      disabledDetail,
      warningDetail: runtimeSignal.geminiResearch,
      consoleLinks: [
        { label: "API Keys", url: "https://aistudio.google.com/app/apikey" },
        { label: "Billing", url: "https://console.cloud.google.com/billing" },
        { label: "AI Studio", url: "https://aistudio.google.com/" }
      ]
    }),
    providerStatus({
      id: "opus-writing",
      step: "Story writing",
      provider: "Anthropic Claude",
      model: models.anthropicWriting,
      enabled: providers.anthropicWriting,
      providerKillSwitch,
      onlineDetail: "Ready to write and review the chaptered script.",
      disabledDetail,
      warningDetail: runtimeSignal.anthropicWriting,
      consoleLinks: [
        { label: "API Keys", url: "https://console.anthropic.com/settings/keys" },
        { label: "Billing", url: "https://console.anthropic.com/settings/billing" },
        { label: "Usage", url: "https://console.anthropic.com/usage" }
      ]
    }),
    providerStatus({
      id: "elevenlabs-narration",
      step: "Narration",
      provider: "ElevenLabs",
      model: `${models.elevenLabsTts} · ${models.elevenLabsOutputFormat}`,
      enabled: providers.elevenLabsTts,
      providerKillSwitch,
      onlineDetail: "Ready to narrate approved story voices.",
      disabledDetail,
      warningDetail: runtimeSignal.elevenLabsTts,
      consoleLinks: [
        { label: "API Keys", url: "https://elevenlabs.io/app/settings/api-keys" },
        { label: "Credits", url: "https://elevenlabs.io/app/subscription" },
        { label: "Usage", url: "https://elevenlabs.io/app/usage" }
      ]
    }),
    providerStatus({
      id: "openai-cover-art",
      step: "Cover art",
      provider: "OpenAI Images",
      model: models.openAiImages,
      enabled: providers.openAiImages,
      providerKillSwitch,
      onlineDetail: "Ready to create story-specific cover art.",
      disabledDetail,
      warningDetail: runtimeSignal.openAiImages,
      consoleLinks: [
        { label: "API Keys", url: "https://platform.openai.com/api-keys" },
        { label: "Billing", url: "https://platform.openai.com/settings/organization/billing/overview" },
        { label: "Usage", url: "https://platform.openai.com/usage" }
      ]
    })
  ];
}

function providerStatus(input: {
  readonly id: string;
  readonly step: string;
  readonly provider: string;
  readonly model?: string;
  readonly enabled: boolean;
  readonly providerKillSwitch: boolean;
  readonly onlineDetail: string;
  readonly disabledDetail: string;
  readonly warningDetail?: ProviderWarningDetail;
  readonly consoleLinks: readonly PublicProviderConsoleLink[];
  readonly forcedState?: PublicProviderState;
}): PublicProviderStatus {
  if (input.providerKillSwitch || !input.enabled) {
    return {
      id: input.id,
      step: input.step,
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      state: input.forcedState ?? "offline",
      detail: input.disabledDetail,
      consoleLinks: input.consoleLinks
    };
  }

  if (input.warningDetail) {
    return {
      id: input.id,
      step: input.step,
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      state: input.warningDetail.state,
      detail: input.warningDetail.detail,
      consoleLinks: input.consoleLinks
    };
  }

  return {
    id: input.id,
    step: input.step,
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),
    state: input.forcedState ?? "online",
    detail: input.onlineDetail,
    consoleLinks: input.consoleLinks
  };
}

type ProviderSignalKey = "storage" | keyof ProviderEnablement;

type ProviderRuntimeSignal = Partial<Record<ProviderSignalKey, ProviderWarningDetail>>;

interface ProviderWarningDetail {
  readonly state: Extract<PublicProviderState, "credits_depleted" | "warning">;
  readonly detail: string;
}

function providerRuntimeSignal(lastError: string | undefined): ProviderRuntimeSignal {
  if (!lastError) {
    return {};
  }

  const normalized = lastError.toLowerCase();
  const state = isQuotaOrBillingError(normalized) ? "credits_depleted" : "warning";
  const signal = (detail: string): ProviderWarningDetail => ({ state, detail });

  const runtimeSignal: ProviderRuntimeSignal = {};
  if (matchesAny(normalized, ["storage", "cloudflare", "r2", "s3", "bucket", "object", "asset"])) {
    runtimeSignal.storage = signal(
      state === "credits_depleted"
        ? "Storage reported a recent quota or billing issue."
        : "Storage reported a recent issue during generation."
    );
  }
  if (matchesAny(normalized, ["gemini", "google", "research", "dossier", "grounding", "generatecontent"])) {
    runtimeSignal.geminiResearch = signal(
      state === "credits_depleted"
        ? "Research reported a recent quota or billing issue."
        : "Research reported a recent provider issue."
    );
  }
  if (matchesAny(normalized, ["anthropic", "claude", "opus", "writing", "writer", "script", "messages api"])) {
    runtimeSignal.anthropicWriting = signal(
      state === "credits_depleted"
        ? "Writing reported a recent quota or billing issue."
        : "Writing reported a recent provider issue."
    );
  }
  if (matchesAny(normalized, ["elevenlabs", "narration", "tts", "voice", "credits"])) {
    runtimeSignal.elevenLabsTts = signal(
      state === "credits_depleted"
        ? "Credits are depleted or the latest narration attempt exceeded available credits."
        : "Narration reported a recent provider issue."
    );
  }
  if (matchesAny(normalized, ["openai", "gpt-image", "image", "cover art", "cover"])) {
    runtimeSignal.openAiImages = signal(
      state === "credits_depleted"
        ? "Cover art reported a recent quota or billing issue."
        : "Cover art reported a recent provider issue."
    );
  }

  return runtimeSignal;
}

function isQuotaOrBillingError(normalizedError: string): boolean {
  return matchesAny(normalizedError, [
    "quota",
    "credit",
    "billing",
    "payment",
    "insufficient_quota",
    "resource_exhausted"
  ]);
}

function matchesAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
