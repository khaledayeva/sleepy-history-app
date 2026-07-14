import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { inspectWav } from "../src/audioAssembly.js";
import { hasRealProviderSmokeConfig, missingRealProviderSmokeEnv, runRealProviderSmoke } from "../src/realProviderSmoke.js";

describe("real-provider smoke workflow", () => {
  it("skips safely until all real provider credentials and voice mapping are present", async () => {
    const missing = missingRealProviderSmokeEnv({
      GEMINI_API_KEY: "gemini",
      ANTHROPIC_API_KEY: "anthropic",
      ELEVENLABS_API_KEY: "eleven",
      OPENAI_API_KEY: "openai"
    });
    const result = await runRealProviderSmoke({ env: {} });

    assert.deepEqual(missing, ["ELEVENLABS_VOICE_ID"]);
    assert.equal(hasRealProviderSmokeConfig({}), false);
    assert.equal(result.skipped, true);
  });

  it("runs research, writing, narration, image, storage, download, and playable audio checks with mocked provider fetches", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sleepy-history-real-smoke-test-"));
    const calls = {
      gemini: 0,
      anthropic: 0,
      elevenLabs: 0,
      openAI: 0
    };
    const result = await runRealProviderSmoke({
      outputDirectory,
      env: {
        GEMINI_API_KEY: "gemini-key",
        ANTHROPIC_API_KEY: "anthropic-key",
        ELEVENLABS_API_KEY: "elevenlabs-key",
        ELEVENLABS_VOICE_ID: "elevenlabs-voice-id",
        OPENAI_API_KEY: "openai-key",
        REAL_PROVIDER_SMOKE_OUTPUT_DIR: "",
        STORAGE_SIGNING_SECRET: ""
      },
      now: tickingNow(),
      fetches: {
        gemini: async () => {
          calls.gemini += 1;
          return jsonResponse(geminiDossierResponse());
        },
        anthropic: async (_url, init) => {
          calls.anthropic += 1;
          const body = JSON.parse(String(init?.body ?? "")) as { readonly messages?: readonly { readonly content?: string }[] };
          const content = body.messages?.[0]?.content ?? "";
          return jsonResponse(content.includes("Do not include chapter transcript text")
            ? anthropicMessage(storyPlanJson())
            : anthropicMessage({ text: chapterText(80) }));
        },
        elevenLabs: async () => {
          calls.elevenLabs += 1;
          return audioResponse(oneSecondPcm16Le());
        },
        openAI: async () => {
          calls.openAI += 1;
          return jsonResponse({
            created: 1_789_000_000,
            data: [{
              b64_json: minimalPngBase64()
            }]
          });
        }
      }
    });

    assert.equal(result.skipped, false);
    assert.equal(result.finalStatus, "completed");
    assert.equal(result.storyId, "story_real_provider_smoke");
    assert.equal(calls.gemini, 1);
    assert.equal(calls.anthropic, 9);
    assert.equal(calls.elevenLabs, 8);
    assert.equal(calls.openAI, 1);
    assert.equal(result.links.some((link) => link.role === "audio"), true);
    assert.equal(result.links.some((link) => link.role === "cover_full"), true);

    const audioBytes = await readFile(result.audioPath);
    const audioInspection = inspectWav(audioBytes);
    assert.equal(audioInspection.durationSeconds, 8);
    assert.equal(result.audio.durationSeconds, 8);
    const summary = JSON.parse(await readFile(result.summaryPath, "utf8")) as { readonly storyId?: string };
    assert.equal(summary.storyId, "story_real_provider_smoke");
  });
});

function tickingNow(): () => string {
  let tick = 0;
  const start = Date.UTC(2026, 4, 10, 16, 57, 0);
  return () => new Date(start + tick++ * 1_000).toISOString();
}

