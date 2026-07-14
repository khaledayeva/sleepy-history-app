import type { JobStore } from "./jobStore.js";
import type { ProviderContext, ScriptChapter, StoryScript, StorageProvider } from "./providers.js";
import { parseSourceRecord, parseStory, type Asset, type AssetKind, type GenerationJob, type SourceRecord, type Story } from "./schemas.js";

interface AssetAccessLink {
  readonly role: string;
  readonly key: string;
  readonly mimeType: string;
  readonly sizeBytes?: number;
  readonly metadata?: Record<string, unknown>;
}

interface ChapterMarkersPayload {
  readonly durationSeconds?: number;
  readonly markers: readonly {
    readonly chapterId: string;
    readonly durationSeconds: number;
  }[];
}

export async function getGeneratedStory(
  jobStore: JobStore,
  storage: StorageProvider,
  storyId: string,
  now: () => string = () => new Date().toISOString()
): Promise<Story | undefined> {
  const job = await findCompletedStoryJob(jobStore, storyId);
  if (!job?.metadata?.assetAccess) {
    return undefined;
  }

  const links = readAssetAccessLinks(job.metadata.assetAccess);
  if (!links.length) {
    return undefined;
  }

  const context: ProviderContext = {
    jobId: job.id,
    idempotencyKey: `${storyId}:story-metadata`
  };
  const script = await readJsonObject<StoryScript>(storage, requiredLink(links, "script").key, context);
  const markers = await readOptionalJsonObject<ChapterMarkersPayload>(storage, links.find((link) => link.role === "chapter_markers")?.key, context);
  const sourcesPayload = await readOptionalJsonObject<{ readonly sources?: unknown }>(storage, links.find((link) => link.role === "sources")?.key, context);
  const durationSeconds = roundedDurationSeconds(
    positiveNumber(markers?.durationSeconds)
      ?? estimateDurationSeconds(script.chapters, script.wordsPerMinute)
  );

  return parseStory({
    id: storyId,
    title: script.title,
    subtitle: subtitleFor(job),
    kind: job.request.kind,
    subject: job.request.subject,
    synopsis: script.synopsis,
    targetDurationMinutes: script.targetDurationMinutes || job.request.targetDurationMinutes,
    estimatedDurationSeconds: durationSeconds,
    createdAt: job.createdAt,
    chapters: script.chapters.map((chapter) => chapterForScript(chapter, script.wordsPerMinute, markers)),
    sources: sourcesFor(sourcesPayload?.sources, script),
    assets: await assetsFor(links, storage, context, storyId, durationSeconds)
  });
}

async function findCompletedStoryJob(jobStore: JobStore, storyId: string): Promise<GenerationJob | undefined> {
  return (await jobStore.list()).find((job) => (
    job.status === "completed" &&
    (job.storyId === storyId || storyIdForJob(job.id) === storyId)
  ));
}

function readAssetAccessLinks(assetAccess: Record<string, unknown>): readonly AssetAccessLink[] {
  return Array.isArray(assetAccess.links)
    ? assetAccess.links.flatMap(readAssetAccessLink)
    : [];
}

function readAssetAccessLink(input: unknown): readonly AssetAccessLink[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return [];
  }

  const record = input as Record<string, unknown>;
  if (typeof record.role !== "string" || typeof record.key !== "string" || typeof record.mimeType !== "string") {
    return [];
  }

  return [{
    role: record.role,
    key: record.key,
    mimeType: record.mimeType,
    sizeBytes: positiveNumber(record.sizeBytes),
    metadata: readRecord(record.metadata)
  }];
}

function requiredLink(links: readonly AssetAccessLink[], role: string): AssetAccessLink {
  const link = links.find((candidate) => candidate.role === role);
  if (!link) {
    throw new Error(`Completed generated story is missing ${role} asset`);
  }
  return link;
}

async function readJsonObject<T>(
  storage: StorageProvider,
  key: string,
  context: ProviderContext
): Promise<T> {
  const object = await storage.getObject(key, context);
  return JSON.parse(new TextDecoder().decode(object.bytes)) as T;
}

