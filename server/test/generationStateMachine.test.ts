import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { inspectWav } from "../src/audioAssembly.js";
import { FileDurableQueue } from "../src/durableQueue.js";
import { GenerationStateMachine } from "../src/generationStateMachine.js";
import { createGenerationRequest } from "../src/generationRequests.js";
import { FileJobStore } from "../src/jobStore.js";
import { OpusScriptWriterProvider } from "../src/opusScriptWriterProvider.js";
import {
  MockImageProvider,
  MockResearchProvider,
  MockStorageProvider,
  MockVoiceProvider,
  MockWriterProvider,
  ProviderQuotaExceededError
} from "../src/providers.js";
import type { ProviderContext, StoredObject, StoredObjectResult } from "../src/providers.js";
import type { GenerationJob } from "../src/schemas.js";

describe("generation state machine", () => {
  it("advances a durable worker job through the full generation lifecycle", async () => {
    const harness = await stateMachineHarness();
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a lamp maker in medieval Cairo",
      voiceId: "calm_narrator_01"
    });

    await harness.queue.createJob(request, "job_state_machine", "2026-05-10T02:10:00.000Z");
    const initialJob = await harness.jobStore.get("job_state_machine");
    const result = await harness.machine.runNext();
    const completedJob = await harness.jobStore.get("job_state_machine");
    const queueItem = (await harness.queue.list()).find((item) => item.jobId === "job_state_machine");
    const stages = queueItem?.stageCheckpoints.map((checkpoint) => checkpoint.stage) ?? [];
    const audioObject = harness.storage.recordedObjects.get("stories/story_state_machine/audio.wav");
    const coverObject = harness.storage.recordedObjects.get("stories/story_state_machine/cover.png");
    const thumbnailObject = harness.storage.recordedObjects.get("stories/story_state_machine/cover-thumbnail.png");
    const placeholderObject = harness.storage.recordedObjects.get("stories/story_state_machine/cover-placeholder.png");
    const markersObject = harness.storage.recordedObjects.get("stories/story_state_machine/chapter-markers.json");
    const transcriptObject = harness.storage.recordedObjects.get("stories/story_state_machine/transcript.json");
    const sourcesObject = harness.storage.recordedObjects.get("stories/story_state_machine/sources.json");

    assert.equal(initialJob?.status, "queued");
    assert.equal(result.finalStatus, "completed");
    assert.equal(completedJob?.status, "completed");
    assert.equal(completedJob?.storyId, "story_state_machine");
    assert.equal(completedJob?.metadata?.contentReview?.review_status, "passed");
    assert.equal(completedJob?.metadata?.imageGeneration?.status, "generated");
    assert.equal(completedJob?.metadata?.imageGeneration?.retryCount, 0);
    assert.deepEqual(stages, [
      "researching",
      "outlining",
      "writing",
      "reviewing",
      "voicing",
      "imaging",
      "assembling",
      "completed"
    ]);
    assert.equal(queueItem?.audioChunkCheckpoints.length, 8);
    assert.equal(queueItem?.status, "completed");
    assert.ok(audioObject);
    assert.equal(audioObject.mimeType, "audio/wav");
    const audioInspection = inspectWav(audioObject.bytes);
    assert.equal(audioInspection.format, "wav");
    assert.equal(audioInspection.durationSeconds, 56);
    assert.equal(coverObject?.mimeType, "image/png");
    assert.equal(coverObject?.metadata?.role, "full");
    assert.equal(coverObject?.metadata?.width, "1536");
    assert.match(coverObject?.metadata?.checksum ?? "", /^sha256:/);
    assert.equal(thumbnailObject?.mimeType, "image/png");
    assert.equal(thumbnailObject?.metadata?.role, "thumbnail");
    assert.equal(thumbnailObject?.metadata?.width, "320");
    assert.equal(placeholderObject?.mimeType, "image/png");
    assert.equal(placeholderObject?.metadata?.role, "placeholder");
    assert.equal(placeholderObject?.metadata?.width, "32");
    assert.equal(transcriptObject?.mimeType, "application/json");
    assert.equal(sourcesObject?.mimeType, "application/json");
    assert.ok(markersObject);
    const markersPayload = JSON.parse(new TextDecoder().decode(markersObject.bytes)) as {
      durationSeconds: number;
      markers: readonly { chapterId: string; startSeconds: number; durationSeconds: number }[];
    };
    assert.equal(markersPayload.durationSeconds, audioInspection.durationSeconds);
    assert.equal(markersPayload.markers.length, 8);
    assert.deepEqual(markersPayload.markers[0], {
      chapterId: "chapter_01",
      title: "The Day Settles",
      startSeconds: 0,
      durationSeconds: 7
    });
    assert.equal(markersPayload.markers[7]?.startSeconds, 49);
    const assetLinks = completedJob?.metadata?.assetAccess?.links as { readonly role: string; readonly url: string }[] | undefined;
    assert.ok(assetLinks);
    assert.deepEqual(assetLinks.map((link) => link.role).sort(), [
      "audio",
      "chapter_markers",
      "cover_full",
      "cover_placeholder",
      "cover_thumbnail",
      "script",
      "sources",
      "transcript"
    ]);
    const imageVariants = completedJob?.metadata?.imageGeneration?.variants as {
      readonly role: string;
      readonly contentType: string;
      readonly width: number;
      readonly checksum: string;
    }[] | undefined;
    assert.ok(imageVariants);
    assert.deepEqual(imageVariants.map((variant) => variant.role), ["full", "thumbnail", "placeholder"]);
    assert.equal(imageVariants[0]?.contentType, "image/png");
    assert.equal(imageVariants[1]?.width, 320);
    assert.match(imageVariants[2]?.checksum ?? "", /^sha256:/);
    const audioLink = assetLinks.find((link) => link.role === "audio");
    assert.ok(audioLink);
    const resolvedAudio = await harness.storage.resolveObjectUrl(audioLink.url, { jobId: "job_state_machine" });
    assert.equal(resolvedAudio.mimeType, "audio/wav");
  });

  it("passes stable idempotency keys to every provider boundary", async () => {
    const recorder = new ProviderContextRecorder();
    const storage = new RecordingContextStorageProvider(recorder, {
      signingSecret: "test-storage-signing-secret-32-bytes-minimum"
    });
    const harness = await stateMachineHarness({
      research: new RecordingContextResearchProvider(recorder),
      writer: new RecordingContextWriterProvider(recorder),
      voice: new RecordingContextVoiceProvider(recorder),
      image: new RecordingContextImageProvider(recorder),
      storage
    });
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a lamp maker in medieval Cairo",
      voiceId: "calm_narrator_01"
    });

    await harness.queue.createJob(request, "job_idempotency", "2026-05-10T02:10:00.000Z");
    const result = await harness.machine.runNext();

    assert.equal(result.finalStatus, "completed");
    assert.deepEqual(recorder.byBoundary.research, ["sleepy-history:job_idempotency:researching"]);
    assert.deepEqual(recorder.byBoundary.writer, ["sleepy-history:job_idempotency:writing"]);
    assert.deepEqual(
      recorder.byBoundary.voice,
      Array.from({ length: 8 }, (_value, index) =>
        `sleepy-history:job_idempotency:voicing:chapter_${String(index + 1).padStart(2, "0")}`
      )
    );
    assert.equal(recorder.byBoundary.image[0], "sleepy-history:job_idempotency:imaging:attempt-1");
    assert.deepEqual(
      [...new Set(recorder.byBoundary.storagePut)],
      ["sleepy-history:job_idempotency:assembling"]
    );
    assert.equal(recorder.byBoundary.storagePut.length, 8);
    assert.deepEqual(
      [...new Set(recorder.byBoundary.storageGetUrl)],
      ["sleepy-history:job_idempotency:asset-access"]
    );
    assert.equal(recorder.byBoundary.storageGetUrl.length, 8);
  });

  it("repairs undersized Opus transcripts through the state machine and records granular writing checkpoints", async () => {
    const writer = new OpusScriptWriterProvider({
      apiKey: "test-key",
      baseUrl: "https://anthropic.test/v1",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "")) as {
          readonly messages?: readonly { readonly content?: string }[];
        };
        const content = body.messages?.[0]?.content ?? "";
        const isPlan = content.includes("Do not include chapter transcript text");
        const isFirstChapter = content.includes("Chapter ID: chapter_01");
        const isRepair = content.includes("Previous chapter words:");

        return new Response(JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify(isPlan
                ? opusPlanFixture()
                : { text: repeatedTranscript(isFirstChapter && !isRepair ? 200 : 780) })
            }
          ]
        }), {
          status: 200
        });
      }
    });
    const harness = await stateMachineHarness({ writer });
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a scribe in Alexandria",
      era: "Ptolemaic Egypt",
      voiceId: "calm_narrator_01",
      targetDurationMinutes: 60
    });

    await harness.queue.createJob(request, "job_opus_repair_integration", "2026-05-10T02:10:00.000Z");
    const result = await harness.machine.runNext();
    const completedJob = await harness.jobStore.get("job_opus_repair_integration");
    const queueItem = (await harness.queue.list()).find((item) => item.jobId === "job_opus_repair_integration");
    const writingSubstages = queueItem?.stageCheckpoints
      .filter((checkpoint) => checkpoint.stage === "writing")
      .map((checkpoint) => checkpoint.substage)
      .filter(Boolean);

    assert.equal(result.finalStatus, "completed");
    assert.equal(completedJob?.status, "completed");
    assert.equal(completedJob?.metadata?.writerDiagnostics, undefined);
    assert.equal(queueItem?.audioChunkCheckpoints.length, 10);
    assert.deepEqual(writingSubstages, [
      "plan",
      "plan_complete",
      "chapter_01",
      "chapter_01_repair",
      "chapter_02",
      "chapter_03",
      "chapter_04",
      "chapter_05",
      "chapter_06",
      "chapter_07",
      "chapter_08",
      "chapter_09",
      "chapter_10",
      "complete"
    ]);
  });

  it("stores sanitized writer diagnostics when repaired draft scripts still miss duration", async () => {
    const writer = new OpusScriptWriterProvider({
      apiKey: "test-key",
      baseUrl: "https://anthropic.test/v1",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "")) as {
          readonly messages?: readonly { readonly content?: string }[];
        };
        const content = body.messages?.[0]?.content ?? "";

        return new Response(JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify(content.includes("Do not include chapter transcript text")
                ? opusPlanFixture()
                : { text: repeatedTranscript(100) })
            }
          ]
        }), {
          status: 200
        });
      }
    });
    const harness = await stateMachineHarness({ writer });
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a scribe in Alexandria",
      era: "Ptolemaic Egypt",
      voiceId: "calm_narrator_01",
      targetDurationMinutes: 60
    });

    await harness.queue.createJob(request, "job_writer_diagnostics", "2026-05-10T02:10:00.000Z");
    const result = await harness.machine.runNext();
    const failedJob = await harness.jobStore.get("job_writer_diagnostics");
    const diagnostics = failedJob?.metadata?.writerDiagnostics as {
      readonly issues?: readonly string[];
      readonly actualTotalWords?: number;
      readonly chapters?: readonly { readonly id?: string; readonly actualWords?: number; readonly targetWords?: number }[];
    } | undefined;

    assert.equal(result.finalStatus, "failed");
    assert.equal(failedJob?.status, "failed");
    assert.match(failedJob?.error?.message ?? "", /estimated duration falls outside tolerance/);
    assert.ok(diagnostics);
    assert.equal(diagnostics.actualTotalWords, 1000);
    assert.equal(diagnostics.chapters?.length, 10);
    assert.deepEqual(diagnostics.chapters?.[0], {
      id: "chapter_01",
      index: 1,
      title: "The First Lamp Is Lowered",
      targetWords: 780,
      actualWords: 100,
      deltaWords: -680,
      withinTolerance: false
    });
    assert.equal(JSON.stringify(diagnostics).includes("reed pen beside"), false);
  });

  it("marks provider failures as failed with retryable job errors", async () => {
    const harness = await stateMachineHarness({
      research: new FailingResearchProvider()
    });
    const request = createGenerationRequest({
      kind: "historical_figure",
      subject: "Marie Curie"
    });

    await harness.queue.createJob(request, "job_failure", "2026-05-10T02:10:00.000Z");
    const result = await harness.machine.runNext();
    const failedJob = await harness.jobStore.get("job_failure");
    const queueItem = (await harness.queue.list()).find((item) => item.jobId === "job_failure");

    assert.equal(result.finalStatus, "failed");
    assert.equal(failedJob?.status, "failed");
    assert.equal(failedJob?.error?.code, "generation_failed");
    assert.equal(failedJob?.error?.retryable, true);
    assert.equal(queueItem?.status, "failed");
  });

  it("marks provider quota failures with a clean retryable job error", async () => {
    const harness = await stateMachineHarness({
      voice: new QuotaExceededVoiceProvider()
    });
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a scribe in Alexandria",
      voiceId: "calm_narrator_01"
    });

    await harness.queue.createJob(request, "job_voice_quota", "2026-05-10T02:10:00.000Z");
    const result = await harness.machine.runNext();
    const failedJob = await harness.jobStore.get("job_voice_quota");

    assert.equal(result.finalStatus, "failed");
    assert.equal(failedJob?.status, "failed");
    assert.equal(failedJob?.error?.code, "provider_quota_exceeded");
    assert.equal(failedJob?.error?.retryable, true);
    assert.match(failedJob?.error?.message ?? "", /ElevenLabs quota exceeded/);
    assert.doesNotMatch(failedJob?.error?.message ?? "", /quota_exceeded|request_id|invalid_request/);
    assert.equal(failedJob?.error?.details?.provider, "elevenlabs");
    assert.equal(failedJob?.error?.details?.creditsRemaining, 979);
    assert.equal(failedJob?.error?.details?.creditsRequired, 984);
  });

  it("blocks disallowed requests before calling paid providers", async () => {
    const research = new RecordingResearchProvider();
    const harness = await stateMachineHarness({ research });
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "copy the Boring History for Sleep podcast exactly",
      perspective: "imitate the host's voice"
    });

    await harness.queue.createJob(request, "job_blocked_request", "2026-05-10T02:10:00.000Z");
    const result = await harness.machine.runNext();
    const failedJob = await harness.jobStore.get("job_blocked_request");
    const queueItem = (await harness.queue.list()).find((item) => item.jobId === "job_blocked_request");

    assert.equal(result.finalStatus, "failed");
    assert.equal(research.calls, 0);
    assert.equal(failedJob?.status, "failed");
    assert.equal(failedJob?.metadata?.contentReview?.review_status, "blocked");
    assert.equal(failedJob?.metadata?.contentReview?.prompt_policy_decision, "block");
    assert.match(failedJob?.error?.message ?? "", /before provider work/);
    assert.equal(queueItem?.status, "failed");
    assert.deepEqual(queueItem?.audioChunkCheckpoints, []);
    assert.equal(harness.storage.recordedObjects.size, 0);
  });

  it("completes with fallback cover art after image provider retry fails", async () => {
    const harness = await stateMachineHarness({
      image: new FailingImageProvider()
    });
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a cloth merchant in Aksum",
      voiceId: "calm_narrator_01"
    });

    await harness.queue.createJob(request, "job_image_fallback", "2026-05-10T02:10:00.000Z");
    const result = await harness.machine.runNext();
    const completedJob = await harness.jobStore.get("job_image_fallback");
    const coverObject = harness.storage.recordedObjects.get("stories/story_image_fallback/cover.png");

    assert.equal(result.finalStatus, "completed");
    assert.equal(completedJob?.status, "completed");
    assert.equal(completedJob?.metadata?.imageGeneration?.status, "fallback");
    assert.equal(completedJob?.metadata?.imageGeneration?.fallbackReason, "provider_failed_after_retry");
    assert.equal(completedJob?.metadata?.imageGeneration?.retryCount, 1);
    assert.equal(coverObject?.mimeType, "image/png");
  });

  it("resumes a running job after worker restart", async () => {
    const harness = await stateMachineHarness();
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a map maker in Song dynasty Hangzhou",
      voiceId: "calm_narrator_01"
    });

    await harness.queue.createJob(request, "job_resume_running", "2026-05-10T02:10:00.000Z");
    const claimed = await harness.queue.claimNext("2026-05-10T02:11:00.000Z");
    await harness.queue.checkpointStage("job_resume_running", "researching", 10, "2026-05-10T02:12:00.000Z", "Building research dossier");

    const restartedJobStore = new FileJobStore(harness.paths.jobStorePath);
    const restartedQueue = new FileDurableQueue(harness.paths.queuePath, restartedJobStore);
    const restartedMachine = new GenerationStateMachine({
      queue: restartedQueue,
      jobStore: restartedJobStore,
      providers: harness.providers,
      now: harness.now
    });
    const result = await restartedMachine.runNext();
    const completedJob = await restartedJobStore.get("job_resume_running");
    const queueItem = (await restartedQueue.list()).find((item) => item.jobId === "job_resume_running");

    assert.equal(claimed?.status, "running");
    assert.equal(claimed?.attempts, 1);
    assert.equal(result.finalStatus, "completed");
    assert.equal(completedJob?.status, "completed");
    assert.equal(queueItem?.attempts, 1);
    assert.equal(queueItem?.status, "completed");
  });

  it("can cancel queued jobs durably", async () => {
    const harness = await stateMachineHarness();
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a potter in Edo"
    });

    await harness.queue.createJob(request, "job_canceled", "2026-05-10T02:10:00.000Z");
    const canceled = await harness.machine.cancelJob("job_canceled", "User canceled");
    const queueItem = (await harness.queue.list()).find((item) => item.jobId === "job_canceled");

    assert.equal(canceled.status, "canceled");
    assert.equal(canceled.progress.message, "User canceled");
    assert.equal(queueItem?.status, "canceled");
  });

  it("keeps a running job canceled after provider work returns", async () => {
    let harness: Awaited<ReturnType<typeof stateMachineHarness>>;
    harness = await stateMachineHarness({
      research: new CancelingResearchProvider(async () => {
        await harness.machine.cancelJob("job_cancel_running", "User canceled while researching");
      })
    });
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a potter in Edo"
    });

    await harness.queue.createJob(request, "job_cancel_running", "2026-05-10T02:10:00.000Z");
    const result = await harness.machine.runNext();
    const canceledJob = await harness.jobStore.get("job_cancel_running");
    const queueItem = (await harness.queue.list()).find((item) => item.jobId === "job_cancel_running");

    assert.equal(result.finalStatus, "canceled");
    assert.equal(canceledJob?.status, "canceled");
    assert.equal(canceledJob?.progress.message, "User canceled while researching");
    assert.equal(queueItem?.status, "canceled");
    assert.equal(harness.storage.recordedObjects.size, 0);
  });

  it("cleans up remote assets when a job is canceled during assembly", async () => {
    let harness: Awaited<ReturnType<typeof stateMachineHarness>>;
    const storage = new CancelingStorageProvider(async () => {
      await harness.machine.cancelJob("job_cancel_assembly", "User canceled while assembling");
    }, {
      signingSecret: "test-storage-signing-secret-32-bytes-minimum"
    });
    harness = await stateMachineHarness({ storage });
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a paper maker in Samarkand",
      voiceId: "calm_narrator_01"
    });

    await harness.queue.createJob(request, "job_cancel_assembly", "2026-05-10T02:10:00.000Z");
    const result = await harness.machine.runNext();
    const canceledJob = await harness.jobStore.get("job_cancel_assembly");
    const queueItem = (await harness.queue.list()).find((item) => item.jobId === "job_cancel_assembly");

    assert.equal(result.finalStatus, "canceled");
    assert.equal(canceledJob?.status, "canceled");
    assert.equal(canceledJob?.storyId, undefined);
    assert.equal(queueItem?.status, "canceled");
    assert.equal(storage.recordedObjects.size, 0);
    assert.equal(storage.deletedKeys.length, 8);
  });

  it("retries failed jobs by resetting durable progress", async () => {
    const harness = await stateMachineHarness({
      research: new FailingResearchProvider()
    });
    const request = createGenerationRequest({
      kind: "historical_figure",
      subject: "Marie Curie"
    });

    await harness.queue.createJob(request, "job_retryable", "2026-05-10T02:10:00.000Z");
    await harness.machine.runNext();

    const retried = await harness.machine.retryJob("job_retryable");
    const queueItem = (await harness.queue.list()).find((item) => item.jobId === "job_retryable");

    assert.equal(retried.status, "queued");
    assert.equal(retried.progress.stage, "queued");
    assert.equal(retried.progress.message, "Queued for retry");
    assert.equal(retried.error, undefined);
    assert.equal(queueItem?.status, "queued");
    assert.deepEqual(queueItem?.stageCheckpoints, []);
    assert.deepEqual(queueItem?.audioChunkCheckpoints, []);
  });

  it("deletes completed jobs and their remote assets durably", async () => {
    const harness = await stateMachineHarness();
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a paper maker in Samarkand",
      voiceId: "calm_narrator_01"
    });

    await harness.queue.createJob(request, "job_delete_assets", "2026-05-10T02:10:00.000Z");
    await harness.machine.runNext();

    const completedJob = await harness.jobStore.get("job_delete_assets");
    const assetLinks = completedJob?.metadata?.assetAccess?.links as { readonly key: string }[] | undefined;
    assert.ok(assetLinks);
    assert.equal(assetLinks.length, 8);
    assert.equal(harness.storage.recordedObjects.size, 8);

    const result = await harness.machine.deleteJob("job_delete_assets");
    const deletedJob = await harness.jobStore.get("job_delete_assets");
    const deletedQueueItem = (await harness.queue.list()).find((item) => item.jobId === "job_delete_assets");

    assert.deepEqual(result, {
      deleted: true,
      jobId: "job_delete_assets",
      deletedRemoteAssetKeys: assetLinks.map((link) => link.key)
    });
    assert.equal(deletedJob, undefined);
    assert.equal(deletedQueueItem, undefined);
    assert.deepEqual([...harness.storage.recordedObjects.keys()], []);
    assert.deepEqual(harness.storage.deletedKeys, assetLinks.map((link) => link.key));
  });

  it("does not cancel or retry completed jobs with generated assets", async () => {
    const harness = await stateMachineHarness();
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a paper maker in Samarkand",
      voiceId: "calm_narrator_01"
    });

    await harness.queue.createJob(request, "job_completed_guard", "2026-05-10T02:10:00.000Z");
    await harness.machine.runNext();

    await assert.rejects(
      () => harness.machine.cancelJob("job_completed_guard", "Too late"),
      /Completed jobs cannot be canceled/
    );
    const completedJob = await harness.jobStore.get("job_completed_guard");

    assert.equal(completedJob?.status, "completed");
    assert.equal(completedJob?.storyId, "story_completed_guard");
    assert.ok(completedJob?.metadata?.assetAccess);

    await harness.jobStore.update("job_completed_guard", (job) => ({
      ...job,
      status: "canceled",
      progress: {
        stage: "canceled",
        percent: 100,
        message: "Legacy canceled completed job"
      }
    }));

    await assert.rejects(
      () => harness.machine.retryJob("job_completed_guard"),
      /Jobs with generated assets must be deleted before retrying/
    );
    assert.equal((await harness.jobStore.get("job_completed_guard"))?.metadata?.assetAccess !== undefined, true);
    assert.equal(harness.storage.recordedObjects.size, 8);
  });
});

