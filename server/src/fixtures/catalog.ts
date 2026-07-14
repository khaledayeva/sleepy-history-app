import {
  createDownloadState,
  createPlaybackPosition,
  setFavorite,
  type StoryLibraryItem
} from "../domain.js";
import type { GenerationJob } from "../schemas.js";

export type FixtureState =
  | "historical_figure"
  | "ordinary_daily_life"
  | "incomplete_job"
  | "failed_job"
  | "downloaded_story"
  | "missing_asset";

export interface FixtureCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly state: FixtureState;
  readonly story?: StoryLibraryItem;
  readonly job?: GenerationJob;
  readonly missingAssetIds?: readonly string[];
}

const now = "2026-05-10T01:00:00.000Z";

export const fixtureCatalog: readonly FixtureCatalogEntry[] = [
  {
    id: "fixture_historical_figure",
    label: "Historical figure story",
    state: "historical_figure",
    story: story({
      id: "story_marcus_aurelius",
      title: "The Quiet Desk of Marcus Aurelius",
      kind: "historical_figure",
      subject: "Marcus Aurelius",
      synopsis: "A calm reflection on routine, responsibility, and evening notes in imperial Rome.",
      chapterTitle: "Wax Tablets at Dusk"
    })
  },
  {
    id: "fixture_ordinary_daily_life",
    label: "Ordinary daily-life story",
    state: "ordinary_daily_life",
    story: story({
      id: "story_abbasid_baker",
      title: "A Lantern Beside the Abbasid Oven",
      kind: "daily_life",
      subject: "a baker in Abbasid Baghdad",
      synopsis: "A gentle market-day routine in ninth-century Baghdad.",
      chapterTitle: "Before the First Ember"
    })
  },
  {
    id: "fixture_incomplete_job",
    label: "Incomplete generation job",
    state: "incomplete_job",
    job: job("job_incomplete_baker", "writing", 47)
  },
  {
    id: "fixture_failed_job",
    label: "Failed generation job",
    state: "failed_job",
    job: {
      ...job("job_failed_lighthouse", "failed", 18),
      error: {
        code: "research_dossier_insufficient",
        message: "The research dossier did not have enough grounded daily-life details.",
        retryable: true
      }
    }
  },
  {
    id: "fixture_downloaded_story",
    label: "Downloaded story",
    state: "downloaded_story",
    story: {
      ...story({
        id: "story_nile_scribe",
        title: "Ink Drying Beside the Nile",
        kind: "daily_life",
        subject: "a scribe in Ptolemaic Egypt",
        synopsis: "A quiet administrative day near the river.",
        chapterTitle: "Reeds, Ink, and Shade"
      }),
      download: {
        storyId: "story_nile_scribe",
        status: "downloaded",
        localAssetIds: ["asset_story_nile_scribe_audio", "asset_story_nile_scribe_cover"],
        downloadedAt: now,
        totalBytes: 48128000
      }
    }
  },
  {
    id: "fixture_missing_asset",
    label: "Story with a missing generated asset",
    state: "missing_asset",
    story: {
      ...story({
        id: "story_missing_cover",
        title: "A Moonlit Road to Chang'an",
        kind: "daily_life",
        subject: "a courier near Tang dynasty Chang'an",
        synopsis: "A soft night journey outside the city walls.",
        chapterTitle: "The Road Grows Quiet",
        coverAssetId: "asset_missing_cover"
      }),
      assets: []
    },
    missingAssetIds: ["asset_missing_cover"]
  }
];

export function fixtureCatalogSummary(): Record<FixtureState, number> {
  return fixtureCatalog.reduce<Record<FixtureState, number>>(
    (summary, entry) => ({
      ...summary,
      [entry.state]: summary[entry.state] + 1
    }),
    {
      historical_figure: 0,
      ordinary_daily_life: 0,
      incomplete_job: 0,
      failed_job: 0,
      downloaded_story: 0,
      missing_asset: 0
    }
  );
}

function story(options: {
  readonly id: string;
  readonly title: string;
  readonly kind: "historical_figure" | "daily_life";
  readonly subject: string;
  readonly synopsis: string;
  readonly chapterTitle: string;
  readonly coverAssetId?: string;
}): StoryLibraryItem {
  const coverAssetId = options.coverAssetId ?? `asset_${options.id}_cover`;
  const audioAssetId = `asset_${options.id}_audio`;

  return {
    metadata: {
      id: options.id,
      title: options.title,
      kind: options.kind,
      subject: options.subject,
      synopsis: options.synopsis,
      createdAt: now,
      updatedAt: now,
      targetDurationMinutes: 60,
      estimatedDurationSeconds: 3600,
      generationStatus: "completed",
      voiceId: "calm_narrator_01",
      ambience: "rain",
      coverAssetId,
      audioAssetId
    },
    chapters: [
      {
        id: `${options.id}_chapter_01`,
        storyId: options.id,
        index: 1,
        title: options.chapterTitle,
        summary: "A slow opening chapter for fixture-backed UI and playback states.",
        startSeconds: 0,
        durationSeconds: 420,
        transcriptSegmentIds: [`${options.id}_segment_01`],
        sourceIds: [`${options.id}_source_01`]
      }
    ],
    transcriptSegments: [
      {
        id: `${options.id}_segment_01`,
        storyId: options.id,
        chapterId: `${options.id}_chapter_01`,
        startSeconds: 0,
        endSeconds: 45,
        text: "The evening begins quietly, with small details settling into place.",
        sourceIds: [`${options.id}_source_01`]
      }
    ],
    sources: [
      {
        id: `${options.id}_source_01`,
        title: `${options.subject} fixture source`,
        publisher: "Sleepy History Fixture Archive",
        notes: "Fixture source used for local development and UI states."
      }
    ],
    facts: [
      {
        id: `${options.id}_fact_01`,
        storyId: options.id,
        text: "This fixture fact is grounded to the local fixture source.",
        sourceIds: [`${options.id}_source_01`],
        confidence: "grounded"
      }
    ],
    assets: [
      {
        id: coverAssetId,
        kind: "cover_full",
        mimeType: "image/png",
        uri: `sleepy-history://fixtures/${options.id}/cover.png`,
        width: 1536,
        height: 1536
      },
      {
        id: audioAssetId,
        kind: "audio",
        mimeType: "audio/mpeg",
        uri: `sleepy-history://fixtures/${options.id}/story.mp3`,
        durationSeconds: 3600
      }
    ],
    download: createDownloadState(options.id),
    favorite: setFavorite(options.id, false, now),
    playback: createPlaybackPosition(options.id, 3600, now),
    bookmarks: []
  };
}

function job(id: string, status: GenerationJob["status"], percent: number): GenerationJob {
  return {
    id,
    status,
    request: {
      schemaVersion: "2026-05-10",
      kind: "daily_life",
      subject: "a night watchman in medieval Cordoba",
      targetDurationMinutes: 60,
      era: "10th century CE",
      location: "Cordoba",
      perspective: "ordinary worker finishing a calm night shift",
      voiceId: "calm_narrator_01",
      ambience: "none",
      safety: {
        bedtimeTone: "very_gentle",
        allowHistoricalViolenceContext: false
      }
    },
    progress: {
      stage: status,
      percent,
      message: `${status} fixture`
    },
    createdAt: now,
    updatedAt: now
  };
}
