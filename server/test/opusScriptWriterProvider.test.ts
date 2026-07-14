import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGenerationRequest } from "../src/generationRequests.js";
import {
  OpusScriptWriterProvider,
  parseOpusScriptResponse
} from "../src/opusScriptWriterProvider.js";
import { ProviderQuotaExceededError, type ResearchDossier } from "../src/providers.js";
import { validateStoryScript } from "../src/storyScriptValidation.js";

const request = createGenerationRequest({
  kind: "daily_life",
  subject: "a scribe in Ptolemaic Alexandria",
  era: "3rd century BCE",
  location: "Alexandria",
  perspective: "ordinary scribe closing a quiet day"
});

const context = {
  jobId: "job_opus_writer",
  idempotencyKey: "sleepy-history:job_opus_writer:writing"
};

describe("Opus 4.6 script writer adapter", () => {
  it("parses a fixture story script into the shared story script shape", () => {
    const script = parseOpusScriptResponse({
      id: "msg_fixture",
      content: [
        {
          type: "text",
          text: JSON.stringify(fixtureScriptJson())
        }
      ]
    }, request);

    assert.equal(script.title, "A Lantern Beside the Harbor");
    assert.equal(script.targetDurationMinutes, 60);
    assert.equal(script.chapters.length, 8);
    assert.equal(script.chapters[0]?.index, 1);
    assert.equal(script.chapters[0]?.checkpoint, "Leave the workroom and settle into the harbor evening.");
    assert.equal(script.chapters[0]?.sourceIds[0], "source_alexandria_daily_life");
    assert.equal(script.sourceMap[0]?.chapterIds.length, 8);
    assert.equal(validateStoryScript(script).ok, true);
    assert.match(script.chapters[0]?.text ?? "", /slow and quiet/);
  });

  it("parses fenced JSON from real writer responses", () => {
    const script = parseOpusScriptResponse({
      id: "msg_fenced_fixture",
      content: [
        {
          type: "text",
          text: `\`\`\`json\n${JSON.stringify(fixtureScriptJson())}\n\`\`\``
        }
      ]
    }, request);

    assert.equal(script.title, "A Lantern Beside the Harbor");
    assert.equal(script.chapters.length, 8);
  });

  it("uses safe story bible fallbacks for sparse real writer plans", () => {
    const sparseScript = fixtureScriptJson() as Record<string, unknown>;
    sparseScript.storyBible = {
      narrativePointOfView: "",
      toneGuidelines: [""],
      historicalBoundaries: [],
      pronunciationGuide: [""]
    };

    const script = parseOpusScriptResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify(sparseScript)
        }
      ]
    }, request);

    assert.equal(script.storyBible.premise, script.synopsis);
    assert.equal(script.storyBible.narrativePointOfView, request.perspective);
    assert.deepEqual(script.storyBible.toneGuidelines, ["slow", "gentle", "source-grounded"]);
    assert.deepEqual(script.storyBible.pronunciationGuide, []);
  });

  it("derives a source map when real writer plans return sparse source references", () => {
    const sparseScript = fixtureScriptJson() as Record<string, unknown>;
    sparseScript.sourceMap = [
      {
        sourceId: "",
        title: "",
        claimIds: [""],
        chapterIds: []
      }
    ];

    const script = parseOpusScriptResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify(sparseScript)
        }
      ]
    }, request);

    assert.equal(script.sourceMap[0]?.sourceId, "source_alexandria_daily_life");
    assert.equal(script.sourceMap[0]?.title, "Research dossier source 1");
    assert.equal(script.sourceMap[0]?.chapterIds.length, 8);
  });

  it("adds fallback source map entries for chapter source IDs missing from writer sourceMap", () => {
    const sparseScript = fixtureScriptJson() as Record<string, unknown>;
    const chapters = sparseScript.chapters as Record<string, unknown>[];
    chapters[1] = {
      ...chapters[1],
      sourceIds: ["gemini_grounding_2"]
    };

    const script = parseOpusScriptResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify(sparseScript)
        }
      ]
    }, request);

    const mappedSourceIds = script.sourceMap.map((entry) => entry.sourceId);
    assert.ok(mappedSourceIds.includes("source_alexandria_daily_life"));
    assert.ok(mappedSourceIds.includes("gemini_grounding_2"));
    assert.ok(script.sourceMap.find((entry) => entry.sourceId === "gemini_grounding_2")?.chapterIds.includes("chapter_02"));
  });

  it("calls the Anthropic Messages API with claude-opus-4-6 by default", async () => {
    const captured: { readonly url: string; readonly init?: RequestInit }[] = [];
    const provider = new OpusScriptWriterProvider({
      apiKey: "test-key",
      baseUrl: "https://anthropic.test/v1",
      fetchImpl: async (input, init) => {
        captured.push({ url: String(input), init });
        const isPlanRequest = captured.length === 1;

        return new Response(JSON.stringify({
          id: "msg_mocked",
          content: [
            {
              type: "text",
              text: JSON.stringify(isPlanRequest ? fixturePlanJson() : { text: repeatedTranscript(780) })
            }
          ]
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "request-id": "request_opus_fixture"
          }
        });
      }
    });

    const script = await provider.writeScript(fixtureDossier(), request, context);
    const firstRequest = captured[0];
    const secondRequest = captured[1];
    const headers = firstRequest?.init?.headers as Record<string, string>;
    const body = JSON.parse(String(firstRequest?.init?.body)) as {
      readonly model: string;
      readonly max_tokens: number;
      readonly system: string;
      readonly messages: readonly { readonly role: string; readonly content: string }[];
    };
    const chapterBody = JSON.parse(String(secondRequest?.init?.body)) as {
      readonly system: string;
      readonly messages: readonly { readonly role: string; readonly content: string }[];
    };

    assert.equal(captured.length, 11);
    assert.equal(captured.every((requestRecord) => requestRecord.url === "https://anthropic.test/v1/messages"), true);
    assert.equal(firstRequest?.init?.method, "POST");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    assert.equal(headers["X-Sleepy-History-Job"], "job_opus_writer");
    assert.equal(headers["Idempotency-Key"], "sleepy-history:job_opus_writer:writing:plan");
    assert.equal(body.model, "claude-opus-4-6");
    assert.equal(body.max_tokens, 8192);
    assert.match(body.system, /Never imitate any named podcast/);
    assert.doesNotMatch(body.system, /fixture responses may be short/);
    assert.match(body.messages[0]?.content ?? "", /Do not include chapter transcript text/);
    assert.match(body.messages[0]?.content ?? "", /Research dossier JSON/);
    assert.match(chapterBody.messages[0]?.content ?? "", /Target chapter words: 780/);
    assert.match(chapterBody.messages[0]?.content ?? "", /complete transcript text for this chapter only/);
    assert.doesNotMatch(chapterBody.messages[0]?.content ?? "", /fixture responses may be short/);
    assert.equal(script.chapters[0]?.title, "The Harbor Grows Dim");
    assert.equal(validateStoryScript(script).ok, true);
  });

  it("maps Anthropic low-credit 400 responses to provider quota errors", async () => {
    const provider = new OpusScriptWriterProvider({
      apiKey: "test-key",
      baseUrl: "https://anthropic.test/v1",
      fetchImpl: async () => new Response(JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."
        },
        request_id: "req_anthropic_low_credit"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      })
    });

    await assert.rejects(
      provider.writeScript(fixtureDossier(), request, context),
      (error) => {
        assert.ok(error instanceof ProviderQuotaExceededError);
        assert.equal(error.details.provider, "Anthropic Claude");
        assert.equal(error.details.status, 400);
        assert.equal(error.details.requestId, "req_anthropic_low_credit");
        assert.match(error.message, /Anthropic Claude credits are depleted/);
        assert.doesNotMatch(error.message, /req_anthropic_low_credit|invalid_request_error/);
        return true;
      }
    );
  });

  it("normalizes chapter estimates to the real transcript word counts from provider responses", async () => {
    const fixturePlan = fixturePlanJson() as {
      readonly chapters: readonly Record<string, unknown>[];
    } & Record<string, unknown>;
    const mismatchedPlan = {
      ...fixturePlan,
      estimatedTotalWords: 9600,
      chapters: fixturePlan.chapters.map((chapter) => ({
        ...chapter,
        estimatedWords: 1200
      }))
    };
    const provider = new OpusScriptWriterProvider({
      apiKey: "test-key",
      baseUrl: "https://anthropic.test/v1",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "")) as { readonly messages?: readonly { readonly content?: string }[] };
        const content = body.messages?.[0]?.content ?? "";

        return new Response(JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify(content.includes("Do not include chapter transcript text")
                ? mismatchedPlan
                : { text: repeatedTranscript(780) })
            }
          ]
        }), {
          status: 200
        });
      }
    });

    const script = await provider.writeScript(fixtureDossier(), request, context);

    assert.equal(script.estimatedTotalWords, 7800);
    assert.equal(script.chapters[0]?.estimatedWords, 780);
    assert.equal(validateStoryScript(script).ok, true);
  });

  it("repairs malformed plan JSON once before writing chapter transcripts", async () => {
    const capturedIdempotencyKeys: string[] = [];
    const provider = new OpusScriptWriterProvider({
      apiKey: "test-key",
      baseUrl: "https://anthropic.test/v1",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "")) as { readonly messages?: readonly { readonly content?: string }[] };
        const content = body.messages?.[0]?.content ?? "";
        const headers = init?.headers as Record<string, string>;
        const key = headers["Idempotency-Key"] ?? "";
        capturedIdempotencyKeys.push(key);

        const text = key.endsWith(":plan:json-repair")
          ? JSON.stringify(fixturePlanJson())
          : content.includes("Do not include chapter transcript text")
            ? malformedPlanJson()
            : JSON.stringify({ text: repeatedTranscript(780) });

        return new Response(JSON.stringify({
          content: [
            {
              type: "text",
              text
            }
          ]
        }), {
          status: 200
        });
      }
    });

    const script = await provider.writeScript(fixtureDossier(), request, context);

    assert.equal(capturedIdempotencyKeys.some((key) => key.endsWith(":plan:json-repair")), true);
    assert.equal(script.title, "A Lantern Beside the Harbor");
    assert.equal(script.chapters.length, 10);
    assert.equal(validateStoryScript(script).ok, true);
  });

  it("repairs malformed chapter transcript JSON once before checking word count", async () => {
    const capturedIdempotencyKeys: string[] = [];
    const provider = new OpusScriptWriterProvider({
      apiKey: "test-key",
      baseUrl: "https://anthropic.test/v1",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "")) as { readonly messages?: readonly { readonly content?: string }[] };
        const content = body.messages?.[0]?.content ?? "";
        const headers = init?.headers as Record<string, string>;
        const key = headers["Idempotency-Key"] ?? "";
        capturedIdempotencyKeys.push(key);

        let text: string;
        if (content.includes("Do not include chapter transcript text")) {
          text = JSON.stringify(fixturePlanJson());
        } else if (key.endsWith(":chapter_01")) {
          text = "{\"text\":\"the scribe settles beside an \"unescaped\" lamp\"}";
        } else {
          text = JSON.stringify({ text: repeatedTranscript(780) });
        }

        return new Response(JSON.stringify({
          content: [
            {
              type: "text",
              text
            }
          ]
        }), {
          status: 200
        });
      }
    });

    const script = await provider.writeScript(fixtureDossier(), request, context);

    assert.equal(capturedIdempotencyKeys.some((key) => key.endsWith(":chapter_01:json-repair")), true);
    assert.equal(script.chapters[0]?.estimatedWords, 780);
    assert.equal(script.chapters.every((chapter) => countWords(chapter.text) === 780), true);
    assert.equal(validateStoryScript(script).ok, true);
  });

  it("overrides undersized plan word targets before requesting full chapter transcripts", async () => {
    const fixturePlan = fixturePlanJson() as {
      readonly chapters: readonly Record<string, unknown>[];
    } & Record<string, unknown>;
    const undersizedPlan = {
      ...fixturePlan,
      estimatedTotalWords: 800,
      chapters: fixturePlan.chapters.map((chapter) => ({
        ...chapter,
        estimatedWords: 100
      }))
    };
    const capturedPrompts: string[] = [];
    const provider = new OpusScriptWriterProvider({
      apiKey: "test-key",
      baseUrl: "https://anthropic.test/v1",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "")) as { readonly messages?: readonly { readonly content?: string }[] };
        const content = body.messages?.[0]?.content ?? "";
        capturedPrompts.push(content);

        return new Response(JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify(content.includes("Do not include chapter transcript text")
                ? undersizedPlan
                : { text: repeatedTranscript(780) })
            }
          ]
        }), {
          status: 200
        });
      }
    });

    const script = await provider.writeScript(fixtureDossier(), request, context);
    const firstChapterPrompt = capturedPrompts.find((prompt) => prompt.includes("Chapter ID: chapter_01"));

    assert.match(firstChapterPrompt ?? "", /Target chapter words: 780/);
    assert.match(firstChapterPrompt ?? "", /target word count is mandatory/i);
    assert.equal(script.estimatedTotalWords, 7800);
    assert.equal(validateStoryScript(script).ok, true);
  });

  it("repairs an undersized chapter transcript once before validating the full script", async () => {
    const captured = {
      repairCalls: 0
    };
    const provider = new OpusScriptWriterProvider({
      apiKey: "test-key",
      baseUrl: "https://anthropic.test/v1",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "")) as {
          readonly messages?: readonly { readonly content?: string }[];
          readonly headers?: Record<string, string>;
        };
        const content = body.messages?.[0]?.content ?? "";
        const headers = init?.headers as Record<string, string>;
        if (headers["Idempotency-Key"]?.endsWith("chapter_01:repair")) {
          captured.repairCalls += 1;
        }

        const isPlan = content.includes("Do not include chapter transcript text");
        const isFirstChapter = content.includes("Chapter ID: chapter_01");
        const isRepair = content.includes("Previous chapter words:");

        return new Response(JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify(isPlan
                ? fixturePlanJson()
                : { text: repeatedTranscript(isFirstChapter && !isRepair ? 200 : 780) })
            }
          ]
        }), {
          status: 200
        });
      }
    });

    const script = await provider.writeScript(fixtureDossier(), request, context);

    assert.equal(captured.repairCalls, 1);
    assert.equal(script.chapters[0]?.estimatedWords, 780);
    assert.equal(validateStoryScript(script).ok, true);
  });

  it("deterministically trims overlong repaired transcripts before duration validation", async () => {
    const captured = {
      requestCount: 0,
      repairCalls: 0
    };
    const provider = new OpusScriptWriterProvider({
      apiKey: "test-key",
      baseUrl: "https://anthropic.test/v1",
      fetchImpl: async (_input, init) => {
        captured.requestCount += 1;
        const body = JSON.parse(String(init?.body ?? "")) as {
          readonly messages?: readonly { readonly content?: string }[];
        };
        const content = body.messages?.[0]?.content ?? "";
        const headers = init?.headers as Record<string, string>;
        if (headers["Idempotency-Key"]?.includes(":repair")) {
          captured.repairCalls += 1;
        }

        return new Response(JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify(content.includes("Do not include chapter transcript text")
                ? fixturePlanJson()
                : { text: repeatedTranscript(1000) })
            }
          ]
        }), {
          status: 200
        });
      }
    });

    const script = await provider.writeScript(fixtureDossier(), request, context);

    assert.equal(captured.requestCount, 21);
    assert.equal(captured.repairCalls, 10);
    assert.equal(script.estimatedTotalWords, 7800);
    assert.equal(script.chapters.every((chapter) => countWords(chapter.text) === 780), true);
    assert.equal(validateStoryScript(script).ok, true);
  });

  it("accepts a paid-style overlong script when it stays within generous duration tolerance", async () => {
    const provider = new OpusScriptWriterProvider({
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
                ? fixturePlanJson()
                : { text: repeatedTranscript(975) })
            }
          ]
        }), {
          status: 200
        });
      }
    });

    const script = await provider.writeScript(fixtureDossier(), request, context);

    assert.equal(script.estimatedTotalWords, 9750);
    assert.equal(script.chapters.every((chapter) => countWords(chapter.text) === 975), true);
    assert.equal(validateStoryScript(script).estimatedDurationMinutes, 75);
    assert.equal(validateStoryScript(script).ok, true);
  });

  it("supports configurable model IDs and rejects malformed script JSON", async () => {
    const provider = new OpusScriptWriterProvider({
      apiKey: "test-key",
      modelId: "claude-opus-4-6-test",
      baseUrl: "https://anthropic.test/v1",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { readonly model: string };
        assert.equal(body.model, "claude-opus-4-6-test");

        return new Response(JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                title: "",
                chapters: []
              })
            }
          ]
        }), {
          status: 200
        });
      }
    });

    await assert.rejects(provider.writeScript(fixtureDossier(), request, context), /title must be a non-empty string/);
  });

  it("rejects scripts that miss required checkpoints or duration tolerance", () => {
    const badScript = {
      ...(fixtureScriptJson() as Record<string, unknown>),
      estimatedTotalWords: 400,
      chapters: chaptersFixture(4).map((chapter) => ({
        ...chapter,
        checkpoint: ""
      }))
    };

    assert.throws(
      () => parseOpusScriptResponse({
        content: [
          {
            type: "text",
            text: JSON.stringify(badScript)
          }
        ]
      }, request),
      /checkpoint/
    );
  });

  it("rejects scripts with inflated estimates and thin transcript text", () => {
    const inflatedScript = {
      ...(fixtureScriptJson() as Record<string, unknown>),
      chapters: chaptersFixture(8, "short text")
    };

    assert.throws(
      () => parseOpusScriptResponse({
        content: [
          {
            type: "text",
            text: JSON.stringify(inflatedScript)
          }
        ]
      }, request),
      /estimated words do not match transcript text/
    );
  });

  it("can run a real-provider smoke test when ANTHROPIC_API_KEY is present", {
    skip: !process.env.ANTHROPIC_API_KEY
  }, async () => {
    const provider = new OpusScriptWriterProvider({
      apiKey: process.env.ANTHROPIC_API_KEY ?? ""
    });
    const script = await provider.writeScript(fixtureDossier(), request, context);

    assert.equal(script.targetDurationMinutes, request.targetDurationMinutes);
    assert.ok(script.chapters.length > 0);
  });
});