async function stateMachineHarness(overrides: Partial<ConstructorParameters<typeof GenerationStateMachine>[0]["providers"]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sleepy-history-state-machine-"));
  const paths = {
    jobStorePath: join(directory, "jobs.json"),
    queuePath: join(directory, "queue.json")
  };
  const jobStore = new FileJobStore(paths.jobStorePath);
  const queue = new FileDurableQueue(paths.queuePath, jobStore);
  const storage = new RecordingStorageProvider({
    signingSecret: "test-storage-signing-secret-32-bytes-minimum"
  });
  let tick = 0;
  const providers = {
    research: new MockResearchProvider(),
    writer: new MockWriterProvider(),
    voice: new MockVoiceProvider(),
    image: new MockImageProvider(),
    storage,
    ...overrides
  };
  const now = () => `2026-05-10T02:${String(10 + tick++).padStart(2, "0")}:00.000Z`;
  const machine = new GenerationStateMachine({
    queue,
    jobStore,
    providers,
    now
  });

  return {
    paths,
    queue,
    jobStore,
    machine,
    providers,
    storage,
    now
  };
}

function opusPlanFixture(): unknown {
  const chapters = Array.from({ length: 10 }, (_value, index) => ({
    id: `chapter_${String(index + 1).padStart(2, "0")}`,
    index: index + 1,
    title: index === 0 ? "The First Lamp Is Lowered" : `A Quiet Table ${index + 1}`,
    checkpoint: "Follow one calm ordinary task in the scribe's evening routine.",
    summary: "A slow chapter with tools, lamplight, papyrus, and low-stakes historical texture.",
    continuitySummary: "Keep the same scribe, same evening, and same gentle closing rhythm.",
    estimatedWords: 780,
    sourceIds: ["source_a_scribe_in_alexandria"]
  }));

  return {
    title: "The Last Lamp in Alexandria",
    synopsis: "A calm bedtime story about a scribe ending an ordinary day.",
    storyBible: {
      premise: "Follow one ordinary scribe as the workday softens into evening.",
      narrativePointOfView: "quiet third-person bedtime narrator",
      toneGuidelines: ["slow", "gentle", "source-grounded"],
      historicalBoundaries: ["Use the research dossier cautiously."],
      pronunciationGuide: ["Alexandria", "Ptolemaic"]
    },
    targetDurationMinutes: 60,
    estimatedTotalWords: 7800,
    wordsPerMinute: 130,
    sourceMap: [
      {
        sourceId: "source_a_scribe_in_alexandria",
        title: "A scribe in Alexandria mock source",
        claimIds: ["claim_a_scribe_in_alexandria"],
        chapterIds: chapters.map((chapter) => chapter.id)
      }
    ],
    continuitySummary: "Keep each chapter drowsy, ordinary, and continuous.",
    chapters
  };
}

