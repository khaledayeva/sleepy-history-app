import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleWavChapterFiles } from "./audioAssembly.js";
import { attachContentReviewToJob, rewriteOverlyIntensePassages, reviewGenerationRequest, reviewStoryScript } from "./contentReview.js";
import { buildCoverArtPrompt } from "./coverArtPrompt.js";
import type { FileDurableQueue } from "./durableQueue.js";
import { createModeratedCoverArt } from "./imageModeration.js";
import { createImageVariants, imageVariantStorageKey } from "./imageVariants.js";
import type { JobStore } from "./jobStore.js";
import type {
  ImageProvider,
  ProviderContext,
  ProviderQuotaDetails,
  ResearchProvider,
  StoredObjectResult,
  StorageProvider,
  StoryScript,
  VoiceProvider,
  WriterProgressEvent,
  WriterProvider
} from "./providers.js";
import { ProviderQuotaExceededError } from "./providers.js";
import type { GenerationJob } from "./schemas.js";
import { StoryScriptValidationError } from "./storyScriptValidation.js";

export interface GenerationStateMachineProviders {
  readonly research: ResearchProvider;
  readonly writer: WriterProvider;
  readonly voice: VoiceProvider;
  readonly image: ImageProvider;
  readonly storage: StorageProvider;
}

export interface GenerationStateMachineOptions {
  readonly queue: FileDurableQueue;
  readonly jobStore: JobStore;
  readonly providers: GenerationStateMachineProviders;
  readonly now?: () => string;
  readonly runningJobStaleAfterMs?: number;
}

export interface GenerationRunResult {
  readonly processed: boolean;
  readonly jobId?: string;
  readonly finalStatus?: GenerationJob["status"];
  readonly errorMessage?: string;
}

export interface GenerationJobDeletionResult {
  readonly deleted: true;
  readonly jobId: string;
  readonly deletedRemoteAssetKeys: readonly string[];
}

export class GenerationStateMachine {
  private readonly now: () => string;

