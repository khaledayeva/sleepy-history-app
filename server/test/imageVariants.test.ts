import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createImageVariants, imageVariantStorageKey } from "../src/imageVariants.js";
import { MockImageProvider } from "../src/providers.js";

describe("image variants", () => {
  it("creates deterministic full, thumbnail, and placeholder cover assets", async () => {
    const source = await new MockImageProvider().createCoverArt({
      storyId: "story_variant",
      title: "A Quiet Story",
      subject: "a scribe",
      prompt: "calm bedtime cover"
    }, {
      jobId: "job_variant"
    });

    const variants = createImageVariants(source);

    assert.deepEqual(variants.map((variant) => variant.role), ["full", "thumbnail", "placeholder"]);
    assert.deepEqual(variants.map((variant) => variant.asset.kind), ["cover_full", "cover_thumbnail", "placeholder"]);
    assert.equal(variants[0]?.asset.width, 1536);
    assert.equal(variants[0]?.asset.height, 1536);
    assert.equal(variants[1]?.asset.width, 320);
    assert.equal(variants[1]?.asset.height, 320);
    assert.equal(variants[2]?.asset.width, 32);
    assert.equal(variants[2]?.asset.height, 32);
    assert.match(variants[0]?.asset.checksum ?? "", /^sha256:/);
    assert.match(variants[1]?.asset.checksum ?? "", /^sha256:/);
    assert.match(variants[2]?.asset.checksum ?? "", /^sha256:/);
    assert.equal(variants[0]?.asset.bytes, source.bytes);
    assert.notEqual(variants[1]?.asset.bytes, source.bytes);
    assert.notEqual(variants[2]?.asset.bytes, source.bytes);
    assert.deepEqual(pngDimensions(variants[1]?.asset.bytes), { width: 320, height: 320 });
    assert.deepEqual(pngDimensions(variants[2]?.asset.bytes), { width: 32, height: 32 });
    assert.notEqual(variants[1]?.asset.checksum, variants[0]?.asset.checksum);
    assert.notEqual(variants[2]?.asset.checksum, variants[0]?.asset.checksum);
    assert.equal(imageVariantStorageKey("story_variant", "full"), "stories/story_variant/cover.png");
    assert.equal(imageVariantStorageKey("story_variant", "thumbnail"), "stories/story_variant/cover-thumbnail.png");
    assert.equal(imageVariantStorageKey("story_variant", "placeholder"), "stories/story_variant/cover-placeholder.png");
  });
});

function pngDimensions(bytes: Uint8Array | undefined): { readonly width: number; readonly height: number } {
  assert.ok(bytes);
  const buffer = Buffer.from(bytes);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}