function repeatedTranscript(wordCount: number): string {
  const words = [
    "the",
    "scribe",
    "sets",
    "the",
    "reed",
    "pen",
    "beside",
    "soft",
    "papyrus",
    "while",
    "lamplight",
    "rests",
    "quietly",
    "over",
    "the",
    "table"
  ];

  return Array.from({ length: wordCount }, (_value, index) => words[index % words.length] ?? "quietly").join(" ");
}

class RecordingStorageProvider extends MockStorageProvider {
  readonly recordedObjects = new Map<string, StoredObject>();
  readonly deletedKeys: string[] = [];

  override async putObject(object: StoredObject, context: ProviderContext): Promise<StoredObjectResult> {
    this.recordedObjects.set(object.key, object);
    return super.putObject(object, context);
  }

  override async deleteObject(key: string, context: ProviderContext): Promise<void> {
    this.deletedKeys.push(key);
    this.recordedObjects.delete(key);
    return super.deleteObject(key, context);
  }
}

class CancelingStorageProvider extends RecordingStorageProvider {
  private didCancel = false;

  constructor(
    private readonly onFirstPut: () => Promise<void>,
    options: ConstructorParameters<typeof RecordingStorageProvider>[0]
  ) {
    super(options);
  }

  override async putObject(object: StoredObject, context: ProviderContext): Promise<StoredObjectResult> {
    const result = await super.putObject(object, context);
    if (!this.didCancel) {
      this.didCancel = true;
      await this.onFirstPut();
    }
    return result;
  }
}

