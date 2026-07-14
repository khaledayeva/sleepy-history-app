import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FileDurableQueue, providerIdempotencyKey } from "../src/durableQueue.js";
import { createGenerationRequest } from "../src/generationRequests.js";
import { FileJobStore } from "../src/jobStore.js";

describe("durable queue and idempotency contracts", () => {
  it("runs jobs outside request lifetime and resumes after restart", async () => {
    const paths = await queuePaths();
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a lamp maker in medieval Cairo"
    });
    const firstQueue = new FileDurableQueue(paths.queuePath, new FileJobStore(paths.jobStorePath));

    await firstQueue.createJob(request, "job_resumable", "2026-05-10T01:15:00.000Z");
    const claimed = await firstQueue.claimNext("2026-05-10T01:16:00.000Z");

    assert.equal(claimed?.jobId, "job_resumable");
    assert.equal(claimed?.attempts, 1);

    const restartedQueue = new FileDurableQueue(paths.queuePath, new FileJobStore(paths.jobStorePath));
    const pending = await restartedQueue.resumePending();

    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.status, "running");
  });

  it("does not reclaim a fresh running job until the stale lease expires", async () => {
    const paths = await queuePaths();
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a bell maker in Bruges"
    });
    const queue = new FileDurableQueue(paths.queuePath, new FileJobStore(paths.jobStorePath));

    await queue.createJob(request, "job_running_lease", "2026-05-10T01:15:00.000Z");
    await queue.claimNext("2026-05-10T01:16:00.000Z");

    const freshClaim = await queue.claimNext("2026-05-10T01:16:30.000Z", {
      runningStaleAfterMs: 120000
    });
    const staleClaim = await queue.claimNext("2026-05-10T01:18:01.000Z", {
      runningStaleAfterMs: 120000
    });

    assert.equal(freshClaim, undefined);
    assert.equal(staleClaim?.jobId, "job_running_lease");
    assert.equal(staleClaim?.attempts, 1);
  });

  it("checkpoints provider stages with stable idempotency keys", async () => {
    const paths = await queuePaths();
    const queue = new FileDurableQueue(paths.queuePath, new FileJobStore(paths.jobStorePath));
    const request = createGenerationRequest({
      kind: "historical_figure",
      subject: "Mary Anning"
    });

    await queue.createJob(request, "job_checkpointed", "2026-05-10T01:15:00.000Z");
    await queue.claimNext("2026-05-10T01:16:00.000Z");
    const checkpoint = await queue.checkpointStage(
      "job_checkpointed",
      "researching",
      15,
      "2026-05-10T01:17:00.000Z",
      "Building research dossier"
    );

    assert.equal(checkpoint.idempotencyKey, providerIdempotencyKey("job_checkpointed", "researching"));

    const job = await new FileJobStore(paths.jobStorePath).get("job_checkpointed");
    assert.equal(job?.status, "researching");
    assert.equal(job?.progress.percent, 15);
  });

  it("checkpoints audio chunks independently for resumable TTS", async () => {
    const paths = await queuePaths();
    const queue = new FileDurableQueue(paths.queuePath, new FileJobStore(paths.jobStorePath));
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a weaver in Cusco"
    });

    await queue.createJob(request, "job_audio_chunks", "2026-05-10T01:15:00.000Z");
    await queue.claimNext("2026-05-10T01:16:00.000Z");
    const firstChunk = await queue.checkpointAudioChunk({
      jobId: "job_audio_chunks",
      chapterId: "chapter_01",
      chunkId: "chunk_001",
      assetId: "asset_chunk_001",
      completedAt: "2026-05-10T01:18:00.000Z"
    });

    const restartedQueue = new FileDurableQueue(paths.queuePath, new FileJobStore(paths.jobStorePath));
    const pending = await restartedQueue.resumePending();

    assert.equal(firstChunk.idempotencyKey, providerIdempotencyKey("job_audio_chunks", "voice", "chunk_001"));
    assert.equal(pending[0]?.audioChunkCheckpoints[0]?.assetId, "asset_chunk_001");
  });
});

async function queuePaths(): Promise<{ readonly queuePath: string; readonly jobStorePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "sleepy-history-queue-"));

  return {
    queuePath: join(directory, "queue.json"),
    jobStorePath: join(directory, "jobs.json")
  };
}
