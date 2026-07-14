import type { BudgetConfig, ProviderEnablement } from "./config.js";
import type { GenerationRequest } from "./schemas.js";

export const paidProviderStages = ["research", "writing", "tts", "images"] as const;
export type PaidProviderStage = typeof paidProviderStages[number];

export interface BudgetUsage {
  readonly dailyCostUsd?: number;
  readonly jobCostUsd?: number;
  readonly retryCostUsd?: number;
  readonly paidRetries?: number;
  readonly stageAttempts?: Partial<Record<PaidProviderStage, number>>;
}

export interface CostEstimate {
  readonly researchUsd: number;
  readonly writingUsd: number;
  readonly ttsUsd: number;
  readonly imageUsd: number;
  readonly totalUsd: number;
  readonly retryExposureUsd: number;
}

export type GuardrailDecision =
  | {
      readonly ok: true;
      readonly estimate: CostEstimate;
    }
  | {
      readonly ok: false;
      readonly statusCode: number;
      readonly code:
        | "duration_limit_exceeded"
        | "provider_disabled"
        | "job_budget_exceeded"
        | "daily_budget_exceeded"
        | "retry_budget_exceeded"
        | "retry_limit_exceeded"
        | "provider_attempt_limit_exceeded";
      readonly message: string;
      readonly details?: Record<string, string | number | boolean | null>;
    };

export function evaluateGenerationGuardrails(input: {
  readonly request: GenerationRequest;
  readonly budget: BudgetConfig;
  readonly providers: ProviderEnablement;
  readonly providerKillSwitch: boolean;
  readonly usage?: BudgetUsage;
}): GuardrailDecision {
  const { request, budget, providers, providerKillSwitch } = input;
  const usage = input.usage ?? {};
  const estimate = estimateGenerationCost(request, budget);

  if (request.targetDurationMinutes > budget.maxStoryMinutes) {
    return reject(422, "duration_limit_exceeded", "Requested story duration exceeds the configured maximum.", {
      requestedMinutes: request.targetDurationMinutes,
      maxStoryMinutes: budget.maxStoryMinutes
    });
  }

  const disabledProvider = firstDisabledProvider(providers, providerKillSwitch);
  if (disabledProvider) {
    return reject(503, "provider_disabled", "A required provider is disabled.", {
      provider: disabledProvider
    });
  }

  if ((usage.jobCostUsd ?? 0) + estimate.totalUsd > budget.maxJobCostUsd) {
    return reject(429, "job_budget_exceeded", "Estimated job cost exceeds the configured job cap.", {
      estimatedCostUsd: estimate.totalUsd,
      currentJobCostUsd: usage.jobCostUsd ?? 0,
      maxJobCostUsd: budget.maxJobCostUsd
    });
  }

  if ((usage.dailyCostUsd ?? 0) + estimate.totalUsd > budget.maxDailyCostUsd) {
    return reject(429, "daily_budget_exceeded", "Estimated job cost exceeds the configured daily cap.", {
      estimatedCostUsd: estimate.totalUsd,
      currentDailyCostUsd: usage.dailyCostUsd ?? 0,
      maxDailyCostUsd: budget.maxDailyCostUsd
    });
  }

  if ((usage.retryCostUsd ?? 0) + estimate.retryExposureUsd > budget.maxRetryCostUsd) {
    return reject(429, "retry_budget_exceeded", "Estimated retry exposure exceeds the configured retry cap.", {
      retryExposureUsd: estimate.retryExposureUsd,
      currentRetryCostUsd: usage.retryCostUsd ?? 0,
      maxRetryCostUsd: budget.maxRetryCostUsd
    });
  }

  if ((usage.paidRetries ?? 0) >= budget.maxPaidRetriesPerJob) {
    return reject(429, "retry_limit_exceeded", "Paid retry ceiling has been reached.", {
      paidRetries: usage.paidRetries ?? 0,
      maxPaidRetriesPerJob: budget.maxPaidRetriesPerJob
    });
  }

  const overAttemptStage = paidProviderStages.find((stage) =>
    (usage.stageAttempts?.[stage] ?? 0) >= budget.maxPaidProviderAttemptsPerStage
  );
  if (overAttemptStage) {
    return reject(429, "provider_attempt_limit_exceeded", "Paid provider attempt ceiling has been reached.", {
      stage: overAttemptStage,
      attempts: usage.stageAttempts?.[overAttemptStage] ?? 0,
      maxPaidProviderAttemptsPerStage: budget.maxPaidProviderAttemptsPerStage
    });
  }

  return {
    ok: true,
    estimate
  };
}

export function estimateGenerationCost(request: GenerationRequest, budget: BudgetConfig): CostEstimate {
  const durationScale = request.targetDurationMinutes / budget.maxStoryMinutes;
  const researchUsd = roundUsd(0.48 * durationScale);
  const writingUsd = roundUsd(1.5 * durationScale);
  const ttsUsd = roundUsd(7.8 * durationScale);
  const imageUsd = 0.5;
  const totalUsd = roundUsd(researchUsd + writingUsd + ttsUsd + imageUsd);

  return {
    researchUsd,
    writingUsd,
    ttsUsd,
    imageUsd,
    totalUsd,
    retryExposureUsd: roundUsd(totalUsd * (1 + budget.maxPaidRetriesPerJob))
  };
}

function firstDisabledProvider(providers: ProviderEnablement, providerKillSwitch: boolean): string | undefined {
  if (providerKillSwitch) {
    return "all";
  }
  if (!providers.geminiResearch) {
    return "geminiResearch";
  }
  if (!providers.anthropicWriting) {
    return "anthropicWriting";
  }
  if (!providers.elevenLabsTts) {
    return "elevenLabsTts";
  }
  if (!providers.openAiImages) {
    return "openAiImages";
  }

  return undefined;
}

function reject(
  statusCode: Exclude<GuardrailDecision, { ok: true }>["statusCode"],
  code: Exclude<GuardrailDecision, { ok: true }>["code"],
  message: string,
  details?: Record<string, string | number | boolean | null>
): GuardrailDecision {
  return {
    ok: false,
    statusCode,
    code,
    message,
    details
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