  constructor(private readonly options: GenerationStateMachineOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async runNext(): Promise<GenerationRunResult> {
    const item = await this.options.queue.claimNext(this.now(), {
      runningStaleAfterMs: this.options.runningJobStaleAfterMs
    });
    if (!item) {
      return {
        processed: false
      };
    }

    return this.runJob(item.jobId);
  }

  async runJob(jobId: string): Promise<GenerationRunResult> {
    const job = await this.requireJob(jobId);
    if (job.status === "canceled") {
      await this.options.queue.checkpointStage(jobId, "canceled", 100, this.now(), "Canceled");
      return {
        processed: true,
        jobId,
        finalStatus: "canceled"
      };
    }

    let narrationTempDir: string | undefined;

    try {
      const requestReview = reviewGenerationRequest(job.request, this.now);
      if (requestReview.reviewStatus === "blocked") {
        await this.options.jobStore.update(jobId, (current) => attachContentReviewToJob(current, requestReview));
        throw new Error("Content review failed before provider work: blocked");
      }

      const context = this.context(jobId, "researching");
      const canceledBeforeResearch = await this.stopIfCanceled(jobId);
      if (canceledBeforeResearch) {
        return canceledBeforeResearch;
      }
      await this.options.queue.checkpointStage(jobId, "researching", 10, this.now(), "Building research dossier");
      const dossier = await this.options.providers.research.buildDossier(job.request, context);
      const canceledAfterResearch = await this.stopIfCanceled(jobId);
      if (canceledAfterResearch) {
        return canceledAfterResearch;
      }

      const canceledBeforeWriting = await this.stopIfCanceled(jobId);
      if (canceledBeforeWriting) {
        return canceledBeforeWriting;
      }
      await this.options.queue.checkpointStage(jobId, "outlining", 25, this.now(), "Planning story shape");
      await this.options.queue.checkpointStage(jobId, "writing", 45, this.now(), "Writing chapter transcripts");
      const script = await this.options.providers.writer.writeScript(dossier, job.request, this.writerContext(jobId));
      const canceledAfterWriting = await this.stopIfCanceled(jobId);
      if (canceledAfterWriting) {
        return canceledAfterWriting;
      }

      const canceledBeforeReview = await this.stopIfCanceled(jobId);
      if (canceledBeforeReview) {
        return canceledBeforeReview;
      }
      await this.options.queue.checkpointStage(jobId, "reviewing", 60, this.now(), "Reviewing safety and originality");
      const reviewedScript = await this.reviewAndStore(jobId, job, dossier, script);
      const canceledAfterReview = await this.stopIfCanceled(jobId);
      if (canceledAfterReview) {
        return canceledAfterReview;
      }

      const canceledBeforeVoicing = await this.stopIfCanceled(jobId);
      if (canceledBeforeVoicing) {
        return canceledBeforeVoicing;
      }
      await this.options.queue.checkpointStage(jobId, "voicing", 72, this.now(), "Narrating chapters");
      narrationTempDir = await mkdtemp(join(tmpdir(), "sleepy-history-voice-"));
      const narrationFiles: {
        readonly chapter: StoryScript["chapters"][number];
        readonly filePath: string;
      }[] = [];
      for (const chapter of reviewedScript.chapters) {
        const canceledBeforeChapter = await this.stopIfCanceled(jobId);
        if (canceledBeforeChapter) {
          return canceledBeforeChapter;
        }
        const asset = await this.options.providers.voice.narrateChapter({
          storyId: storyIdForJob(jobId),
          chapter,
          voiceId: job.request.voiceId ?? "calm_narrator_01"
        }, this.context(jobId, `voicing:${chapter.id}`));
        if (!asset.bytes) {
          throw new Error(`Missing WAV bytes for chapter audio: ${chapter.id}`);
        }
        const filePath = join(narrationTempDir, audioFileNameForChapter(chapter.id));
        await writeFile(filePath, asset.bytes);
        const canceledAfterChapter = await this.stopIfCanceled(jobId);
        if (canceledAfterChapter) {
          return canceledAfterChapter;
        }
        narrationFiles.push({ chapter, filePath });
        await this.options.queue.checkpointAudioChunk({
          jobId,
          chapterId: chapter.id,
          chunkId: `${chapter.id}_audio`,
          assetId: asset.id,
          completedAt: this.now()
        });
      }

      const canceledBeforeImaging = await this.stopIfCanceled(jobId);
      if (canceledBeforeImaging) {
        return canceledBeforeImaging;
      }
      await this.options.queue.checkpointStage(jobId, "imaging", 84, this.now(), "Creating cover art");
      const coverPrompt = buildCoverArtPrompt({
        metadata: {
          kind: job.request.kind,
          title: reviewedScript.title,
          subject: job.request.subject,
          era: job.request.era,
          location: job.request.location,
          perspective: job.request.perspective,
          synopsis: reviewedScript.synopsis
        },
        script: reviewedScript
      });
      const imageGeneration = await createModeratedCoverArt(this.options.providers.image, {
        storyId: storyIdForJob(jobId),
        title: reviewedScript.title,
        subject: job.request.subject,
        prompt: coverPrompt.prompt
      }, this.context(jobId, "imaging"));
      const canceledAfterImaging = await this.stopIfCanceled(jobId);
      if (canceledAfterImaging) {
        return canceledAfterImaging;
      }
      const coverArtAsset = imageGeneration.asset;
      if (!coverArtAsset.bytes) {
        throw new Error("Missing cover art bytes");
      }
      const coverVariants = createImageVariants(coverArtAsset);

      const canceledBeforeAssembly = await this.stopIfCanceled(jobId);
      if (canceledBeforeAssembly) {
        return canceledBeforeAssembly;
      }
      await this.options.queue.checkpointStage(jobId, "assembling", 94, this.now(), "Assembling story package");
      const assembledAudio = await assembleWavChapterFiles(
        narrationFiles.map(({ chapter, filePath }) => ({
          chapterId: chapter.id,
          title: chapter.title,
          filePath
        })),
        join(narrationTempDir, "assembled.wav")
      );
      const audioStorageMetadata = {
        durationSeconds: String(assembledAudio.durationSeconds),
        sampleRate: String(assembledAudio.sampleRate),
        channelCount: String(assembledAudio.channelCount),
        bitsPerSample: String(assembledAudio.bitsPerSample)
      };
      const audioStorageKey = `stories/${storyIdForJob(jobId)}/audio.wav`;
      const storedAudio = this.options.providers.storage.putObjectFile
        ? await this.options.providers.storage.putObjectFile({
          key: audioStorageKey,
          mimeType: assembledAudio.mimeType,
          filePath: assembledAudio.filePath,
          metadata: audioStorageMetadata
        }, this.context(jobId, "assembling"))
        : await this.options.providers.storage.putObject({
          key: audioStorageKey,
          mimeType: assembledAudio.mimeType,
          bytes: await readFile(assembledAudio.filePath),
          metadata: audioStorageMetadata
        }, this.context(jobId, "assembling"));
      const storedCoverVariants = await Promise.all(coverVariants.map(async (variant) => ({
        variant,
        stored: await this.options.providers.storage.putObject({
          key: imageVariantStorageKey(storyIdForJob(jobId), variant.role),
          mimeType: variant.asset.mimeType,
          bytes: variant.asset.bytes ?? new Uint8Array(),
          metadata: {
            role: variant.role,
            kind: variant.asset.kind,
            width: String(variant.asset.width ?? ""),
            height: String(variant.asset.height ?? ""),
            checksum: variant.asset.checksum ?? "",
            targetWidth: String(variant.targetWidth),
            targetHeight: String(variant.targetHeight)
          }
        }, this.context(jobId, "assembling"))
      })));
      const storedMarkers = await this.options.providers.storage.putObject({
        key: `stories/${storyIdForJob(jobId)}/chapter-markers.json`,
        mimeType: "application/json",
        bytes: new TextEncoder().encode(JSON.stringify({
          mimeType: assembledAudio.mimeType,
          durationSeconds: assembledAudio.durationSeconds,
          sampleRate: assembledAudio.sampleRate,
          channelCount: assembledAudio.channelCount,
          bitsPerSample: assembledAudio.bitsPerSample,
          markers: assembledAudio.markers
        }))
      }, this.context(jobId, "assembling"));
      const storedTranscript = await this.options.providers.storage.putObject({
        key: `stories/${storyIdForJob(jobId)}/transcript.json`,
        mimeType: "application/json",
        bytes: new TextEncoder().encode(JSON.stringify({
          storyId: storyIdForJob(jobId),
          title: reviewedScript.title,
          chapters: reviewedScript.chapters.map((chapter) => ({
            id: chapter.id,
            index: chapter.index,
            title: chapter.title,
            text: chapter.text
          }))
        }))
      }, this.context(jobId, "assembling"));
      const storedSources = await this.options.providers.storage.putObject({
        key: `stories/${storyIdForJob(jobId)}/sources.json`,
        mimeType: "application/json",
        bytes: new TextEncoder().encode(JSON.stringify({
          storyId: storyIdForJob(jobId),
          sources: dossier.sources,
          sourceMap: reviewedScript.sourceMap
        }))
      }, this.context(jobId, "assembling"));
      const storedScript = await this.options.providers.storage.putObject({
        key: `stories/${storyIdForJob(jobId)}/script.json`,
        mimeType: "application/json",
        bytes: new TextEncoder().encode(JSON.stringify(reviewedScript))
      }, this.context(jobId, "assembling"));
      const assetAccess = await this.createAssetAccessManifest(jobId, [
        { role: "audio", stored: storedAudio },
        ...storedCoverVariants.map(({ variant, stored }) => ({
          role: `cover_${variant.role}`,
          stored,
          metadata: {
            variantRole: variant.role,
            assetId: variant.asset.id,
            kind: variant.asset.kind,
            width: variant.asset.width,
            height: variant.asset.height,
            checksum: variant.asset.checksum
          }
        })),
        { role: "chapter_markers", stored: storedMarkers },
        { role: "transcript", stored: storedTranscript },
        { role: "sources", stored: storedSources },
        { role: "script", stored: storedScript }
      ]);
      const canceledAfterAssembly = await this.stopIfCanceled(jobId);
      if (canceledAfterAssembly) {
        await this.deleteRemoteAssetKeys(jobId, assetAccessManifestKeys(assetAccess));
        return canceledAfterAssembly;
      }

      await this.options.queue.checkpointStage(jobId, "completed", 100, this.now(), "Completed");
      await this.options.jobStore.update(jobId, (current) => ({
        ...current,
        storyId: storyIdForJob(jobId),
        metadata: {
          ...current.metadata,
          assetAccess,
          imageGeneration: {
            status: imageGeneration.metadata.status,
            reviewStatus: imageGeneration.metadata.reviewStatus,
            fallbackReason: imageGeneration.metadata.fallbackReason,
            attempts: imageGeneration.metadata.attempts,
            retryCount: imageGeneration.metadata.retryCount,
            providerName: imageGeneration.metadata.providerName,
            errors: imageGeneration.metadata.errors,
            variants: coverVariants.map((variant) => ({
              role: variant.role,
              assetId: variant.asset.id,
              kind: variant.asset.kind,
              contentType: variant.asset.mimeType,
              width: variant.asset.width,
              height: variant.asset.height,
              sizeBytes: variant.asset.sizeBytes,
              checksum: variant.asset.checksum,
              storageKey: imageVariantStorageKey(storyIdForJob(jobId), variant.role)
            }))
          }
        },
        updatedAt: this.now()
      }));

      return {
        processed: true,
        jobId,
        finalStatus: "completed"
      };
    } catch (error) {
      const message = generationFailureMessage(error);
      const code = generationFailureCode(error);
      if (error instanceof StoryScriptValidationError) {
        await this.options.jobStore.update(jobId, (current) => ({
          ...current,
          metadata: {
            ...current.metadata,
            writerDiagnostics: error.diagnostics as unknown as Record<string, unknown>
          },
          updatedAt: this.now()
        }));
      }
      await this.options.queue.checkpointStage(jobId, "failed", 100, this.now(), message);
      await this.options.jobStore.update(jobId, (current) => ({
        ...current,
        error: {
          code,
          message,
          retryable: true,
          ...(providerQuotaDetails(error) ? { details: providerQuotaDetails(error) } : {})
        },
        updatedAt: this.now()
      }));

      return {
        processed: true,
        jobId,
        finalStatus: "failed",
        errorMessage: message
      };
    } finally {
      if (narrationTempDir) {
        await rm(narrationTempDir, { recursive: true, force: true });
      }
    }
  }

  async cancelJob(jobId: string, reason = "Canceled"): Promise<GenerationJob> {
    const job = await this.requireJob(jobId);
    if (job.status === "completed") {
      throw new Error(`Completed jobs cannot be canceled: ${jobId}`);
    }

    await this.options.queue.checkpointStage(jobId, "canceled", 100, this.now(), reason);
    return this.requireJob(jobId);
  }

  async retryJob(jobId: string): Promise<GenerationJob> {
    const job = await this.requireJob(jobId);
    if (job.status !== "failed" && job.status !== "canceled") {
      throw new Error(`Only failed or canceled jobs can be retried: ${jobId}`);
    }
    if (job.metadata?.assetAccess) {
      throw new Error(`Jobs with generated assets must be deleted before retrying: ${jobId}`);
    }

    return this.options.queue.retryJob(jobId, this.now());
  }

  async deleteJob(jobId: string): Promise<GenerationJobDeletionResult | undefined> {
    const job = await this.options.jobStore.get(jobId);
    if (!job) {
      return undefined;
    }

    const deletedRemoteAssetKeys = assetAccessKeys(job);
    await this.deleteRemoteAssetKeys(jobId, deletedRemoteAssetKeys);

    await this.options.queue.deleteJob(jobId);

    return {
      deleted: true,
      jobId,
      deletedRemoteAssetKeys
    };
  }

  private async reviewAndStore(
    jobId: string,
    job: GenerationJob,
    dossier: Awaited<ReturnType<ResearchProvider["buildDossier"]>>,
    script: StoryScript
  ): Promise<StoryScript> {
    const review = reviewStoryScript(job.request, dossier, script, this.now);
    const reviewedScript = review.reviewStatus === "rewrite_required" ? rewriteOverlyIntensePassages(script, review) : script;
    const finalReview = review.reviewStatus === "rewrite_required"
      ? reviewStoryScript(job.request, dossier, reviewedScript, this.now)
      : review;
    await this.options.jobStore.update(jobId, (current) => attachContentReviewToJob(current, finalReview));

    if (finalReview.reviewStatus === "blocked" || finalReview.reviewStatus === "rewrite_required") {
      throw new Error(`Content review failed: ${finalReview.reviewStatus}`);
    }

    return reviewedScript;
  }

  private async requireJob(jobId: string): Promise<GenerationJob> {
    const job = await this.options.jobStore.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    return job;
  }

  private async stopIfCanceled(jobId: string): Promise<GenerationRunResult | undefined> {
    const current = await this.options.jobStore.get(jobId);
    if (current?.status !== "canceled") {
      return undefined;
    }

    await this.options.queue.checkpointStage(
      jobId,
      "canceled",
      100,
      this.now(),
      current.progress.message ?? "Canceled"
    );
    return {
      processed: true,
      jobId,
      finalStatus: "canceled"
    };
  }

  private async deleteRemoteAssetKeys(jobId: string, keys: readonly string[]): Promise<void> {
    const context = this.context(jobId, "delete");
    for (const key of keys) {
      await this.options.providers.storage.deleteObject(key, context);
    }
  }

  private context(jobId: string, stage: string): ProviderContext {
    return {
      jobId,
      idempotencyKey: `sleepy-history:${jobId}:${stage}`
    };
  }

  private writerContext(jobId: string): ProviderContext {
    return {
      ...this.context(jobId, "writing"),
      onWriterProgress: (event) => this.checkpointWriterProgress(jobId, event)
    };
  }

  private async checkpointWriterProgress(jobId: string, event: WriterProgressEvent): Promise<void> {
    await this.options.queue.checkpointStage(
      jobId,
      "writing",
      writerProgressPercent(event),
      this.now(),
      event.message,
      writerProgressSubstage(event)
    );
  }

  private async createAssetAccessManifest(
    jobId: string,
    assets: readonly {
      readonly role: string;
      readonly stored: StoredObjectResult;
      readonly metadata?: Record<string, unknown>;
    }[]
  ): Promise<Record<string, unknown>> {
    const context = this.context(jobId, "asset-access");
    const generatedAt = this.now();
    const links = await Promise.all(assets.map(async ({ role, stored, metadata }) => ({
      role,
      key: stored.key,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      ...(metadata ? { metadata } : {}),
      url: await this.options.providers.storage.getObjectUrl(stored.key, context)
    })));

    return {
      storyId: storyIdForJob(jobId),
      generatedAt,
      links
    };
  }
}

function generationFailureCode(error: unknown): string {
  return error instanceof ProviderQuotaExceededError ? "provider_quota_exceeded" : "generation_failed";
}

function generationFailureMessage(error: unknown): string {
  if (error instanceof ProviderQuotaExceededError) {
    return error.message;
  }

  return error instanceof Error ? error.message : "Generation failed";
}

function providerQuotaDetails(error: unknown): Record<string, string | number | boolean> | undefined {
  if (!(error instanceof ProviderQuotaExceededError)) {
    return undefined;
  }

  return scalarQuotaDetails(error.details);
}

function scalarQuotaDetails(details: ProviderQuotaDetails): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(details).filter((entry): entry is [string, string | number | boolean] => {
      const value = entry[1];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    })
  );
}

