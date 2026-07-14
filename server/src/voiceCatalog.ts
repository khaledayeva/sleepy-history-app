import type { VoiceOption, VoiceSettings } from "./providers.js";

export type VoicePermissionStatus = "approved" | "blocked" | "unknown";

export interface ApprovedVoice extends VoiceOption {
  readonly provider: "elevenlabs";
  readonly category: "narration";
  readonly permissionStatus: VoicePermissionStatus;
  readonly allowedModelIds: readonly string[];
  readonly previewUrl?: string;
  readonly approvedAt: string;
}

export const approvedVoices: readonly ApprovedVoice[] = [
  {
    id: "calm_narrator_01",
    name: "Calm Narrator",
    provider: "elevenlabs",
    category: "narration",
    source: "provider_library",
    permissionStatus: "approved",
    rightsNote: "Approved provider-library voice for Sleepy History MVP narration. Not a cloned or public-figure imitation voice.",
    allowedModelIds: ["eleven_multilingual_v2"],
    previewUrl: "https://example.invalid/sleepy-history/voices/calm_narrator_01",
    approvedAt: "2026-05-09T00:00:00.000Z",
    defaultSettings: {
      speed: 0.92,
      stability: 0.7,
      similarity: 0.78,
      modelId: "eleven_multilingual_v2"
    }
  }
];

export function listApprovedVoices(): readonly ApprovedVoice[] {
  return approvedVoices.filter((voice) => voice.permissionStatus === "approved");
}

export function getApprovedVoice(voiceId: string): ApprovedVoice | undefined {
  return listApprovedVoices().find((voice) => voice.id === voiceId);
}

export function validateVoiceId(voiceId: string): ApprovedVoice {
  const voice = getApprovedVoice(voiceId);
  if (!voice) {
    throw new Error(`Voice is not approved: ${voiceId}`);
  }

  return voice;
}

export function resolveVoiceSettings(
  voiceId: string,
  overrides: Partial<VoiceSettings> = {}
): VoiceSettings {
  const voice = validateVoiceId(voiceId);
  const settings = {
    speed: resolveNumericSetting("speed", voice.defaultSettings.speed, overrides.speed),
    stability: resolveNumericSetting("stability", voice.defaultSettings.stability, overrides.stability),
    similarity: resolveNumericSetting("similarity", voice.defaultSettings.similarity, overrides.similarity),
    modelId: overrides.modelId ?? voice.defaultSettings.modelId
  };

  if (!voice.allowedModelIds.includes(settings.modelId)) {
    throw new Error(`Voice ${voiceId} is not approved for model ${settings.modelId}`);
  }

  if (settings.speed <= 0 || settings.speed > 1.25) {
    throw new Error("Voice speed must be greater than 0 and at most 1.25");
  }
  if (settings.stability < 0 || settings.stability > 1) {
    throw new Error("Voice stability must be between 0 and 1");
  }
  if (settings.similarity < 0 || settings.similarity > 1) {
    throw new Error("Voice similarity must be between 0 and 1");
  }

  return settings;
}

function resolveNumericSetting(
  name: keyof Pick<VoiceSettings, "speed" | "stability" | "similarity">,
  defaultValue: number,
  overrideValue: number | undefined
): number {
  const value = overrideValue ?? defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Voice ${name} must be a finite number`);
  }

  return value;
}