function fixtureDossier(): ResearchDossier {
  return {
    subject: request.subject,
    era: request.era,
    location: request.location,
    chronology: [
      "Alexandria grew around its harbor and scholarly institutions in the Ptolemaic period."
    ],
    dailyLifeDetails: [
      "Scribes worked with ink, papyrus, tally marks, and quiet administrative routines."
    ],
    pronunciationCandidates: ["Ptolemaic", "Alexandria"],
    uncertaintyNotes: [
      "Specific workday rhythms are represented cautiously from broader evidence."
    ],
    claims: [
      {
        id: "claim_scribe_routine",
        text: "Scribes used papyrus, ink, and routine recordkeeping in Hellenistic Egypt.",
        sourceIds: ["source_alexandria_daily_life"],
        confidence: "grounded"
      }
    ],
    sources: [
      {
        id: "source_alexandria_daily_life",
        title: "Fixture Daily Life in Hellenistic Egypt",
        publisher: "Sleepy History Fixture Archive"
      }
    ],
    groundingMetadata: [
      {
        provider: "gemini",
        modelId: "gemini-3.1-pro-preview",
        sourceIds: ["source_alexandria_daily_life"]
      }
    ]
  };
}

function fixtureScriptJson(): unknown {
  const chapters = chaptersFixture(8);

  return {
    title: "A Lantern Beside the Harbor",
    synopsis: "A calm original bedtime story about an ordinary scribe ending a day in Alexandria.",
    storyBible: {
      premise: "Follow one ordinary scribe through a quiet evening near the Alexandrian harbor.",
      narrativePointOfView: "second-person-adjacent, gentle third person",
      toneGuidelines: ["slow", "low suspense", "historically grounded", "sleep friendly"],
      historicalBoundaries: ["Use only the dossier's cautious claims and avoid invented famous encounters."],
      pronunciationGuide: ["Ptolemaic", "Alexandria"]
    },
    targetDurationMinutes: 60,
    estimatedTotalWords: 7800,
    wordsPerMinute: 130,
    sourceMap: [
      {
        sourceId: "source_alexandria_daily_life",
        title: "Fixture Daily Life in Hellenistic Egypt",
        claimIds: ["claim_scribe_routine"],
        chapterIds: chapters.map((chapter) => chapter.id)
      }
    ],
    continuitySummary: "Keep the harbor, papyrus room, and household evening rituals slow, grounded, and gentle.",
    chapters
  };
}

