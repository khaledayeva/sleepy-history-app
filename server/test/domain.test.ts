import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDownloadState,
  createPlaybackPosition,
  isTerminalGenerationStatus,
  setFavorite,
  updatePlaybackPosition
} from "../src/domain.js";
import type { StoryLibraryItem } from "../src/domain.js";

describe("story domain models", () => {
  it("represents a complete library item shape", () => {
    const libraryItem: StoryLibraryItem = {
      metadata: {
        id: "story_abbasid_baker",
        title: "A Lantern Beside the Abbasid Oven",
        kind: "daily_life",
        subject: "a baker in Abbasid Baghdad",
        era: "9th century CE",
        location: "Baghdad",
        synopsis: "A quiet daily-life story for sleep.",
        createdAt: "2026-05-10T00:30:00.000Z",
        updatedAt: "2026-05-10T00:30:00.000Z",
        targetDurationMinutes: 60,
        estimatedDurationSeconds: 3600,
        generationStatus: "completed",
        voiceId: "calm_narrator_01",
        ambience: "rain",
        coverAssetId: "asset_cover_full",
        audioAssetId: "asset_audio"
      },
      chapters: [
        {
          id: "chapter_01",
          storyId: "story_abbasid_baker",
          index: 1,
          title: "Before the First Ember",
          summary: "A quiet opening chapter.",
          startSeconds: 0,
          durationSeconds: 420,
          transcriptSegmentIds: ["segment_01"],
          sourceIds: ["source_abbasid_baghdad"]
        }
      ],
      transcriptSegments: [
        {
          id: "segment_01",
          storyId: "story_abbasid_baker",
          chapterId: "chapter_01",
          startSeconds: 0,
          endSeconds: 30,
          text: "Before the first ember brightens, the room is still and cool.",
          sourceIds: ["source_abbasid_baghdad"]
        }
      ],
      sources: [
        {
          id: "source_abbasid_baghdad",
          title: "Daily Life in Abbasid Baghdad",
          publisher: "World History Encyclopedia"
        }
      ],
      facts: [
        {
          id: "fact_01",
          storyId: "story_abbasid_baker",
          text: "Baghdad was a major Abbasid urban center.",
          sourceIds: ["source_abbasid_baghdad"],
          confidence: "grounded"
        }
      ],
      assets: [
        {
          id: "asset_audio",
          kind: "audio",
          mimeType: "audio/mpeg",
          uri: "sleepy-history://assets/story_abbasid_baker/story.mp3",
          durationSeconds: 3600
        }
      ],
      download: createDownloadState("story_abbasid_baker"),
      favorite: setFavorite("story_abbasid_baker", false, "2026-05-10T00:30:00.000Z"),
      playback: createPlaybackPosition("story_abbasid_baker", 3600, "2026-05-10T00:30:00.000Z"),
      bookmarks: []
    };

    assert.equal(libraryItem.metadata.generationStatus, "completed");
    assert.equal(libraryItem.chapters[0]?.transcriptSegmentIds[0], "segment_01");
    assert.equal(libraryItem.facts[0]?.confidence, "grounded");
  });

  it("identifies terminal generation statuses", () => {
    assert.equal(isTerminalGenerationStatus("completed"), true);
    assert.equal(isTerminalGenerationStatus("failed"), true);
    assert.equal(isTerminalGenerationStatus("canceled"), true);
    assert.equal(isTerminalGenerationStatus("writing"), false);
  });

  it("clamps playback position and marks finished at duration", () => {
    const initial = createPlaybackPosition("story_01", 300, "2026-05-10T00:00:00.000Z");
    const progressed = updatePlaybackPosition(initial, 125, "2026-05-10T00:01:00.000Z", "chapter_02");
    const finished = updatePlaybackPosition(progressed, 999, "2026-05-10T00:05:00.000Z", "chapter_03");

    assert.equal(progressed.positionSeconds, 125);
    assert.equal(progressed.chapterId, "chapter_02");
    assert.equal(progressed.finished, false);
    assert.equal(finished.positionSeconds, 300);
    assert.equal(finished.finished, true);
  });
});
