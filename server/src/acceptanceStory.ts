import type { ProviderContext, StorageProvider } from "./providers.js";
import type { Asset, Story } from "./schemas.js";

export const fullLengthAcceptanceStoryId = "story_full_length_acceptance";

const acceptanceStoryAssetKeys = {
  audio: "stories/story_full_length_acceptance/audio.wav",
  coverFull: "stories/story_full_length_acceptance/cover.png",
  coverThumbnail: "stories/story_full_length_acceptance/cover-thumbnail.png",
  coverPlaceholder: "stories/story_full_length_acceptance/cover-placeholder.png",
  transcript: "stories/story_full_length_acceptance/transcript.json",
  sources: "stories/story_full_length_acceptance/sources.json",
  script: "stories/story_full_length_acceptance/script.json"
} as const;

export async function createFullLengthAcceptanceStory(
  storage: StorageProvider,
  now: () => string = () => new Date().toISOString()
): Promise<Story> {
  const context: ProviderContext = {
    jobId: "job_full_length_acceptance",
    idempotencyKey: "story_full_length_acceptance:demo-story"
  };
  const createdAt = "2026-05-14T23:27:30.000Z";
  const audioUrl = await storage.getObjectUrl(acceptanceStoryAssetKeys.audio, context);
  const coverFullUrl = await storage.getObjectUrl(acceptanceStoryAssetKeys.coverFull, context);
  const coverThumbnailUrl = await storage.getObjectUrl(acceptanceStoryAssetKeys.coverThumbnail, context);
  const coverPlaceholderUrl = await storage.getObjectUrl(acceptanceStoryAssetKeys.coverPlaceholder, context);
  const transcriptUrl = await storage.getObjectUrl(acceptanceStoryAssetKeys.transcript, context);
  const sourcesUrl = await storage.getObjectUrl(acceptanceStoryAssetKeys.sources, context);
  const scriptUrl = await storage.getObjectUrl(acceptanceStoryAssetKeys.script, context);

  return {
    id: fullLengthAcceptanceStoryId,
    title: "The Library at Alexandria",
    subtitle: "A scribe closes the quiet halls",
    kind: "daily_life",
    subject: "a scribe closing the Library at Alexandria",
    synopsis: "A calm original bedtime history following an ordinary library scribe through the end of a gentle workday in Ptolemaic Alexandria.",
    targetDurationMinutes: 60,
    estimatedDurationSeconds: 3548,
    createdAt,
    chapters: [
      {
        id: "chapter_01",
        index: 1,
        title: "The Scribes Close Their Inkwells",
        summary: "The library settles into evening as a scribe finishes the day's careful work.",
        estimatedDurationSeconds: 3548,
        transcript: "The full transcript is available as a generated story asset.",
        sourceIds: ["source_acceptance_sources"]
      }
    ],
    sources: [
      {
        id: "source_acceptance_sources",
        title: "Generated source dossier",
        publisher: "Sleepy History",
        retrievedAt: now(),
        notes: "The complete source list is available in the sources asset for this generated story."
      }
    ],
    assets: compactAssets([
      {
        id: "asset_story_full_length_acceptance_audio",
        kind: "audio",
        mimeType: "audio/wav",
        uri: audioUrl,
        sizeBytes: 113_545_248,
        durationSeconds: 3548
      },
      {
        id: "asset_story_full_length_acceptance_cover_full",
        kind: "cover_full",
        mimeType: "image/png",
        uri: coverFullUrl,
        sizeBytes: 1_646_082
      },
      {
        id: "asset_story_full_length_acceptance_cover_thumbnail",
        kind: "cover_thumbnail",
        mimeType: "image/png",
        uri: coverThumbnailUrl,
        sizeBytes: 238_756
      },
      {
        id: "asset_story_full_length_acceptance_placeholder",
        kind: "placeholder",
        mimeType: "image/png",
        uri: coverPlaceholderUrl,
        sizeBytes: 2_788
      },
      {
        id: "asset_story_full_length_acceptance_transcript",
        kind: "transcript",
        mimeType: "application/json",
        uri: transcriptUrl,
        sizeBytes: 45_189
      },
      {
        id: "asset_story_full_length_acceptance_sources",
        kind: "sources",
        mimeType: "application/json",
        uri: sourcesUrl,
        sizeBytes: 2_398
      },
      {
        id: "asset_story_full_length_acceptance_script",
        kind: "transcript",
        mimeType: "application/json",
        uri: scriptUrl,
        sizeBytes: 58_352
      }
    ])
  };
}

function compactAssets(assets: readonly Asset[]): readonly Asset[] {
  return assets;
}
