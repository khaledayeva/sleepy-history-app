import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectWav } from "../src/audioAssembly.js";
import { ElevenLabsVoiceProvider, hasElevenLabsSmokeConfig, normalizeElevenLabsAudio } from "../src/elevenLabsVoiceProvider.js";
import { ProviderQuotaExceededError } from "../src/providers.js";

describe("ElevenLabs voice provider", () => {
  it("uses the higher-fidelity default PCM format and wraps it as playable WAV audio", async () => {
    const requests: { readonly url: string; readonly body: Record<string, unknown>; readonly headers: Record<string, string> }[] = [];
    const provider = new ElevenLabsVoiceProvider({
      apiKey: "test-elevenlabs-key",
      voiceIdMap: {
        calm_narrator_01: "voice_provider_123"
      },
      fetchImpl: async (url, init) => {
        requests.push({
          url,
          body: JSON.parse(init.body) as Record<string, unknown>,
          headers: init.headers
        });

        return audioResponse(oneSecondPcm16Le(24_000));
      }
    });

    const asset = await provider.narrateChapter({
      storyId: "story_smoke",
      voiceId: "calm_narrator_01",
      chapter: {
        id: "chapter_01",
        index: 1,
        title: "A Quiet Shelf",
        checkpoint: "The day winds down.",
        summary: "A gentle chapter.",
        continuitySummary: "Stay quiet.",
        estimatedWords: 80,
        text: "A scribe rests a reed pen beside the soft lamp and listens as the library settles into evening.",
        sourceIds: ["source_1"]
      }
    }, {
      jobId: "job_smoke",
      idempotencyKey: "sleepy-history:job_smoke:voicing"
    });

    assert.equal(requests.length, 1);
    assert.match(requests[0]?.url ?? "", /\/v1\/text-to-speech\/voice_provider_123\?output_format=pcm_24000$/);
    assert.equal(requests[0]?.headers["xi-api-key"], "test-elevenlabs-key");
    assert.equal(requests[0]?.headers["Idempotency-Key"], "sleepy-history:job_smoke:voicing");
    assert.equal(requests[0]?.body.model_id, "eleven_multilingual_v2");
    assert.deepEqual(requests[0]?.body.voice_settings, {
      stability: 0.7,
      similarity_boost: 0.78,
      speed: 0.92,
      use_speaker_boost: true
    });
    assert.equal(asset.mimeType, "audio/wav");
    assert.ok(asset.bytes);
    const inspection = inspectWav(asset.bytes);
    assert.equal(inspection.durationSeconds, 1);
    assert.equal(inspection.sampleRate, 24_000);
  });

  it("reports whether narration smoke config has a provider key and mapped voice", () => {
    assert.equal(hasElevenLabsSmokeConfig({ ELEVENLABS_API_KEY: "key", ELEVENLABS_VOICE_ID: "voice" }), true);
    assert.equal(hasElevenLabsSmokeConfig({ ELEVENLABS_API_KEY: "key" }), false);
  });

  it("maps ElevenLabs quota responses to a sanitized provider quota error", async () => {
    const provider = new ElevenLabsVoiceProvider({
      apiKey: "test-elevenlabs-key",
      voiceIdMap: {
        calm_narrator_01: "voice_provider_123"
      },
      fetchImpl: async () => errorResponse(401, {
        detail: {
          type: "invalid_request",
          code: "quota_exceeded",
          message: "This request exceeds your quota of 23736. You have 979 credits remaining, while 984 credits are required for this request.",
          status: "quota_exceeded",
          request_id: "9561e658491a1e800f8f095d6e609819"
        }
      })
    });

    await assert.rejects(
      provider.narrateChapter({
        storyId: "story_quota",
        voiceId: "calm_narrator_01",
        chapter: {
          id: "chapter_01",
          index: 1,
          title: "A Quiet Shelf",
          checkpoint: "The day winds down.",
          summary: "A gentle chapter.",
          continuitySummary: "Stay quiet.",
          estimatedWords: 80,
          text: "A scribe rests a reed pen beside the soft lamp.",
          sourceIds: ["source_1"]
        }
      }, {
        jobId: "job_quota",
        idempotencyKey: "sleepy-history:job_quota:voicing"
      }),
      (error) => {
        assert.ok(error instanceof ProviderQuotaExceededError);
        assert.match(error.message, /ElevenLabs quota exceeded/);
        assert.match(error.message, /979 credits remain/);
        assert.match(error.message, /984 credits/);
        assert.doesNotMatch(error.message, /request_id|9561e658|invalid_request/);
        assert.equal(error.details.provider, "elevenlabs");
        assert.equal(error.details.creditsRemaining, 979);
        assert.equal(error.details.creditsRequired, 984);
        return true;
      }
    );
  });

  it("rejects unsupported compressed output formats before assembly", () => {
    assert.throws(() => normalizeElevenLabsAudio(new Uint8Array([1, 2, 3]), "mp3_44100_128"), /Unsupported ElevenLabs output format/);
  });
});

function audioResponse(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: () => null
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      return toArrayBuffer(bytes);
    }
  };
}

function errorResponse(status: number, body: unknown) {
  return {
    ok: false,
    status,
    headers: {
      get: () => null
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },
    async text(): Promise<string> {
      return JSON.stringify(body);
    }
  };
}

function oneSecondPcm16Le(sampleRate = 16_000): Uint8Array {
  return new Uint8Array(sampleRate * 2);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return arrayBuffer;
}
