import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createFullLengthAcceptanceStory,
  fullLengthAcceptanceStoryId
} from "../src/acceptanceStory.js";
import type { ProviderContext, StorageProvider, StoredObject, StoredObjectResult } from "../src/providers.js";

describe("full-length acceptance story", () => {
  it("creates playback-ready story metadata with fresh storage URLs", async () => {
    const storage = new SigningOnlyStorageProvider();
    const story = await createFullLengthAcceptanceStory(storage, () => "2026-05-20T00:00:00.000Z");

    assert.equal(story.id, fullLengthAcceptanceStoryId);
    assert.equal(story.title, "The Library at Alexandria");
    assert.equal(story.estimatedDurationSeconds, 3548);
    assert.equal(story.assets.find((asset) => asset.kind === "audio")?.uri, "https://signed.example/stories%2Fstory_full_length_acceptance%2Faudio.wav?fresh=1");
    assert.equal(story.assets.find((asset) => asset.kind === "audio")?.sizeBytes, 113_545_248);
    assert.deepEqual(storage.signedKeys, [
      "stories/story_full_length_acceptance/audio.wav",
      "stories/story_full_length_acceptance/cover.png",
      "stories/story_full_length_acceptance/cover-thumbnail.png",
      "stories/story_full_length_acceptance/cover-placeholder.png",
      "stories/story_full_length_acceptance/transcript.json",
      "stories/story_full_length_acceptance/sources.json",
      "stories/story_full_length_acceptance/script.json"
    ]);
  });
});

class SigningOnlyStorageProvider implements StorageProvider {
  readonly name = "signing-only-storage";
  readonly signedKeys: string[] = [];

  async putObject(_object: StoredObject, _context: ProviderContext): Promise<StoredObjectResult> {
    throw new Error("putObject is not needed for acceptance story metadata");
  }

  async getObject(_key: string, _context: ProviderContext): Promise<StoredObject> {
    throw new Error("getObject is not needed for acceptance story metadata");
  }

  async getObjectUrl(key: string, _context: ProviderContext): Promise<string> {
    this.signedKeys.push(key);
    return `https://signed.example/${encodeURIComponent(key)}?fresh=${this.signedKeys.length}`;
  }

  async deleteObject(_key: string, _context: ProviderContext): Promise<void> {
    throw new Error("deleteObject is not needed for acceptance story metadata");
  }
}
