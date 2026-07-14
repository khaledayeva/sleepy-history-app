import type { AmbienceKind, GenerationRequest, StoryKind } from "./schemas.js";
import { parseGenerationRequest } from "./schemas.js";

export interface GenerationRequestInput {
  readonly kind: StoryKind;
  readonly subject: string;
  readonly era?: string;
  readonly location?: string;
  readonly perspective?: string;
  readonly targetDurationMinutes?: number;
  readonly voiceId?: string;
  readonly ambience?: AmbienceKind;
  readonly allowHistoricalViolenceContext?: boolean;
}

export interface GenerationPreset {
  readonly id: string;
  readonly label: string;
  readonly kind: StoryKind;
  readonly defaultDurationMinutes: number;
  readonly defaultAmbience: AmbienceKind;
  readonly safety: GenerationRequest["safety"];
}

export const generationPresets: readonly GenerationPreset[] = [
  {
    id: "historical_figure_calm_profile",
    label: "Historical figure",
    kind: "historical_figure",
    defaultDurationMinutes: 60,
    defaultAmbience: "rain",
    safety: {
      bedtimeTone: "very_gentle",
      allowHistoricalViolenceContext: false
    }
  },
  {
    id: "ordinary_daily_life",
    label: "Ordinary daily life",
    kind: "daily_life",
    defaultDurationMinutes: 60,
    defaultAmbience: "none",
    safety: {
      bedtimeTone: "very_gentle",
      allowHistoricalViolenceContext: false
    }
  }
];

export function createGenerationRequest(input: GenerationRequestInput): GenerationRequest {
  const preset = presetForKind(input.kind);
  const request: GenerationRequest = {
    schemaVersion: "2026-05-10",
    kind: input.kind,
    subject: input.subject,
    era: input.era,
    location: input.location,
    perspective: input.perspective,
    targetDurationMinutes: input.targetDurationMinutes ?? preset.defaultDurationMinutes,
    voiceId: input.voiceId,
    ambience: input.ambience ?? preset.defaultAmbience,
    safety: {
      ...preset.safety,
      allowHistoricalViolenceContext: input.allowHistoricalViolenceContext ?? preset.safety.allowHistoricalViolenceContext
    }
  };

  return parseGenerationRequest(request);
}

export function presetForKind(kind: StoryKind): GenerationPreset {
  const preset = generationPresets.find((candidate) => candidate.kind === kind);
  if (!preset) {
    throw new Error(`No generation preset configured for kind: ${kind}`);
  }

  return preset;
}
