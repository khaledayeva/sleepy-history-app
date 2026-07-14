import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModeratedCoverArt } from "../src/imageModeration.js";
import { MockImageProvider } from "../src/providers.js";
import type { CoverArtInput, ImageProvider, ProviderContext } from "../src/providers.js";

const input: CoverArtInput = {
  storyId: "story_image_moderation",
  title: "A Quiet Hour",
  subject: "a scribe in Alexandria",
  prompt: "Square 1:1 calm historical bedtime cover art, no text."
};

const context: ProviderContext = {
  jobId: "job_image_moderation",
  idempotencyKey: "sleepy-history:job_image_moderation:image"
};

describe("image moderation and retry path", () => {
  it("surfaces a calm fallback image when a cover prompt is rejected", async () => {
    const provider = new CountingImageProvider();
    const result = await createModeratedCoverArt(provider, {
      ...input,
      prompt: "Podcast cover imitation with logo, gore, weapons, and nightmare lighting."
    }, context);

    assert.equal(provider.calls, 0);
    assert.equal(result.asset.kind, "cover_full");
    assert.equal(result.asset.mimeType, "image/png");
    assert.equal(result.asset.uri, "sleepy-history://fallback-cover/story_image_moderation.png");
    assert.equal(result.metadata.status, "fallback");
    assert.equal(result.metadata.reviewStatus, "rejected");
    assert.equal(result.metadata.fallbackReason, "branded_artifact");
    assert.equal(result.metadata.attempts, 0);
  });

  it("retries a failed provider call once and keeps the generated image if retry succeeds", async () => {
    const provider = new CountingImageProvider({ failFirst: true });
    const result = await createModeratedCoverArt(provider, input, context);

    assert.equal(provider.calls, 2);
    assert.equal(provider.idempotencyKeys[0], "sleepy-history:job_image_moderation:image:attempt-1");
    assert.equal(provider.idempotencyKeys[1], "sleepy-history:job_image_moderation:image:attempt-2");
    assert.equal(result.asset.id, "asset_story_image_moderation_cover");
    assert.equal(result.metadata.status, "generated");
    assert.equal(result.metadata.reviewStatus, "allowed");
    assert.equal(result.metadata.attempts, 2);
    assert.equal(result.metadata.retryCount, 1);
    assert.deepEqual(result.metadata.errors, ["temporary image outage"]);
  });

  it("uses fallback after one retry without throwing away the story job", async () => {
    const provider = new CountingImageProvider({ alwaysFail: true });
    const result = await createModeratedCoverArt(provider, input, context);

    assert.equal(provider.calls, 2);
    assert.equal(result.asset.id, "asset_story_image_moderation_cover_fallback");
    assert.equal(result.metadata.status, "fallback");
    assert.equal(result.metadata.reviewStatus, "allowed");
    assert.equal(result.metadata.fallbackReason, "provider_failed_after_retry");
    assert.equal(result.metadata.retryCount, 1);
    assert.deepEqual(result.metadata.errors, ["temporary image outage", "temporary image outage"]);
  });
});

class CountingImageProvider extends MockImageProvider implements ImageProvider {
  calls = 0;
  readonly idempotencyKeys: string[] = [];

  constructor(private readonly options: { readonly failFirst?: boolean; readonly alwaysFail?: boolean } = {}) {
    super();
  }

  override async createCoverArt(input: CoverArtInput, context: ProviderContext) {
    this.calls += 1;
    if (context.idempotencyKey) {
      this.idempotencyKeys.push(context.idempotencyKey);
    }
    if (this.options.alwaysFail || (this.options.failFirst && this.calls === 1)) {
      throw new Error("temporary image outage");
    }

    return super.createCoverArt(input, context);
  }
}
