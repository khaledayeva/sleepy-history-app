import type { AmbienceKind, Asset, JobStatus, SourceRecord, StoryKind } from "./schemas.js";

export type StoryId = string;
export type ChapterId = string;
export type SourceId = string;
export type AssetId = string;
export type GenerationStatus = JobStatus;
export type DownloadStatus = "not_downloaded" | "queued" | "downloading" | "downloaded" | "failed";
export type FactConfidence = "grounded" | "inferred" | "uncertain";

export const terminalGenerationStatuses: readonly GenerationStatus[] = ["completed", "failed", "canceled"];

export interface StoryMetadata {
  readonly id: StoryId;
  readonly title: string;
  readonly subtitle?: string;
  readonly kind: StoryKind;
  readonly subject: string;
  readonly era?: string;
  readonly location?: string;
  readonly perspective?: string;
  readonly synopsis: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly targetDurationMinutes: number;
  readonly estimatedDurationSeconds: number;
  readonly generationStatus: GenerationStatus;
  readonly voiceId?: string;
  readonly ambience?: AmbienceKind;
  readonly coverAssetId?: AssetId;
  readonly audioAssetId?: AssetId;
}

export interface StoryChapter {
  readonly id: ChapterId;
  readonly storyId: StoryId;
  readonly index: number;
  readonly title: string;
  readonly summary: string;
  readonly startSeconds: number;
  readonly durationSeconds: number;
  readonly transcriptSegmentIds: readonly string[];
  readonly sourceIds: readonly SourceId[];
}

export interface TranscriptSegment {
  readonly id: string;
  readonly storyId: StoryId;
  readonly chapterId: ChapterId;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
  readonly sourceIds: readonly SourceId[];
}

export interface StoryFact {
  readonly id: string;
  readonly storyId: StoryId;
  readonly text: string;
  readonly sourceIds: readonly SourceId[];
  readonly confidence: FactConfidence;
}

export interface StoryDownload {
  readonly storyId: StoryId;
  readonly status: DownloadStatus;
  readonly localAssetIds: readonly AssetId[];
  readonly downloadedAt?: string;
  readonly totalBytes?: number;
  readonly failureReason?: string;
}

export interface FavoriteRecord {
  readonly storyId: StoryId;
  readonly isFavorite: boolean;
  readonly updatedAt: string;
}

export interface Bookmark {
  readonly id: string;
  readonly storyId: StoryId;
  readonly chapterId?: ChapterId;
  readonly positionSeconds: number;
  readonly note?: string;
  readonly createdAt: string;
}

export interface PlaybackPosition {
  readonly storyId: StoryId;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly chapterId?: ChapterId;
  readonly updatedAt: string;
  readonly finished: boolean;
}

export interface StoryLibraryItem {
  readonly metadata: StoryMetadata;
  readonly chapters: readonly StoryChapter[];
  readonly transcriptSegments: readonly TranscriptSegment[];
  readonly sources: readonly SourceRecord[];
  readonly facts: readonly StoryFact[];
  readonly assets: readonly Asset[];
  readonly download: StoryDownload;
  readonly favorite: FavoriteRecord;
  readonly playback: PlaybackPosition;
  readonly bookmarks: readonly Bookmark[];
}

export function isTerminalGenerationStatus(status: GenerationStatus): boolean {
  return terminalGenerationStatuses.includes(status);
}

export function createPlaybackPosition(
  storyId: StoryId,
  durationSeconds: number,
  updatedAt: string
): PlaybackPosition {
  return {
    storyId,
    positionSeconds: 0,
    durationSeconds,
    updatedAt,
    finished: false
  };
}

export function updatePlaybackPosition(
  previous: PlaybackPosition,
  positionSeconds: number,
  updatedAt: string,
  chapterId?: ChapterId
): PlaybackPosition {
  const clampedPosition = clamp(positionSeconds, 0, previous.durationSeconds);

  return {
    ...previous,
    chapterId,
    positionSeconds: clampedPosition,
    updatedAt,
    finished: clampedPosition >= previous.durationSeconds
  };
}

export function setFavorite(
  storyId: StoryId,
  isFavorite: boolean,
  updatedAt: string
): FavoriteRecord {
  return {
    storyId,
    isFavorite,
    updatedAt
  };
}

export function createDownloadState(storyId: StoryId): StoryDownload {
  return {
    storyId,
    status: "not_downloaded",
    localAssetIds: []
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
