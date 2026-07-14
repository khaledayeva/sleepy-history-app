import { ProviderQuotaExceededError } from "./providers.js";
import type { NarrationAsset, NarrationInput, ProviderContext, VoiceOption, VoiceProvider } from "./providers.js";
import { listApprovedVoices, resolveVoiceSettings, validateVoiceId } from "./voiceCatalog.js";

export const defaultElevenLabsOutputFormat = "pcm_24000";

export interface ElevenLabsVoiceProviderConfig {
  readonly apiKey?: string;
  readonly voiceIdMap?: Record<string, string>;
  readonly modelId?: string;
  readonly outputFormat?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
}

type FetchLike = (url: string, init: {
  readonly method: "POST";
  readonly headers: Record<string, string>;
  readonly body: string;
}) => Promise<FetchResponseLike>;

interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: {
    get(name: string): string | null;
  };
  arrayBuffer(): Promise<ArrayBuffer>;
  text?(): Promise<string>;
}

export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly name = "elevenlabs-voice";
  private readonly apiKey: string;
  private readonly voiceIdMap: Record<string, string>;
  private readonly modelId: string;
  private readonly outputFormat: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: ElevenLabsVoiceProviderConfig = {}) {
    const apiKey = config.apiKey ?? process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY is required for ElevenLabs narration");
    }

    const defaultVoiceId = process.env.ELEVENLABS_VOICE_ID;
    this.voiceIdMap = {
      ...(defaultVoiceId ? { calm_narrator_01: defaultVoiceId } : {}),
      ...(config.voiceIdMap ?? {})
    };
    this.apiKey = apiKey;
    this.modelId = config.modelId ?? process.env.ELEVENLABS_TTS_MODEL ?? "eleven_multilingual_v2";
    this.outputFormat = config.outputFormat ?? process.env.ELEVENLABS_OUTPUT_FORMAT ?? defaultElevenLabsOutputFormat;
    this.baseUrl = config.baseUrl ?? "https://api.elevenlabs.io";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async listVoices(_context: ProviderContext): Promise<readonly VoiceOption[]> {
    return listApprovedVoices();
  }

  async narrateChapter(input: NarrationInput, context: ProviderContext): Promise<NarrationAsset> {
    const approvedVoice = validateVoiceId(input.voiceId);
    const providerVoiceId = this.voiceIdMap[input.voiceId];
    if (!providerVoiceId) {
      throw new Error(`No ElevenLabs provider voice ID configured for approved voice: ${input.voiceId}`);
    }

    const settings = resolveVoiceSettings(input.voiceId, {
      ...input.settings,
      modelId: input.settings?.modelId ?? this.modelId
    });
    const url = new URL(`/v1/text-to-speech/${encodeURIComponent(providerVoiceId)}`, this.baseUrl);
    url.searchParams.set("output_format", this.outputFormat);
    const response = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": this.apiKey,
        "X-Sleepy-History-Job": context.jobId,
        ...(context.idempotencyKey ? { "Idempotency-Key": context.idempotencyKey } : {})
      },
      body: JSON.stringify({
        text: input.chapter.text,
        model_id: settings.modelId,
        voice_settings: {
          stability: settings.stability,
          similarity_boost: settings.similarity,
          speed: settings.speed,
          use_speaker_boost: true
        }
      })
    });

    if (!response.ok) {
      throw await createElevenLabsError(response);
    }

    const audioBytes = new Uint8Array(await response.arrayBuffer());
    const wavBytes = normalizeElevenLabsAudio(audioBytes, this.outputFormat);

    return {
      id: `asset_${input.storyId}_${input.chapter.id}_elevenlabs_audio`,
      kind: "audio",
      mimeType: "audio/wav",
      uri: `elevenlabs://voices/${approvedVoice.id}/${input.storyId}/${input.chapter.id}.wav`,
      sizeBytes: wavBytes.byteLength,
      durationSeconds: estimateWavDurationSeconds(wavBytes),
      bytes: wavBytes
    };
  }
}

export function hasElevenLabsSmokeConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID);
}

