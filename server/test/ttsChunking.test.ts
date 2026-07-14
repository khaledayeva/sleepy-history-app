import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTtsPlan } from "../src/ttsChunking.js";
import type { StoryScript } from "../src/providers.js";

const context = {
  jobId: "job_tts_chunking",
  idempotencyKey: "sleepy-history:job_tts_chunking:voicing"
};

describe("TTS chunking with continuity", () => {
  it("splits long chapter text below provider character limits", () => {
    const plan = createTtsPlan(scriptWithText(repeatedSentence(90)), "calm_narrator_01", context, undefined, {
      maxCharacters: 500,
      targetCharacters: 420
    });
    const chunks = plan.chapters[0]?.chunks ?? [];

    assert.ok(chunks.length > 1);
    assert.equal(chunks.every((chunk) => chunk.characterCount <= 500), true);
    assert.equal(chunks[0]?.previousChunkId, undefined);
    assert.equal(chunks[0]?.nextChunkId, "chapter_01_tts_002");
    assert.equal(chunks[1]?.previousChunkId, "chapter_01_tts_001");
  });

  it("adds continuity context and stable provider request keys to each chunk", () => {
    const plan = createTtsPlan(scriptWithText(repeatedSentence(30)), "calm_narrator_01", context, {
      speed: 0.9
    }, {
      maxCharacters: 600,
      targetCharacters: 500
    });
    const chunk = plan.chapters[0]?.chunks[0];

    assert.equal(plan.voiceId, "calm_narrator_01");
    assert.equal(plan.settings?.speed, 0.9);
    assert.ok(chunk);
    assert.equal(chunk.idempotencyKey, "sleepy-history:job_tts_chunking:voice:chapter_01_tts_001");
    assert.equal(chunk.providerRequestId, "job_tts_chunking:calm_narrator_01:chapter_01_tts_001");
    assert.match(chunk.continuityContext, /Global continuity/);
    assert.match(chunk.continuityContext, /Maintain the same calm narrator/);
  });

  it("splits single long sentences without exceeding the hard cap", () => {
    const text = Array.from({ length: 160 }, (_value, index) => `word${index}`).join(" ");
    const plan = createTtsPlan(scriptWithText(text), "calm_narrator_01", context, undefined, {
      maxCharacters: 120,
      targetCharacters: 100
    });
    const chunks = plan.chapters[0]?.chunks ?? [];

    assert.ok(chunks.length > 1);
    assert.equal(chunks.every((chunk) => chunk.characterCount <= 120), true);
  });

  it("splits an unbroken token that exceeds the hard cap", () => {
    const text = "a".repeat(275);
    const plan = createTtsPlan(scriptWithText(text), "calm_narrator_01", context, undefined, {
      maxCharacters: 100,
      targetCharacters: 80
    });
    const chunks = plan.chapters[0]?.chunks ?? [];

    assert.deepEqual(chunks.map((chunk) => chunk.characterCount), [100, 100, 75]);
    assert.equal(chunks.every((chunk) => chunk.characterCount <= 100), true);
  });

  it("rejects invalid chunking limits and empty chapter text", () => {
    assert.throws(
      () => createTtsPlan(scriptWithText("gentle text"), "calm_narrator_01", context, undefined, {
        maxCharacters: 0,
        targetCharacters: 0
      }),
      /maxCharacters/
    );
    assert.throws(
      () => createTtsPlan(scriptWithText("gentle text"), "calm_narrator_01", context, undefined, {
        maxCharacters: 100,
        targetCharacters: -1
      }),
      /targetCharacters/
    );
    assert.throws(
      () => createTtsPlan(scriptWithText("gentle text"), "calm_narrator_01", context, undefined, {
        maxCharacters: 100,
        targetCharacters: 101
      }),
      /targetCharacters/
    );
    assert.throws(
      () => createTtsPlan(scriptWithText("   "), "calm_narrator_01", context),
      /non-empty/
    );
  });
});

function scriptWithText(text: string): StoryScript {
  return {
    title: "A Quiet Hour",
    synopsis: "A calm test script.",
    storyBible: {
      premise: "A gentle story.",
      narrativePointOfView: "quiet third person",
      toneGuidelines: ["slow"],
      historicalBoundaries: ["fixture"],
      pronunciationGuide: ["Baghdad"]
    },
    targetDurationMinutes: 60,
    estimatedTotalWords: 7800,
    wordsPerMinute: 130,
    sourceMap: [
      {
        sourceId: "source_fixture",
        title: "Fixture Source",
        claimIds: ["claim_fixture"],
        chapterIds: ["chapter_01"]
      }
    ],
    continuitySummary: "Keep the story gentle and unhurried.",
    chapters: [
      {
        id: "chapter_01",
        index: 1,
        title: "The Lamp Is Lit",
        checkpoint: "Begin quietly.",
        summary: "A gentle first chapter.",
        continuitySummary: "Keep the same lamp, room, and low voice.",
        estimatedWords: 975,
        text,
        sourceIds: ["source_fixture"]
      }
    ]
  };
}

function repeatedSentence(count: number): string {
  return Array.from({ length: count }, (_value, index) => `Sentence ${index + 1} stays calm beside the lamp and keeps the narration soft.`).join(" ");
}