function fixturePlanJson(): unknown {
  const script = fixtureScriptJson() as Record<string, unknown>;
  const chapters = chaptersFixture(10, repeatedTranscript(780), 780);

  return {
    ...script,
    sourceMap: [
      {
        sourceId: "source_alexandria_daily_life",
        title: "Fixture Daily Life in Hellenistic Egypt",
        claimIds: ["claim_scribe_routine"],
        chapterIds: chapters.map((chapter) => chapter.id)
      }
    ],
    chapters: chapters.map(({ text: _text, ...chapter }) => chapter)
  };
}

function chaptersFixture(count: number, transcriptText = repeatedTranscript(975), estimatedWords = 975): readonly {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly checkpoint: string;
  readonly summary: string;
  readonly continuitySummary: string;
  readonly estimatedWords: number;
  readonly text: string;
  readonly sourceIds: readonly string[];
}[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `chapter_${String(index + 1).padStart(2, "0")}`,
    index: index + 1,
    title: index === 0 ? "The Harbor Grows Dim" : `A Quiet Passage ${index + 1}`,
    checkpoint: index === 0 ? "Leave the workroom and settle into the harbor evening." : `Continue the gentle evening routine through checkpoint ${index + 1}.`,
    summary: "A slow chapter checkpoint with ordinary work, lamplight, and grounded details.",
    continuitySummary: "Carry forward the same scribe, household route, soft harbor sounds, and low-stakes mood.",
    estimatedWords,
    text: transcriptText,
    sourceIds: ["source_alexandria_daily_life"]
  }));
}

