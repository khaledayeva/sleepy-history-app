import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasOpenAIImageSmokeConfig, OpenAIImageProvider } from "../src/openAiImageProvider.js";
import type { CoverArtInput } from "../src/providers.js";

const input: CoverArtInput = {
  storyId: "story_abbasid_baker",
  title: "A Lantern Beside the Abbasid Oven",
  subject: "a baker in Abbasid Baghdad",
  prompt: "Square 1:1 calm bedtime history cover art, no text, historically grounded."
};

const context = {
  jobId: "job_openai_image",
  idempotencyKey: "sleepy-history:job_openai_image:image"
};

describe("OpenAI GPT-Image 2 provider", () => {
  it("calls the configurable OpenAI image generation endpoint and stores output metadata", async () => {
    const calls: { readonly url: string; readonly init: { readonly headers: Record<string, string>; readonly body: string } }[] = [];
    const provider = new OpenAIImageProvider({
      apiKey: "test-openai-key",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({
          created: 1770000000,
          data: [
            {
              b64_json: Buffer.from("png-bytes").toString("base64"),
              revised_prompt: "A calm historically grounded bedtime cover."
            }
          ]
        }, {
          "x-request-id": "req_image_123"
        });
      }
    });

    const asset = await provider.createCoverArt(input, context);
    const body = JSON.parse(calls[0]?.init.body ?? "{}") as Record<string, unknown>;

    assert.equal(calls[0]?.url, "https://api.openai.com/v1/images/generations");
    assert.equal(calls[0]?.init.headers.authorization, "Bearer test-openai-key");
    assert.equal(calls[0]?.init.headers["idempotency-key"], context.idempotencyKey);
    assert.equal(body.model, "gpt-image-2");
    assert.equal(body.prompt, input.prompt);
    assert.equal(body.n, 1);
    assert.equal(body.size, "1024x1024");
    assert.equal(asset.kind, "cover_full");
    assert.equal(asset.mimeType, "image/png");
    assert.equal(asset.sizeBytes, 9);
    assert.equal(asset.width, 1024);
    assert.equal(asset.height, 1024);
    assert.match(asset.checksum ?? "", /^sha256:/);
    assert.equal(asset.providerMetadata.provider, "openai");
    assert.equal(asset.providerMetadata.modelId, "gpt-image-2");
    assert.equal(asset.providerMetadata.requestId, "req_image_123");
    assert.equal(asset.providerMetadata.revisedPrompt, "A calm historically grounded bedtime cover.");
  });

  it("supports model and size overrides without changing the provider interface", async () => {
    const provider = new OpenAIImageProvider({
      apiKey: "test-openai-key",
      modelId: "gpt-image-2-2026-04-21",
      size: "1536x1536",
      endpoint: "https://example.test/images",
      fetchImpl: async (_url, _init) => jsonResponse({
        data: [
          {
            b64_json: Buffer.from([137, 80, 78, 71]).toString("base64")
          }
        ]
      })
    });

    const asset = await provider.createCoverArt(input, context);

    assert.equal(asset.providerMetadata.modelId, "gpt-image-2-2026-04-21");
    assert.equal(asset.providerMetadata.size, "1536x1536");
    assert.equal(asset.width, 1536);
    assert.equal(asset.height, 1536);
  });

  it("uses OPENAI_IMAGE_MODEL as the default runtime model override", async () => {
    const previousModel = process.env.OPENAI_IMAGE_MODEL;
    process.env.OPENAI_IMAGE_MODEL = "gpt-image-2-2026-04-21";
    try {
      const calls: { readonly body: string }[] = [];
      const provider = new OpenAIImageProvider({
        apiKey: "test-openai-key",
        fetchImpl: async (_url, init) => {
          calls.push({ body: init.body });
          return jsonResponse({
            data: [
              {
                b64_json: Buffer.from("env-model").toString("base64")
              }
            ]
          });
        }
      });
      const asset = await provider.createCoverArt(input, context);
      const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;

      assert.equal(body.model, "gpt-image-2-2026-04-21");
      assert.equal(asset.providerMetadata.modelId, "gpt-image-2-2026-04-21");
    } finally {
      if (previousModel === undefined) {
        delete process.env.OPENAI_IMAGE_MODEL;
      } else {
        process.env.OPENAI_IMAGE_MODEL = previousModel;
      }
    }
  });

  it("rejects malformed and failed provider responses", async () => {
    const failingProvider = new OpenAIImageProvider({
      apiKey: "test-openai-key",
      fetchImpl: async (_url, _init) => jsonResponse({
        error: {
          message: "model not available"
        }
      }, {}, false, 404)
    });
    await assert.rejects(failingProvider.createCoverArt(input, context), /model not available/);

    const malformedProvider = new OpenAIImageProvider({
      apiKey: "test-openai-key",
      fetchImpl: async (_url, _init) => jsonResponse({ data: [{}] })
    });
    await assert.rejects(malformedProvider.createCoverArt(input, context), /b64_json/);

    assert.throws(() => new OpenAIImageProvider({ apiKey: "" }), /OPENAI_API_KEY/);
  });

  it("can run a real-provider smoke test when OPENAI_API_KEY is present", { skip: !hasOpenAIImageSmokeConfig() }, async () => {
    const provider = new OpenAIImageProvider();
    const asset = await provider.createCoverArt({
      ...input,
      prompt: "Minimal square sleep-friendly historical cover art of a clay oil lamp on a plain table, no text."
    }, {
      jobId: "job_openai_real_smoke",
      idempotencyKey: `sleepy-history:job_openai_real_smoke:${Date.now()}`
    });

    assert.equal(asset.mimeType, "image/png");
    assert.ok(asset.sizeBytes && asset.sizeBytes > 0);
    assert.equal(asset.providerMetadata.modelId, "gpt-image-2");
  });
});

function jsonResponse(
  body: unknown,
  headers: Record<string, string> = {},
  ok = true,
  status = 200
) {
  return {
    ok,
    status,
    headers: {
      get(name: string): string | null {
        return headers[name.toLowerCase()] ?? null;
      }
    },
    async json() {
      return body;
    }
  };
}