export function normalizeElevenLabsAudio(bytes: Uint8Array, outputFormat: string): Uint8Array {
  if (startsWithAscii(bytes, "RIFF")) {
    return bytes;
  }

  const pcmSampleRate = parsePcmSampleRate(outputFormat);
  if (pcmSampleRate) {
    return wrapPcm16LeInWav(bytes, pcmSampleRate);
  }

  throw new Error(`Unsupported ElevenLabs output format for assembly: ${outputFormat}. Use PCM, such as ${defaultElevenLabsOutputFormat}, or a WAV output.`);
}

function parsePcmSampleRate(outputFormat: string): number | undefined {
  const match = outputFormat.match(/^pcm_(\d+)$/);
  if (!match) {
    return undefined;
  }

  const sampleRate = Number(match[1]);
  return Number.isInteger(sampleRate) && sampleRate > 0 ? sampleRate : undefined;
}

function wrapPcm16LeInWav(pcmBytes: Uint8Array, sampleRate: number): Uint8Array {
  const channelCount = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channelCount * (bitsPerSample / 8);
  const blockAlign = channelCount * (bitsPerSample / 8);
  const data = new Uint8Array(44 + pcmBytes.byteLength);
  const view = new DataView(data.buffer);

  writeAscii(data, 0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  writeAscii(data, 8, "WAVE");
  writeAscii(data, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(data, 36, "data");
  view.setUint32(40, pcmBytes.byteLength, true);
  data.set(pcmBytes, 44);
  return data;
}

function estimateWavDurationSeconds(bytes: Uint8Array): number | undefined {
  if (!startsWithAscii(bytes, "RIFF") || bytes.byteLength < 44) {
    return undefined;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(24, true);
  const byteRate = view.getUint32(28, true);
  const dataByteCount = view.getUint32(40, true);
  if (sampleRate <= 0 || byteRate <= 0 || dataByteCount <= 0) {
    return undefined;
  }

  return dataByteCount / byteRate;
}

function writeAscii(data: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    data[offset + index] = value.charCodeAt(index);
  }
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  if (bytes.byteLength < value.length) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (bytes[index] !== value.charCodeAt(index)) {
      return false;
    }
  }

  return true;
}

async function createElevenLabsError(response: FetchResponseLike): Promise<Error> {
  const text = await readErrorText(response);
  const quota = parseElevenLabsQuotaError(response.status, text);
  if (quota) {
    const remaining = quota.creditsRemaining === undefined ? "" : ` ${quota.creditsRemaining} credits remain.`;
    const required = quota.creditsRequired === undefined ? "" : ` The next narration chunk needs ${quota.creditsRequired} credits.`;
    return new ProviderQuotaExceededError(
      `ElevenLabs quota exceeded.${remaining}${required} Add credits in ElevenLabs, then retry this story.`,
      quota
    );
  }

  return new Error(`ElevenLabs narration request failed: ${response.status}${sanitizeProviderErrorText(text)}`);
}

function parseElevenLabsQuotaError(status: number, text: string): ProviderQuotaExceededError["details"] | undefined {
  const parsed = parseJsonObject(text);
  const detail = isRecord(parsed.detail) ? parsed.detail : undefined;
  const code = readString(detail?.code ?? parsed.code);
  const statusText = readString(detail?.status ?? parsed.status);
  if (code !== "quota_exceeded" && statusText !== "quota_exceeded") {
    return undefined;
  }

  const message = readString(detail?.message ?? parsed.message);
  return {
    provider: "elevenlabs",
    status,
    creditsRemaining: extractNumber(message, /(\d+)\s+credits\s+remaining/i),
    creditsRequired: extractNumber(message, /(\d+)\s+credits\s+are\s+required/i),
    requestId: readString(detail?.request_id ?? parsed.request_id)
  };
}

function sanitizeProviderErrorText(text: string): string {
  if (text.trim().length === 0) {
    return "";
  }

  const parsed = parseJsonObject(text);
  const detail = isRecord(parsed.detail) ? parsed.detail : undefined;
  const message = readString(detail?.message ?? parsed.message);
  if (message) {
    return `: ${message}`;
  }

  return ": provider returned an error";
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (text.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function readString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0 ? input : undefined;
}

function extractNumber(input: string | undefined, pattern: RegExp): number | undefined {
  const match = input?.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

async function readErrorText(response: FetchResponseLike): Promise<string> {
  if (!response.text) {
    return "";
  }

  const text = await response.text();
  return text.trim();
}