class FailingResearchProvider extends MockResearchProvider {
  override async buildDossier(_request: GenerationJob["request"]): Promise<never> {
    throw new Error("research provider unavailable");
  }
}

class QuotaExceededVoiceProvider extends MockVoiceProvider {
  override async narrateChapter(): Promise<never> {
    throw new ProviderQuotaExceededError(
      "ElevenLabs quota exceeded. 979 credits remain. The next narration chunk needs 984 credits. Add credits in ElevenLabs, then retry this story.",
      {
        provider: "elevenlabs",
        status: 401,
        creditsRemaining: 979,
        creditsRequired: 984,
        requestId: "9561e658491a1e800f8f095d6e609819"
      }
    );
  }
}

type ProviderBoundary = "research" | "writer" | "voice" | "image" | "storagePut" | "storageGetUrl";

class ProviderContextRecorder {
  readonly byBoundary: Record<ProviderBoundary, string[]> = {
    research: [],
    writer: [],
    voice: [],
    image: [],
    storagePut: [],
    storageGetUrl: []
  };

  record(boundary: ProviderBoundary, context: ProviderContext): void {
    assert.ok(context.idempotencyKey, `${boundary} idempotency key is required`);
    this.byBoundary[boundary].push(context.idempotencyKey);
  }
}