function repeatedTranscript(wordCount: number): string {
  const words = [
    "the",
    "harbor",
    "becomes",
    "slow",
    "and",
    "quiet",
    "while",
    "the",
    "scribe",
    "sets",
    "down",
    "the",
    "reed",
    "pen"
  ];

  return Array.from({ length: wordCount }, (_value, index) => words[index % words.length] ?? "quiet").join(" ");
}

function malformedPlanJson(): string {
  const plan = fixturePlanJson() as Record<string, unknown>;
  const chapters = plan.chapters as readonly Record<string, unknown>[];
  const firstChapter = chapters[0];
  if (!firstChapter) {
    throw new Error("fixture plan must include at least one chapter");
  }

  return [
    "{",
    "\"title\":\"A Lantern Beside the Harbor\",",
    "\"synopsis\":\"A calm original bedtime story about an ordinary scribe ending a day in Alexandria.\",",
    "\"storyBible\":{\"premise\":\"Follow one ordinary scribe.\",\"narrativePointOfView\":\"quiet historical narrator\",\"toneGuidelines\":[\"slow\"],\"historicalBoundaries\":[\"Use only the dossier.\"],\"pronunciationGuide\":[]},",
    "\"targetDurationMinutes\":60,",
    "\"estimatedTotalWords\":7800,",
    "\"wordsPerMinute\":130,",
    "\"sourceMap\":[],",
    "\"continuitySummary\":\"Keep the evening slow.\",",
    "\"chapters\":[",
    JSON.stringify(firstChapter).replace("\"summary\":\"", "\"summary\":\"a quiet \"unescaped\" detail "),
    "]",
    "}"
  ].join("");
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