async function readOptionalJsonObject<T>(
  storage: StorageProvider,
  key: string | undefined,
  context: ProviderContext
): Promise<T | undefined> {
  if (!key) {
    return undefined;
  }
  return readJsonObject<T>(storage, key, context);
}

function chapterForScript(
  chapter: ScriptChapter,
  wordsPerMinute: number,
  markers: ChapterMarkersPayload | undefined
): Story["chapters"][number] {
  const markerDuration = markers?.markers.find((marker) => marker.chapterId === chapter.id)?.durationSeconds;
  return {
    id: chapter.id,
    index: chapter.index,
    title: chapter.title,
    summary: chapter.summary,
    estimatedDurationSeconds: roundedDurationSeconds(positiveNumber(markerDuration)
      ?? estimateDurationSeconds([chapter], wordsPerMinute)),
    transcript: chapter.text,
    sourceIds: chapter.sourceIds
  };
}

function sourcesFor(input: unknown, script: StoryScript): readonly SourceRecord[] {
  if (Array.isArray(input)) {
    const parsed = input.flatMap((source) => {
      try {
        return [parseSourceRecord(source)];
      } catch {
        return [];
      }
    });
    if (parsed.length) {
      return parsed;
    }
  }

  const fromSourceMap = script.sourceMap.map((entry) => ({
    id: entry.sourceId,
    title: entry.title,
    publisher: "Sleepy History research dossier"
  }));
  if (fromSourceMap.length) {
    return fromSourceMap;
  }

  const sourceIds = [...new Set(script.chapters.flatMap((chapter) => chapter.sourceIds))];
  return sourceIds.map((sourceId) => ({
    id: sourceId,
    title: "Generated source dossier",
    publisher: "Sleepy History research dossier"
  }));
}

async function assetsFor(
  links: readonly AssetAccessLink[],
  storage: StorageProvider,
  context: ProviderContext,
  storyId: string,
  durationSeconds: number
): Promise<readonly Asset[]> {
  const assets = await Promise.all(links.flatMap((link) => {
    const kind = assetKindForRole(link.role);
    if (!kind) {
      return [];
    }
    return [assetForLink(link, storage, context, storyId, kind, durationSeconds)];
  }));

  return assets;
}

async function assetForLink(
  link: AssetAccessLink,
  storage: StorageProvider,
  context: ProviderContext,
  storyId: string,
  kind: AssetKind,
  storyDurationSeconds: number
): Promise<Asset> {
  return {
    id: `asset_${storyId}_${kind}`,
    kind,
    mimeType: link.mimeType,
    uri: await storage.getObjectUrl(link.key, context),
    sizeBytes: link.sizeBytes,
    width: positiveNumber(link.metadata?.width),
    height: positiveNumber(link.metadata?.height),
    durationSeconds: kind === "audio" ? roundedDurationSeconds(storyDurationSeconds) : undefined,
    checksum: typeof link.metadata?.checksum === "string" ? link.metadata.checksum : undefined
  };
}

function assetKindForRole(role: string): AssetKind | undefined {
  switch (role) {
    case "audio":
      return "audio";
    case "cover_full":
      return "cover_full";
    case "cover_thumbnail":
      return "cover_thumbnail";
    case "cover_placeholder":
      return "placeholder";
    case "transcript":
      return "transcript";
    case "sources":
      return "sources";
    default:
      return undefined;
  }
}

function estimateDurationSeconds(chapters: readonly Pick<ScriptChapter, "estimatedWords">[], wordsPerMinute: number): number {
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.estimatedWords, 0);
  const safeWordsPerMinute = positiveNumber(wordsPerMinute) ?? 130;
  return Math.max(1, Math.round(totalWords / safeWordsPerMinute * 60));
}

function roundedDurationSeconds(input: number): number {
  return Math.max(1, Math.round(input));
}

function subtitleFor(job: GenerationJob): string | undefined {
  const parts = [job.request.era, job.request.location].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(", ") : undefined;
}

function positiveNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) && input > 0 ? input : undefined;
}

function readRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function storyIdForJob(jobId: string): string {
  return jobId.replace(/^job_/, "story_");
}