class RecordingContextResearchProvider extends MockResearchProvider {
  constructor(private readonly recorder: ProviderContextRecorder) {
    super();
  }

  override async buildDossier(request: GenerationJob["request"], context: ProviderContext) {
    this.recorder.record("research", context);
    return super.buildDossier(request, context);
  }
}

class RecordingContextWriterProvider extends MockWriterProvider {
  constructor(private readonly recorder: ProviderContextRecorder) {
    super();
  }

  override async writeScript(
    ...args: Parameters<MockWriterProvider["writeScript"]>
  ): ReturnType<MockWriterProvider["writeScript"]> {
    this.recorder.record("writer", args[2]);
    return super.writeScript(...args);
  }
}

class RecordingContextVoiceProvider extends MockVoiceProvider {
  constructor(private readonly recorder: ProviderContextRecorder) {
    super();
  }

  override async narrateChapter(
    ...args: Parameters<MockVoiceProvider["narrateChapter"]>
  ): ReturnType<MockVoiceProvider["narrateChapter"]> {
    this.recorder.record("voice", args[1]);
    return super.narrateChapter(...args);
  }
}

class RecordingContextImageProvider extends MockImageProvider {
  constructor(private readonly recorder: ProviderContextRecorder) {
    super();
  }

  override async createCoverArt(
    ...args: Parameters<MockImageProvider["createCoverArt"]>
  ): ReturnType<MockImageProvider["createCoverArt"]> {
    this.recorder.record("image", args[1]);
    return super.createCoverArt(...args);
  }
}