function writerProgressPercent(event: WriterProgressEvent): number {
  if (event.phase === "plan") {
    return event.chapterCount ? 30 : 27;
  }
  if (event.phase === "complete") {
    return 58;
  }

  const chapterCount = event.chapterCount && event.chapterCount > 0 ? event.chapterCount : 1;
  const chapterIndex = event.chapterIndex && event.chapterIndex > 0 ? event.chapterIndex : 1;
  const base = event.phase === "repair" ? 31 : 30;
  return Math.min(57, base + Math.round(chapterIndex / chapterCount * 26));
}

function writerProgressSubstage(event: WriterProgressEvent): string {
  if (event.phase === "plan") {
    return event.chapterCount ? "plan_complete" : "plan";
  }
  if (event.phase === "complete") {
    return "complete";
  }

  const chapterId = event.chapterId ?? `chapter_${String(event.chapterIndex ?? 0).padStart(2, "0")}`;
  return event.phase === "repair" ? `${chapterId}_repair` : chapterId;
}

function storyIdForJob(jobId: string): string {
  return jobId.replace(/^job_/, "story_");
}

function audioFileNameForChapter(chapterId: string): string {
  return `${chapterId.replace(/[^a-zA-Z0-9_-]/g, "_")}.wav`;
}

function assetAccessKeys(job: GenerationJob): readonly string[] {
  const assetAccess = job.metadata?.assetAccess;
  if (!assetAccess) {
    return [];
  }

  return assetAccessManifestKeys(assetAccess);
}

function assetAccessManifestKeys(assetAccess: Record<string, unknown>): readonly string[] {
  const links = assetAccess.links;
  if (!Array.isArray(links)) {
    return [];
  }

  return [...new Set(links.flatMap((link) => {
    if (typeof link !== "object" || link === null || !("key" in link)) {
      return [];
    }

    const key = (link as { readonly key?: unknown }).key;
    return typeof key === "string" && key.length > 0 ? [key] : [];
  }))];
}
