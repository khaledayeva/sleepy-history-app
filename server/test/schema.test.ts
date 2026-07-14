import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  SchemaValidationError,
  parseApiError,
  parseAsset,
  parseChapter,
  parseGenerationJob,
  parseGenerationRequest,
  parseSourceRecord,
  parseStory
} from "../src/schemas.js";

async function fixture(name: string): Promise<unknown> {
  const text = await readFile(join(process.cwd(), "test", "fixtures", name), "utf8");
  return JSON.parse(text) as unknown;
}

describe("shared API contract schemas", () => {
  it("validates the generation request fixture", async () => {
    const request = parseGenerationRequest(await fixture("generation-request.json"));

    assert.equal(request.kind, "daily_life");
    assert.equal(request.targetDurationMinutes, 60);
    assert.equal(request.safety.bedtimeTone, "very_gentle");
  });

  it("validates the generation job fixture", async () => {
    const job = parseGenerationJob(await fixture("generation-job.json"));

    assert.equal(job.status, "writing");
    assert.equal(job.progress.stage, "writing");
    assert.equal(job.request.subject, "a baker in Abbasid Baghdad");
    assert.equal(job.metadata?.contentReview?.review_status, "passed");
  });

  it("validates the story fixture", async () => {
    const story = parseStory(await fixture("story.json"));

    assert.equal(story.chapters.length, 2);
    assert.equal(story.sources.length, 2);
    assert.equal(story.assets.length, 3);
  });

  it("validates standalone chapter, source, asset, and error fixtures", async () => {
    assert.equal(parseChapter(await fixture("chapter.json")).index, 1);
    assert.equal(parseSourceRecord(await fixture("source.json")).publisher, "World History Encyclopedia");
    assert.equal(parseAsset(await fixture("asset.json")).kind, "cover_full");
    assert.equal(parseApiError(await fixture("api-error.json")).retryable, true);
  });

  it("rejects malformed contract data with issue details", () => {
    assert.throws(
      () => parseGenerationRequest({ schemaVersion: "2026-05-10", kind: "daily_life" }),
      (error) => {
        assert.ok(error instanceof SchemaValidationError);
        assert.match(error.message, /subject/);
        assert.match(error.message, /targetDurationMinutes/);
        return true;
      }
    );
  });

  it("rejects malformed job status and progress values", async () => {
    const job = await fixture("generation-job.json") as Record<string, unknown>;

    assert.throws(
      () => parseGenerationJob({
        ...job,
        status: "sleeping",
        progress: {
          stage: "queued",
          percent: 101
        }
      }),
      (error) => {
        assert.ok(error instanceof SchemaValidationError);
        assert.match(error.message, /status/);
        assert.match(error.message, /percent/);
        return true;
      }
    );
  });

  it("rejects malformed source URLs and retrieved dates", () => {
    assert.throws(
      () => parseSourceRecord({
        id: "source_bad",
        title: "Bad Source",
        url: "http://example.com/source",
        retrievedAt: "not-a-date"
      }),
      (error) => {
        assert.ok(error instanceof SchemaValidationError);
        assert.match(error.message, /url must use https/);
        assert.match(error.message, /retrievedAt/);
        return true;
      }
    );
  });

  it("rejects malformed asset kinds and dimensions", () => {
    assert.throws(
      () => parseAsset({
        id: "asset_bad",
        kind: "video",
        mimeType: "image/png",
        uri: "https://example.com/cover.png"
      }),
      (error) => {
        assert.ok(error instanceof SchemaValidationError);
        assert.match(error.message, /kind/);
        return true;
      }
    );

    assert.throws(
      () => parseAsset({
        id: "asset_bad_dimensions",
        kind: "cover_full",
        mimeType: "image/png",
        uri: "https://example.com/cover.png",
        width: 0,
        height: -1
      }),
      (error) => {
        assert.ok(error instanceof SchemaValidationError);
        assert.match(error.message, /width/);
        assert.match(error.message, /height/);
        return true;
      }
    );
  });

  it("rejects non-scalar typed error details", () => {
    assert.throws(
      () => parseApiError({
        code: "bad_request",
        message: "Bad request.",
        retryable: false,
        details: {
          nested: { unsafe: true }
        }
      }),
      (error) => {
        assert.ok(error instanceof SchemaValidationError);
        assert.match(error.message, /details\.nested/);
        return true;
      }
    );
  });
});