class RecordingContextStorageProvider extends RecordingStorageProvider {
  constructor(
    private readonly recorder: ProviderContextRecorder,
    options: ConstructorParameters<typeof RecordingStorageProvider>[0]
  ) {
    super(options);
  }

  override async putObject(object: StoredObject, context: ProviderContext): Promise<StoredObjectResult> {
    this.recorder.record("storagePut", context);
    return super.putObject(object, context);
  }

  override async getObjectUrl(key: string, context: ProviderContext): Promise<string> {
    this.recorder.record("storageGetUrl", context);
    return super.getObjectUrl(key, context);
  }
}

class RecordingResearchProvider extends MockResearchProvider {
  calls = 0;

  override async buildDossier(request: GenerationJob["request"], context: ProviderContext) {
    this.calls += 1;
    return super.buildDossier(request, context);
  }
}

class CancelingResearchProvider extends MockResearchProvider {
  constructor(private readonly onBuild: () => Promise<void>) {
    super();
  }

  override async buildDossier(request: GenerationJob["request"], context: ProviderContext) {
    await this.onBuild();
    return super.buildDossier(request, context);
  }
}

class FailingImageProvider extends MockImageProvider {
  override async createCoverArt(): Promise<never> {
    throw new Error("image provider unavailable");
  }
}
