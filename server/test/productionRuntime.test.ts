import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { evaluateGenerationGuardrails } from "../src/budget.js";
import { loadConfig } from "../src/config.js";
import { createGenerationRequest } from "../src/generationRequests.js";
import { createHostedRuntime } from "../src/productionRuntime.js";
import {
  MockImageProvider,
  MockResearchProvider,
  MockStorageProvider,
  MockVoiceProvider,
  MockWriterProvider,
  ProviderQuotaExceededError
} from "../src/providers.js";

describe("hosted production runtime", () => {
  it("queues API-created jobs and processes them with the hosted worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sleepy-history-hosted-runtime-"));
    const config = loadConfig({
      NODE_ENV: "production",
      PORT: "8787",
      DEVICE_TOKEN_HMAC_SECRET: "test-device-token-hmac-secret-32-bytes",
      ENABLE_GEMINI_RESEARCH: "true",
      ENABLE_ANTHROPIC_WRITING: "true",
      ENABLE_ELEVENLABS_TTS: "true",
      ENABLE_OPENAI_IMAGES: "true"
    });
    const storage = new MockStorageProvider({
      signingSecret: "test-storage-signing-secret-32-bytes-minimum"
    });
    const hosted = createHostedRuntime(config, {
      env: {
        DATA_DIR: directory,
        STORAGE_SIGNING_SECRET: "test-storage-signing-secret-32-bytes-minimum"
      },
      providers: {
        research: new MockResearchProvider(),
        writer: new MockWriterProvider(),
        voice: new MockVoiceProvider(),
        image: new MockImageProvider(),
        storage
      }
    });
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a quiet scribe in Alexandria",
      targetDurationMinutes: 5,
      voiceId: "calm_narrator_01"
    });
    const guardrails = evaluateGenerationGuardrails({
      request,
      budget: config.budget,
      providers: config.providers,
      providerKillSwitch: config.providerKillSwitch
    });
    assert.equal(guardrails.ok, true);
    if (!guardrails.ok) {
      throw new Error("guardrails must pass");
    }

    const job = await hosted.runtime.createGenerationJob?.(request, guardrails.estimate);
    assert.equal(job?.status, "queued");

    const health = await hosted.worker.runOnce();
    const completed = await hosted.runtime.getGenerationJob?.(job?.id ?? "");
    const markerKey = `stories/${completed?.storyId}/chapter-markers.json`;
    const markerObject = await storage.getObject(markerKey, {
      jobId: completed?.id ?? "job_unknown",
      idempotencyKey: "test:fractional-markers"
    });
    const markerPayload = JSON.parse(new TextDecoder().decode(markerObject.bytes)) as {
      durationSeconds: number;
      markers: { durationSeconds: number }[];
    };
    await storage.putObject({
      ...markerObject,
      bytes: new TextEncoder().encode(JSON.stringify({
        ...markerPayload,
        durationSeconds: markerPayload.durationSeconds + 0.096,
        markers: markerPayload.markers.map((marker) => ({
          ...marker,
          durationSeconds: marker.durationSeconds + 0.42
        }))
      }))
    }, {
      jobId: completed?.id ?? "job_unknown",
      idempotencyKey: "test:fractional-markers"
    });
    const story = await hosted.runtime.getStory?.(completed?.storyId ?? "");

    assert.equal(health.ok, true);
    assert.equal(health.processedJobs, 1);
    assert.equal(health.lastFinalStatus, "completed");
    assert.equal(completed?.status, "completed");
    assert.ok(completed?.metadata?.assetAccess);
    assert.equal(story?.id, completed?.storyId);
    assert.equal(story?.title, "A Quiet Hour With a quiet scribe in Alexandria");
    assert.equal(story?.chapters.length, 8);
    assert.equal(story?.assets.some((asset) => asset.kind === "audio" && asset.uri.includes("/objects/")), true);
    assert.equal(story?.sources[0]?.title, "a quiet scribe in Alexandria mock source");
    assert.equal(Number.isInteger(story?.estimatedDurationSeconds), true);
    assert.equal(Number.isInteger(story?.chapters[0]?.estimatedDurationSeconds), true);
    assert.equal(Number.isInteger(story?.assets.find((asset) => asset.kind === "audio")?.durationSeconds), true);
  });

  it("keeps a safe failed-job provider error in hosted worker health", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sleepy-history-hosted-runtime-failure-"));
    const config = loadConfig({
      NODE_ENV: "production",
      PORT: "8787",
      DEVICE_TOKEN_HMAC_SECRET: "test-device-token-hmac-secret-32-bytes",
      ENABLE_GEMINI_RESEARCH: "true",
      ENABLE_ANTHROPIC_WRITING: "true",
      ENABLE_ELEVENLABS_TTS: "true",
      ENABLE_OPENAI_IMAGES: "true"
    });
    const hosted = createHostedRuntime(config, {
      env: {
        DATA_DIR: directory,
        STORAGE_SIGNING_SECRET: "test-storage-signing-secret-32-bytes-minimum"
      },
      providers: {
        research: new MockResearchProvider(),
        writer: new AnthropicQuotaWriterProvider(),
        voice: new MockVoiceProvider(),
        image: new MockImageProvider(),
        storage: new MockStorageProvider({
          signingSecret: "test-storage-signing-secret-32-bytes-minimum"
        })
      }
    });
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a quiet scribe in Alexandria",
      targetDurationMinutes: 5,
      voiceId: "calm_narrator_01"
    });
    const guardrails = evaluateGenerationGuardrails({
      request,
      budget: config.budget,
      providers: config.providers,
      providerKillSwitch: config.providerKillSwitch
    });
    if (!guardrails.ok) {
      throw new Error("guardrails must pass");
    }

    const job = await hosted.runtime.createGenerationJob?.(request, guardrails.estimate);
    const health = await hosted.worker.runOnce();
    const failedJob = await hosted.runtime.getGenerationJob?.(job?.id ?? "");

    assert.equal(health.ok, true);
    assert.equal(health.lastFinalStatus, "failed");
    assert.match(health.lastError ?? "", /Anthropic Claude credits are depleted/);
    assert.equal(failedJob?.error?.code, "provider_quota_exceeded");
  });
});

class AnthropicQuotaWriterProvider extends MockWriterProvider {
  override async writeScript(): ReturnType<MockWriterProvider["writeScript"]> {
    throw new ProviderQuotaExceededError(
      "Anthropic Claude credits are depleted or billing is not available. Refill Anthropic credits, then retry the writing step.",
      {
        provider: "Anthropic Claude",
        status: 400,
        requestId: "req_test_anthropic_quota"
      }
    );
  }
}
