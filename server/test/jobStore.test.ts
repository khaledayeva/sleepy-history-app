import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FileJobStore } from "../src/jobStore.js";
import type { GenerationJob } from "../src/schemas.js";

describe("file job store", () => {
  it("reloads queued, running, failed, and completed jobs after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sleepy-history-jobs-"));
    const storePath = join(directory, "jobs.json");
    const store = new FileJobStore(storePath);

    await store.save(job("job_queued", "queued"));
    await store.save(job("job_running", "writing"));
    await store.save({
      ...job("job_failed", "failed"),
      error: {
        code: "provider_timeout",
        message: "The writing provider timed out.",
        retryable: true
      }
    });
    await store.save({
      ...job("job_completed", "completed"),
      storyId: "story_completed"
    });

    const reloadedStore = new FileJobStore(storePath);
    const statuses = new Map((await reloadedStore.list()).map((reloadedJob) => [reloadedJob.id, reloadedJob.status]));

    assert.equal(statuses.get("job_queued"), "queued");
    assert.equal(statuses.get("job_running"), "writing");
    assert.equal(statuses.get("job_failed"), "failed");
    assert.equal(statuses.get("job_completed"), "completed");
  });

  it("updates an existing job checkpoint durably", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sleepy-history-jobs-"));
    const storePath = join(directory, "jobs.json");
    const store = new FileJobStore(storePath);

    await store.save(job("job_progress", "researching"));
    await store.update("job_progress", (existingJob) => ({
      ...existingJob,
      status: "writing",
      progress: {
        stage: "writing",
        percent: 35,
        message: "Drafting chapter 3"
      },
      updatedAt: "2026-05-10T01:10:00.000Z"
    }));

    const reloaded = await new FileJobStore(storePath).get("job_progress");

    assert.equal(reloaded?.status, "writing");
    assert.equal(reloaded?.progress.percent, 35);
    assert.equal(reloaded?.progress.message, "Drafting chapter 3");
  });

  it("persists content review metadata on jobs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sleepy-history-jobs-"));
    const storePath = join(directory, "jobs.json");
    const store = new FileJobStore(storePath);

    await store.save({
      ...job("job_review", "reviewing"),
      metadata: {
        contentReview: {
          content_policy_version: "2026-05-09",
          review_status: "rewrite_required",
          findings: [
            {
              code: "horror_pacing",
              severity: "warning",
              chapterId: "chapter_01"
            }
          ]
        }
      }
    });

    const reloaded = await new FileJobStore(storePath).get("job_review");

    assert.equal(reloaded?.metadata?.contentReview?.review_status, "rewrite_required");
    assert.equal(Array.isArray(reloaded?.metadata?.contentReview?.findings), true);
  });
});

function job(id: string, status: GenerationJob["status"]): GenerationJob {
  return {
    id,
    status,
    request: {
      schemaVersion: "2026-05-10",
      kind: "daily_life",
      subject: "a potter in Edo",
      targetDurationMinutes: 60,
      era: "18th century CE",
      location: "Edo",
      perspective: "ordinary craftsperson closing a quiet workshop",
      voiceId: "calm_narrator_01",
      ambience: "none",
      safety: {
        bedtimeTone: "very_gentle",
        allowHistoricalViolenceContext: false
      }
    },
    progress: {
      stage: status,
      percent: status === "completed" ? 100 : 10
    },
    createdAt: "2026-05-10T01:00:00.000Z",
    updatedAt: "2026-05-10T01:00:00.000Z"
  };
}
