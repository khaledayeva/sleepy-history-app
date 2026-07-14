import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { getHealth } from "../src/health.js";
import { runWorker } from "../src/worker.js";

const railwayLinks = [
  { label: "Dashboard", url: "https://railway.com/dashboard" },
  { label: "Billing", url: "https://railway.com/account/billing" }
];
const r2Links = [
  { label: "R2", url: "https://dash.cloudflare.com/?to=/:account/r2" },
  { label: "API Tokens", url: "https://dash.cloudflare.com/profile/api-tokens" },
  { label: "Billing", url: "https://dash.cloudflare.com/?to=/:account/billing" }
];
const geminiLinks = [
  { label: "API Keys", url: "https://aistudio.google.com/app/apikey" },
  { label: "Billing", url: "https://console.cloud.google.com/billing" },
  { label: "AI Studio", url: "https://aistudio.google.com/" }
];
const anthropicLinks = [
  { label: "API Keys", url: "https://console.anthropic.com/settings/keys" },
  { label: "Billing", url: "https://console.anthropic.com/settings/billing" },
  { label: "Usage", url: "https://console.anthropic.com/usage" }
];
const elevenLabsLinks = [
  { label: "API Keys", url: "https://elevenlabs.io/app/settings/api-keys" },
  { label: "Credits", url: "https://elevenlabs.io/app/subscription" },
  { label: "Usage", url: "https://elevenlabs.io/app/usage" }
];
const openAiLinks = [
  { label: "API Keys", url: "https://platform.openai.com/api-keys" },
  { label: "Billing", url: "https://platform.openai.com/settings/organization/billing/overview" },
  { label: "Usage", url: "https://platform.openai.com/usage" }
];

