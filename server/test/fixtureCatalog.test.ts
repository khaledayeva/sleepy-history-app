import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixtureCatalog, fixtureCatalogSummary } from "../src/fixtures/catalog.js";

describe("realistic fixture catalog", () => {
  it("covers the required story and job states", () => {
    const summary = fixtureCatalogSummary();

    assert.equal(summary.historical_figure, 1);
    assert.equal(summary.ordinary_daily_life, 1);
    assert.equal(summary.incomplete_job, 1);
    assert.equal(summary.failed_job, 1);
    assert.equal(summary.downloaded_story, 1);
    assert.equal(summary.missing_asset, 1);
  });

  it("includes downloaded and missing-asset states that UI can exercise", () => {
    const downloaded = fixtureCatalog.find((entry) => entry.state === "downloaded_story");
    const missingAsset = fixtureCatalog.find((entry) => entry.state === "missing_asset");

    assert.equal(downloaded?.story?.download.status, "downloaded");
    assert.ok(downloaded?.story?.download.localAssetIds.length);
    assert.equal(missingAsset?.missingAssetIds?.[0], "asset_missing_cover");
    assert.equal(missingAsset?.story?.assets.some((asset) => asset.id === "asset_missing_cover"), false);
  });

  it("includes incomplete and failed jobs with progress metadata", () => {
    const incomplete = fixtureCatalog.find((entry) => entry.state === "incomplete_job");
    const failed = fixtureCatalog.find((entry) => entry.state === "failed_job");

    assert.equal(incomplete?.job?.status, "writing");
    assert.equal(incomplete?.job?.progress.percent, 47);
    assert.equal(failed?.job?.status, "failed");
    assert.equal(failed?.job?.error?.retryable, true);
  });
});
