import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  listApprovedVoices,
  resolveVoiceSettings,
  validateVoiceId
} from "../src/voiceCatalog.js";

describe("approved voice catalog", () => {
  it("lists only approved voices with rights metadata and settings", () => {
    const voices = listApprovedVoices();
    const voice = voices[0];

    assert.ok(voice);
    assert.equal(voice.id, "calm_narrator_01");
    assert.equal(voice.provider, "elevenlabs");
    assert.equal(voice.permissionStatus, "approved");
    assert.equal(voice.defaultSettings.modelId, "eleven_multilingual_v2");
    assert.match(voice.rightsNote, /Not a cloned or public-figure imitation/);
  });

  it("validates selected voice IDs and rejects unknown voices", () => {
    assert.equal(validateVoiceId("calm_narrator_01").name, "Calm Narrator");
    assert.throws(() => validateVoiceId("public_figure_soundalike"), /not approved/);
  });

  it("resolves bounded voice settings for approved model IDs", () => {
    const settings = resolveVoiceSettings("calm_narrator_01", {
      speed: 1,
      stability: 0.8
    });

    assert.equal(settings.modelId, "eleven_multilingual_v2");
    assert.equal(settings.speed, 1);
    assert.equal(settings.stability, 0.8);
    assert.equal(resolveVoiceSettings("calm_narrator_01").similarity, 0.78);
    assert.throws(
      () => resolveVoiceSettings("calm_narrator_01", { modelId: "unapproved_model" }),
      /not approved for model/
    );
  });

  it("rejects non-finite voice setting overrides without erasing defaults", () => {
    const settings = resolveVoiceSettings("calm_narrator_01", {
      speed: undefined
    });

    assert.equal(settings.speed, 0.92);
    assert.throws(
      () => resolveVoiceSettings("calm_narrator_01", { speed: Number.NaN }),
      /finite number/
    );
    assert.throws(
      () => resolveVoiceSettings("calm_narrator_01", { stability: Number.POSITIVE_INFINITY }),
      /finite number/
    );
    assert.throws(
      () => resolveVoiceSettings("calm_narrator_01", { similarity: Number.NEGATIVE_INFINITY }),
      /finite number/
    );
  });
});