describe("health endpoint payload", () => {
  it("reports service status without secrets", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: "8787",
      PROVIDER_KILL_SWITCH: "true"
    });

    assert.deepEqual(getHealth(config), {
      ok: true,
      service: "sleepy-history-server",
      mode: "test",
      providerKillSwitch: true,
      providers: [
        {
          id: "railway-backend",
          step: "Backend hosting",
          provider: "Railway",
          state: "warning",
          detail: "Backend is reachable, but paid provider calls are paused.",
          consoleLinks: railwayLinks
        },
        {
          id: "cloudflare-r2-storage",
          step: "Object storage",
          provider: "Cloudflare R2",
          state: "online",
          detail: "R2 storage is configured for generated audio, artwork, transcripts, and sources.",
          consoleLinks: r2Links
        },
        {
          id: "gemini-research",
          step: "Research dossier",
          provider: "Google Gemini",
          model: "gemini-3.1-pro-preview",
          state: "offline",
          detail: "Paused by provider kill switch.",
          consoleLinks: geminiLinks
        },
        {
          id: "opus-writing",
          step: "Story writing",
          provider: "Anthropic Claude",
          model: "claude-opus-4-6",
          state: "offline",
          detail: "Paused by provider kill switch.",
          consoleLinks: anthropicLinks
        },
        {
          id: "elevenlabs-narration",
          step: "Narration",
          provider: "ElevenLabs",
          model: "eleven_multilingual_v2 · pcm_24000",
          state: "offline",
          detail: "Paused by provider kill switch.",
          consoleLinks: elevenLabsLinks
        },
        {
          id: "openai-cover-art",
          step: "Cover art",
          provider: "OpenAI Images",
          model: "gpt-image-2",
          state: "offline",
          detail: "Paused by provider kill switch.",
          consoleLinks: openAiLinks
        }
      ]
    });
  });

  it("reports hosted worker health when available", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PORT: "8787"
    });

    assert.deepEqual(getHealth(config, {
      ok: true,
      status: "idle",
      processedJobs: 2,
      lastRunAt: "2026-05-12T01:00:00.000Z"
    }), {
      ok: true,
      service: "sleepy-history-server",
      mode: "production",
      providerKillSwitch: false,
      providers: [
        {
          id: "railway-backend",
          step: "Backend hosting",
          provider: "Railway",
          state: "online",
          detail: "Backend is reachable and ready to coordinate generation jobs.",
          consoleLinks: railwayLinks
        },
        {
          id: "cloudflare-r2-storage",
          step: "Object storage",
          provider: "Cloudflare R2",
          state: "online",
          detail: "R2 storage is configured for generated audio, artwork, transcripts, and sources.",
          consoleLinks: r2Links
        },
        {
          id: "gemini-research",
          step: "Research dossier",
          provider: "Google Gemini",
          model: "gemini-3.1-pro-preview",
          state: "offline",
          detail: "Disabled in backend configuration.",
          consoleLinks: geminiLinks
        },
        {
          id: "opus-writing",
          step: "Story writing",
          provider: "Anthropic Claude",
          model: "claude-opus-4-6",
          state: "offline",
          detail: "Disabled in backend configuration.",
          consoleLinks: anthropicLinks
        },
        {
          id: "elevenlabs-narration",
          step: "Narration",
          provider: "ElevenLabs",
          model: "eleven_multilingual_v2 · pcm_24000",
          state: "offline",
          detail: "Disabled in backend configuration.",
          consoleLinks: elevenLabsLinks
        },
        {
          id: "openai-cover-art",
          step: "Cover art",
          provider: "OpenAI Images",
          model: "gpt-image-2",
          state: "offline",
          detail: "Disabled in backend configuration.",
          consoleLinks: openAiLinks
        }
      ],
      worker: {
        ok: true,
        status: "idle",
        processedJobs: 2,
        lastRunAt: "2026-05-12T01:00:00.000Z"
      }
    });
  });

  it("does not expose raw worker error messages on public health", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PORT: "8787"
    });

    assert.deepEqual(getHealth(config, {
      ok: false,
      status: "error",
      processedJobs: 0,
      lastRunAt: "2026-05-12T01:00:00.000Z",
      lastError: "Provider failed with secret response body"
    }), {
      ok: true,
      service: "sleepy-history-server",
      mode: "production",
      providerKillSwitch: false,
      providers: [
        {
          id: "railway-backend",
          step: "Backend hosting",
          provider: "Railway",
          state: "online",
          detail: "Backend is reachable and ready to coordinate generation jobs.",
          consoleLinks: railwayLinks
        },
        {
          id: "cloudflare-r2-storage",
          step: "Object storage",
          provider: "Cloudflare R2",
          state: "online",
          detail: "R2 storage is configured for generated audio, artwork, transcripts, and sources.",
          consoleLinks: r2Links
        },
        {
          id: "gemini-research",
          step: "Research dossier",
          provider: "Google Gemini",
          model: "gemini-3.1-pro-preview",
          state: "offline",
          detail: "Disabled in backend configuration.",
          consoleLinks: geminiLinks
        },
        {
          id: "opus-writing",
          step: "Story writing",
          provider: "Anthropic Claude",
          model: "claude-opus-4-6",
          state: "offline",
          detail: "Disabled in backend configuration.",
          consoleLinks: anthropicLinks
        },
        {
          id: "elevenlabs-narration",
          step: "Narration",
          provider: "ElevenLabs",
          model: "eleven_multilingual_v2 · pcm_24000",
          state: "offline",
          detail: "Disabled in backend configuration.",
          consoleLinks: elevenLabsLinks
        },
        {
          id: "openai-cover-art",
          step: "Cover art",
          provider: "OpenAI Images",
          model: "gpt-image-2",
          state: "offline",
          detail: "Disabled in backend configuration.",
          consoleLinks: openAiLinks
        }
      ],
      worker: {
        ok: false,
        status: "error",
        processedJobs: 0,
        lastRunAt: "2026-05-12T01:00:00.000Z",
        lastErrorCode: "worker_error"
      }
    });
  });

  it("maps enabled providers and provider quota failures to public status rows", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PORT: "8787",
      ENABLE_GEMINI_RESEARCH: "true",
      ENABLE_ANTHROPIC_WRITING: "true",
      ENABLE_ELEVENLABS_TTS: "true",
      ENABLE_OPENAI_IMAGES: "true",
      GEMINI_RESEARCH_MODEL: "gemini-custom",
      ANTHROPIC_WRITER_MODEL: "claude-custom",
      ELEVENLABS_TTS_MODEL: "eleven-custom",
      ELEVENLABS_OUTPUT_FORMAT: "mp3_44100_128",
      OPENAI_IMAGE_MODEL: "gpt-image-custom"
    });

    const health = getHealth(config, {
      ok: false,
      status: "error",
      processedJobs: 1,
      lastError: "ElevenLabs quota exceeded. 979 credits remain."
    });

    assert.equal(health.providers.find((provider) => provider.id === "gemini-research")?.state, "online");
    assert.equal(health.providers.find((provider) => provider.id === "gemini-research")?.model, "gemini-custom");
    assert.deepEqual(health.providers.find((provider) => provider.id === "gemini-research")?.consoleLinks, geminiLinks);
    assert.equal(health.providers.find((provider) => provider.id === "opus-writing")?.state, "online");
    assert.equal(health.providers.find((provider) => provider.id === "opus-writing")?.model, "claude-custom");
    assert.equal(health.providers.find((provider) => provider.id === "openai-cover-art")?.state, "online");
    assert.equal(health.providers.find((provider) => provider.id === "openai-cover-art")?.model, "gpt-image-custom");
    assert.equal(health.providers.find((provider) => provider.id === "elevenlabs-narration")?.state, "credits_depleted");
    assert.equal(health.providers.find((provider) => provider.id === "elevenlabs-narration")?.model, "eleven-custom · mp3_44100_128");
    assert.equal(health.providers.find((provider) => provider.id === "railway-backend")?.state, "online");
    assert.equal(health.providers.find((provider) => provider.id === "cloudflare-r2-storage")?.state, "online");
    assert.equal(health.providers.length, 6);
    assert.doesNotMatch(JSON.stringify(health), /979 credits|request_id|invalid_request/);

    const openAiHealth = getHealth(config, {
      ok: false,
      status: "error",
      processedJobs: 2,
      lastError: "OpenAI GPT-Image quota exceeded. request_id=req_secret_123"
    });

    assert.equal(openAiHealth.providers.find((provider) => provider.id === "openai-cover-art")?.state, "credits_depleted");
    assert.equal(openAiHealth.providers.find((provider) => provider.id === "elevenlabs-narration")?.state, "online");
    assert.doesNotMatch(JSON.stringify(openAiHealth), /req_secret_123|quota exceeded/i);

    const anthropicHealth = getHealth(config, {
      ok: true,
      status: "idle",
      processedJobs: 3,
      lastError: "Anthropic Claude credits are depleted or billing is not available. Refill Anthropic credits, then retry the writing step."
    });

    assert.equal(anthropicHealth.providers.find((provider) => provider.id === "opus-writing")?.state, "credits_depleted");
    assert.equal(anthropicHealth.providers.find((provider) => provider.id === "gemini-research")?.state, "online");
    assert.doesNotMatch(JSON.stringify(anthropicHealth), /billing is not available/i);
  });

  it("maps provider-specific runtime warnings without taking unrelated providers offline", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PORT: "8787",
      ENABLE_GEMINI_RESEARCH: "true",
      ENABLE_ANTHROPIC_WRITING: "true",
      ENABLE_ELEVENLABS_TTS: "true",
      ENABLE_OPENAI_IMAGES: "true"
    });

    const health = getHealth(config, {
      ok: false,
      status: "error",
      processedJobs: 3,
      lastError: "Claude Opus script provider returned a transient upstream error body"
    });

    assert.equal(health.providers.find((provider) => provider.id === "opus-writing")?.state, "warning");
    assert.equal(health.providers.find((provider) => provider.id === "gemini-research")?.state, "online");
    assert.equal(health.providers.find((provider) => provider.id === "elevenlabs-narration")?.state, "online");
    assert.doesNotMatch(JSON.stringify(health), /transient upstream error body/);
  });
});

describe("worker", () => {
  it("starts in once mode", async () => {
    const result = await runWorker({
      once: true,
      worker: {
        runOnce: async () => ({
          ok: true,
          status: "idle",
          processedJobs: 1
        }),
        start: () => undefined
      }
    });

    assert.deepEqual(result, {
      ok: true,
      processedJobs: 1
    });
  });
});
