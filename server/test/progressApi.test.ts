import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { hashDeviceToken } from "../src/auth.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { FileDurableQueue } from "../src/durableQueue.js";
import { GenerationStateMachine } from "../src/generationStateMachine.js";
import { createGenerationRequest } from "../src/generationRequests.js";
import { getGeneratedStory } from "../src/generatedStory.js";
import { FileJobStore } from "../src/jobStore.js";
import {
  MockImageProvider,
  MockResearchProvider,
  MockStorageProvider,
  MockVoiceProvider,
  MockWriterProvider
} from "../src/providers.js";
import type { ProviderContext, StoredObject, StoredObjectResult } from "../src/providers.js";
import { createApp, createInMemoryGenerationRuntime, type AppRuntime } from "../src/server.js";
import type { GenerationJob, Story } from "../src/schemas.js";

const ownerToken = "owner-device-token-progress-api-000000000000";
const authSecret = "test-device-token-hmac-secret-32-bytes";
const runningServers: ReturnType<typeof createApp>[] = [];

after(async () => {
  await Promise.all(runningServers.map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("authenticated progress and result APIs", () => {
  it("creates a guarded job, polls progress, and cancels it", async () => {
    const app = await startTestApp(enabledConfig(), createInMemoryGenerationRuntime());
    const createResponse = await postGenerationJob(app.baseURL);
    const createPayload = await createResponse.json() as CreateJobPayload;

    assert.equal(createResponse.status, 202);
    assert.match(createPayload.job.id, /^job_/);
    assert.equal(createPayload.job.status, "accepted");
    assert.equal(createPayload.job.generationStatus, "queued");
    assert.equal(createPayload.job.progress.stage, "queued");

    const statusResponse = await fetch(`${app.baseURL}/generation-jobs/${createPayload.job.id}`, {
      headers: authHeaders()
    });
    const statusPayload = await statusResponse.json() as JobPayload;

    assert.equal(statusResponse.status, 200);
    assert.equal(statusPayload.job.id, createPayload.job.id);
    assert.equal(statusPayload.job.progress.message, "Queued");

    const cancelResponse = await fetch(`${app.baseURL}/generation-jobs/${createPayload.job.id}/cancel`, {
      method: "POST",
      headers: authHeaders()
    });
    const cancelPayload = await cancelResponse.json() as JobPayload;

    assert.equal(cancelResponse.status, 200);
    assert.equal(cancelPayload.job.status, "canceled");
    assert.equal(cancelPayload.job.progress.percent, 100);
  });

  it("retries and deletes durable jobs and remote assets through authenticated lifecycle routes", async () => {
    const harness = await durableApiHarness();
    const app = await startTestApp(enabledConfig(), harness.runtime);
    const createResponse = await postGenerationJob(app.baseURL);
    const createPayload = await createResponse.json() as CreateJobPayload;
    const jobId = createPayload.job.id;

    await fetch(`${app.baseURL}/generation-jobs/${jobId}/cancel`, {
      method: "POST",
      headers: authHeaders()
    });

    const retryResponse = await fetch(`${app.baseURL}/generation-jobs/${jobId}/retry`, {
      method: "POST",
      headers: authHeaders()
    });
    const retryPayload = await retryResponse.json() as JobPayload;

    assert.equal(retryResponse.status, 200);
    assert.equal(retryPayload.job.status, "queued");
    assert.equal(retryPayload.job.progress.stage, "queued");
    assert.equal(retryPayload.job.progress.message, "Queued for retry");
    assert.equal((await harness.jobStore.get(jobId))?.status, "queued");
    assert.equal((await harness.queue.list()).find((item) => item.jobId === jobId)?.status, "queued");

    const activeRetryResponse = await fetch(`${app.baseURL}/generation-jobs/${jobId}/retry`, {
      method: "POST",
      headers: authHeaders()
    });
    const activeRetryPayload = await activeRetryResponse.json() as ApiErrorPayload;

    assert.equal(activeRetryResponse.status, 409);
    assert.equal(activeRetryPayload.error.code, "job_not_retryable");

    const completedRequest = createGenerationRequest({
      kind: "daily_life",
      subject: "a scribe closing the Library at Alexandria",
      targetDurationMinutes: 60,
      voiceId: "calm_narrator_01"
    });
    await harness.queue.createJob(completedRequest, "job_route_completed", "2026-05-10T17:25:00.000Z");
    await harness.machine.runJob("job_route_completed");
    assert.equal(harness.storage.recordedObjects.size, 8);

    const storyResponse = await fetch(`${app.baseURL}/stories/story_route_completed`, {
      headers: authHeaders()
    });
    const storyPayload = await storyResponse.json() as StoryPayload;

    assert.equal(storyResponse.status, 200);
    assert.equal(storyPayload.story.id, "story_route_completed");
    assert.equal(storyPayload.story.assets.some((asset) => asset.kind === "audio"), true);
    assert.equal(storyPayload.story.chapters.length, 8);

    const completedCancelResponse = await fetch(`${app.baseURL}/generation-jobs/job_route_completed/cancel`, {
      method: "POST",
      headers: authHeaders()
    });
    const completedCancelPayload = await completedCancelResponse.json() as ApiErrorPayload;

    assert.equal(completedCancelResponse.status, 409);
    assert.equal(completedCancelPayload.error.code, "job_not_cancelable");
    assert.equal((await harness.jobStore.get("job_route_completed"))?.status, "completed");

    const deleteResponse = await fetch(`${app.baseURL}/generation-jobs/job_route_completed`, {
      method: "DELETE",
      headers: authHeaders()
    });
    const deletePayload = await deleteResponse.json() as DeleteJobPayload;

    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(deletePayload, {
      deleted: true,
      jobId: "job_route_completed",
      deletedRemoteAssetKeys: [
        "stories/story_route_completed/audio.wav",
        "stories/story_route_completed/cover.png",
        "stories/story_route_completed/cover-thumbnail.png",
        "stories/story_route_completed/cover-placeholder.png",
        "stories/story_route_completed/chapter-markers.json",
        "stories/story_route_completed/transcript.json",
        "stories/story_route_completed/sources.json",
        "stories/story_route_completed/script.json"
      ]
    });
    assert.equal(await harness.jobStore.get("job_route_completed"), undefined);
    assert.equal((await harness.queue.list()).find((item) => item.jobId === "job_route_completed"), undefined);
    assert.deepEqual([...harness.storage.recordedObjects.keys()], []);
    assert.deepEqual(harness.storage.deletedKeys, deletePayload.deletedRemoteAssetKeys);

    const deletedStatusResponse = await fetch(`${app.baseURL}/generation-jobs/job_route_completed`, {
      headers: authHeaders()
    });

    assert.equal(deletedStatusResponse.status, 404);
  });

  it("returns typed errors for unauthenticated and missing job requests", async () => {
    const app = await startTestApp(enabledConfig(), createInMemoryGenerationRuntime());

    const unauthenticatedResponse = await fetch(`${app.baseURL}/generation-jobs/job_missing`, {
      headers: {
        authorization: "Bearer unknown-device-token"
      }
    });
    const unauthenticatedPayload = await unauthenticatedResponse.json() as ApiErrorPayload;

    assert.equal(unauthenticatedResponse.status, 401);
    assert.equal(unauthenticatedPayload.error.code, "unknown_device_token");
    assert.equal(unauthenticatedPayload.error.retryable, false);

    const missingResponse = await fetch(`${app.baseURL}/generation-jobs/job_missing`, {
      headers: authHeaders()
    });
    const missingPayload = await missingResponse.json() as ApiErrorPayload;

    assert.equal(missingResponse.status, 404);
    assert.equal(missingPayload.error.code, "job_not_found");
    assert.equal(missingPayload.error.retryable, false);
  });

  it("fetches final story metadata from a completed mock job", async () => {
    const story = completedStory();
    const runtime = completedRuntime(story);
    const app = await startTestApp(enabledConfig(), runtime);

    const jobResponse = await fetch(`${app.baseURL}/generation-jobs/job_completed`, {
      headers: authHeaders()
    });
    const jobPayload = await jobResponse.json() as JobPayload;

    assert.equal(jobResponse.status, 200);
    assert.equal(jobPayload.job.status, "completed");
    assert.equal(jobPayload.job.storyId, story.id);

    const storyResponse = await fetch(`${app.baseURL}/stories/${story.id}`, {
      headers: authHeaders()
    });
    const storyPayload = await storyResponse.json() as StoryPayload;

    assert.equal(storyResponse.status, 200);
    assert.equal(storyPayload.story.id, story.id);
    assert.equal(storyPayload.story.assets.some((asset) => asset.kind === "audio"), true);
    assert.equal(storyPayload.story.chapters.length, 1);
  });

  it("fetches the full-length acceptance demo story without device auth", async () => {
    const story = completedStory();
    const runtime: AppRuntime = {
      getDemoStory: (storyId) => storyId === "story_full_length_acceptance" ? {
        ...story,
        id: storyId,
        title: "The Library at Alexandria"
      } : undefined
    };
    const app = await startTestApp(enabledConfig(), runtime);

    const storyResponse = await fetch(`${app.baseURL}/demo-stories/story_full_length_acceptance`);
    const storyPayload = await storyResponse.json() as StoryPayload;

    assert.equal(storyResponse.status, 200);
    assert.equal(storyPayload.story.id, "story_full_length_acceptance");
    assert.equal(storyPayload.story.title, "The Library at Alexandria");
  });
});

function enabledConfig(overrides: NodeJS.ProcessEnv = {}): ServerConfig {
  return loadConfig({
    NODE_ENV: "test",
    PORT: "8787",
    DEVICE_TOKEN_HMAC_SECRET: authSecret,
    OWNER_DEVICE_TOKEN_HASHES: hashDeviceToken(ownerToken, authSecret),
    ENABLE_GEMINI_RESEARCH: "true",
    ENABLE_ANTHROPIC_WRITING: "true",
    ENABLE_ELEVENLABS_TTS: "true",
    ENABLE_OPENAI_IMAGES: "true",
    PROVIDER_KILL_SWITCH: "false",
    ...overrides
  });
}

async function startTestApp(
  config: ServerConfig,
  runtime: AppRuntime
): Promise<{ readonly baseURL: string }> {
  const server = createApp(config, runtime);
  runningServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${address.port}`
  };
}

async function postGenerationJob(baseURL: string): Promise<Response> {
  return fetch(`${baseURL}/generation-jobs`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({
      request: createGenerationRequest({
        kind: "historical_figure",
        subject: "Ibn Battuta",
        targetDurationMinutes: 60
      })
    })
  });
}

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${ownerToken}`
  };
}

async function durableApiHarness() {
  const directory = await mkdtemp(join(tmpdir(), "sleepy-history-progress-api-"));
  const jobStore = new FileJobStore(join(directory, "jobs.json"));
  const queue = new FileDurableQueue(join(directory, "queue.json"), jobStore);
  const storage = new RecordingStorageProvider({
    signingSecret: "test-storage-signing-secret-32-bytes-minimum"
  });
  let tick = 0;
  let createCount = 0;
  const now = () => `2026-05-10T17:${String(20 + tick++).padStart(2, "0")}:00.000Z`;
  const machine = new GenerationStateMachine({
    queue,
    jobStore,
    providers: {
      research: new MockResearchProvider(),
      writer: new MockWriterProvider(),
      voice: new MockVoiceProvider(),
      image: new MockImageProvider(),
      storage
    },
    now
  });
  const runtime: AppRuntime = {
    createGenerationJob: (request) => queue.createJob(request, `job_route_${createCount++}`, now()),
    getGenerationJob: (jobId) => jobStore.get(jobId),
    cancelGenerationJob: (jobId, reason) => machine.cancelJob(jobId, reason),
    retryGenerationJob: (jobId) => machine.retryJob(jobId),
    deleteGenerationJob: (jobId) => machine.deleteJob(jobId),
    getStory: (storyId) => getGeneratedStory(jobStore, storage, storyId, now)
  };

  return {
    jobStore,
    machine,
    queue,
    runtime,
    storage
  };
}

function completedRuntime(story: Story): AppRuntime {
  const request = createGenerationRequest({
    kind: "daily_life",
    subject: "a lantern maker in Ottoman Istanbul",
    targetDurationMinutes: 55
  });
  const job: GenerationJob = {
    id: "job_completed",
    status: "completed",
    request,
    progress: {
      stage: "completed",
      percent: 100,
      message: "Completed"
    },
    createdAt: story.createdAt,
    updatedAt: story.createdAt,
    storyId: story.id
  };

  return {
    getGenerationJob: (jobId) => jobId === job.id ? job : undefined,
    cancelGenerationJob: (jobId) => jobId === job.id ? {
      ...job,
      status: "canceled",
      progress: {
        stage: "canceled",
        percent: 100,
        message: "Canceled by owner"
      }
    } : undefined,
    retryGenerationJob: (jobId) => jobId === job.id ? {
      ...job,
      status: "queued",
      progress: {
        stage: "queued",
        percent: 0,
        message: "Queued for retry"
      },
      storyId: undefined
    } : undefined,
    deleteGenerationJob: (jobId) => jobId === job.id ? {
      deleted: true,
      jobId
    } : undefined,
    getStory: (storyId) => storyId === story.id ? story : undefined
  };
}

function completedStory(): Story {
  return {
    id: "story_lantern_maker",
    title: "The Lantern Maker's Quiet Shop",
    subtitle: "Copper, glass, and evening tea",
    kind: "daily_life",
    subject: "a lantern maker in Ottoman Istanbul",
    synopsis: "A soft walk through an ordinary workshop as the market settles for the night.",
    targetDurationMinutes: 55,
    estimatedDurationSeconds: 3_300,
    createdAt: "2026-05-10T16:00:00.000Z",
    chapters: [
      {
        id: "chapter_01",
        index: 1,
        title: "The Last Customer Leaves",
        summary: "The shop grows quiet as tools are put away.",
        estimatedDurationSeconds: 420,
        transcript: "The street becomes soft with dusk and careful footsteps.",
        sourceIds: ["source_01"]
      }
    ],
    sources: [
      {
        id: "source_01",
        title: "Mock Ottoman daily life source",
        publisher: "Sleepy History Fixtures",
        retrievedAt: "2026-05-10T16:00:00.000Z"
      }
    ],
    assets: [
      {
        id: "asset_audio",
        kind: "audio",
        mimeType: "audio/wav",
        uri: "https://example.com/stories/story_lantern_maker/audio.wav",
        durationSeconds: 3_300
      }
    ]
  };
}

interface CreateJobPayload {
  readonly job: {
    readonly id: string;
    readonly status: "accepted";
    readonly generationStatus: GenerationJob["status"];
    readonly progress: GenerationJob["progress"];
  };
}

interface JobPayload {
  readonly job: GenerationJob;
}

interface StoryPayload {
  readonly story: Story;
}

interface DeleteJobPayload {
  readonly deleted: true;
  readonly jobId: string;
  readonly deletedRemoteAssetKeys?: readonly string[];
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

interface ApiErrorPayload {
  readonly error: {
    readonly code: string;
    readonly retryable: boolean;
  };
}