function geminiDossierResponse(): unknown {
  return {
    candidates: [{
      content: {
        parts: [{
          text: JSON.stringify({
            subject: "a scribe closing the Library at Alexandria",
            era: "Ptolemaic Egypt",
            location: "Alexandria",
            chronology: ["The library day slows as readers leave and lamps are checked."],
            dailyLifeDetails: ["Reed pens, papyrus rolls, lamp oil, sandals on stone, and catalog shelves shape the routine."],
            pronunciationCandidates: ["Alexandria", "Ptolemaic"],
            uncertaintyNotes: ["The story uses a composite ordinary scribe where records are incomplete."],
            claims: [{
              id: "claim_1",
              text: "Scribes and librarians handled papyrus rolls, cataloging, copying, and daily care of texts.",
              sourceIds: ["source_1"],
              confidence: "grounded"
            }],
            sources: [{
              id: "source_1",
              title: "Alexandria library source",
              publisher: "Sleepy History Smoke Fixture"
            }]
          })
        }]
      },
      groundingMetadata: {
        webSearchQueries: ["Library of Alexandria daily life scribes"],
        groundingChunks: [{
          web: {
            uri: "https://example.com/library-source",
            title: "Library source"
          }
        }]
      }
    }]
  };
}

function storyPlanJson(): unknown {
  return {
    title: "The Last Lamp in Alexandria",
    synopsis: "A quiet evening with an ordinary library scribe.",
    storyBible: {
      premise: "An ordinary scribe closes the library with gentle attention to tools, shelves, and lamplight.",
      narrativePointOfView: "quiet third-person bedtime narrator",
      toneGuidelines: ["slow", "gentle", "source-grounded"],
      historicalBoundaries: ["Use a composite scribe and avoid certainty where records are thin."],
      pronunciationGuide: ["Alexandria", "Ptolemaic"]
    },
    targetDurationMinutes: 5,
    estimatedTotalWords: 640,
    wordsPerMinute: 128,
    sourceMap: [{
      sourceId: "source_1",
      title: "Alexandria library source",
      claimIds: ["claim_1"],
      chapterIds: Array.from({ length: 8 }, (_value, index) => `chapter_${String(index + 1).padStart(2, "0")}`)
    }],
    continuitySummary: "Keep each chapter calm, ordinary, and softly connected to the closing routine.",
    chapters: Array.from({ length: 8 }, (_value, index) => ({
      id: `chapter_${String(index + 1).padStart(2, "0")}`,
      index: index + 1,
      title: index === 0 ? "The Lamps Are Lowered" : `A Quiet Shelf ${index + 1}`,
      checkpoint: "The library settles without tension.",
      summary: "The scribe tends one small closing task.",
      continuitySummary: "Continue the same gentle evening routine.",
      estimatedWords: 80,
      sourceIds: ["source_1"]
    }))
  };
}

function anthropicMessage(payload: unknown): unknown {
  return {
    id: "msg_smoke",
    content: [{
      type: "text",
      text: JSON.stringify(payload)
    }]
  };
}

function chapterText(wordCount: number): string {
  const words = [
    "softly",
    "the",
    "scribe",
    "rests",
    "a",
    "reed",
    "pen",
    "beside",
    "quiet",
    "papyrus",
    "while",
    "lamplight",
    "settles",
    "over",
    "shelves",
    "and",
    "the",
    "evening",
    "air",
    "feels",
    "cool"
  ];

  return Array.from({ length: wordCount }, (_value, index) => words[index % words.length] ?? "softly").join(" ");
}

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: () => null
    },
    async json(): Promise<unknown> {
      return payload;
    }
  } as unknown as Response;
}

function audioResponse(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: () => null
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      return toArrayBuffer(bytes);
    }
  } as unknown as Response;
}

function oneSecondPcm16Le(): Uint8Array {
  return new Uint8Array(24_000 * 2);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return arrayBuffer;
}

function minimalPngBase64(): string {
  return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4cf7AfwAI0QOHKybRAwAAAABJRU5ErkJggg==";
}
