import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGenerationRequest, presetForKind } from "../src/generationRequests.js";
import { SchemaValidationError } from "../src/schemas.js";

describe("generation request presets", () => {
  it("creates historical figure requests with era, perspective, voice, ambience, duration, and safety flags", () => {
    const request = createGenerationRequest({
      kind: "historical_figure",
      subject: "Hypatia",
      era: "late 4th century CE",
      location: "Alexandria",
      perspective: "quiet evening study",
      targetDurationMinutes: 55,
      voiceId: "calm_narrator_01",
      ambience: "fireplace",
      allowHistoricalViolenceContext: true
    });

    assert.equal(request.kind, "historical_figure");
    assert.equal(request.subject, "Hypatia");
    assert.equal(request.targetDurationMinutes, 55);
    assert.equal(request.voiceId, "calm_narrator_01");
    assert.equal(request.ambience, "fireplace");
    assert.equal(request.safety.allowHistoricalViolenceContext, true);
  });

  it("creates daily-life requests from safe defaults", () => {
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a gardener in Heian Kyoto",
      era: "11th century CE",
      location: "Kyoto",
      perspective: "ordinary worker tidying a courtyard"
    });

    assert.equal(request.kind, "daily_life");
    assert.equal(request.targetDurationMinutes, 60);
    assert.equal(request.ambience, "none");
    assert.equal(request.safety.bedtimeTone, "very_gentle");
  });

  it("keeps invalid request values behind schema validation", () => {
    assert.throws(
      () => createGenerationRequest({
        kind: "daily_life",
        subject: "a potter",
        targetDurationMinutes: 90
      }),
      SchemaValidationError
    );
  });

  it("exposes preset lookup by story kind", () => {
    assert.equal(presetForKind("historical_figure").id, "historical_figure_calm_profile");
    assert.equal(presetForKind("daily_life").id, "ordinary_daily_life");
  });
});
