import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachContentReviewToJob, rewriteOverlyIntensePassages, reviewGenerationRequest, reviewStoryScript } from "../src/contentReview.js";
import { createGenerationRequest } from "../src/generationRequests.js";
import type { ResearchDossier, StoryScript } from "../src/providers.js";
import type { GenerationJob } from "../src/schemas.js";

const now = () => "2026-05-10T02:00:00.000Z";

describe("content review pass", () => {
  it("blocks disallowed prompt and imitation requests before provider work", () => {
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "copy the podcast script exactly like Boring History for Sleep",
      perspective: "in the voice of the host"
    });
    const review = reviewGenerationRequest(request, now);

    assert.equal(review.reviewStatus, "blocked");
    assert.equal(review.promptPolicyDecision, "block");
    assert.equal(review.inspirationMimicryCheck, "blocked");
    assert.equal(review.publicFigureVoiceCheck, "blocked");
    assert.match(review.promptPolicyReasons.join("\n"), /copy another work|imitation/);
    assert.equal(review.reviewedAt, "2026-05-10T02:00:00.000Z");
  });

  it("allows contextual historical violence only when requested safety allows it", () => {
    const blocked = reviewGenerationRequest(createGenerationRequest({
      kind: "historical_figure",
      subject: "a calm account of a siege",
      allowHistoricalViolenceContext: false
    }), now);
    const allowed = reviewGenerationRequest(createGenerationRequest({
      kind: "historical_figure",
      subject: "a calm account of a siege",
      allowHistoricalViolenceContext: true
    }), now);

    assert.equal(blocked.reviewStatus, "blocked");
    assert.equal(blocked.historicalViolenceLevel, "blocked_graphic");
    assert.equal(allowed.reviewStatus, "passed");
    assert.equal(allowed.historicalViolenceLevel, "contextual");
  });

  it("marks intense passages for rewrite and stores review metadata", () => {
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a baker in Abbasid Baghdad",
      era: "9th century CE",
      location: "Baghdad",
      perspective: "ordinary worker closing a market day"
    });
    const review = reviewStoryScript(request, fixtureDossier(), {
      ...fixtureScript(),
      chapters: [
        {
          ...fixtureScript().chapters[0],
          text: "The quiet day becomes a terrifying nightmare, but then disaster struck near the oven."
        }
      ]
    }, now);

    assert.equal(review.reviewStatus, "rewrite_required");
    assert.deepEqual(review.rewriteRequiredChapterIds, ["chapter_01"]);
    assert.equal(review.fictionalizedPov, "fictional_composite");
    assert.equal(review.aiDisclosureRequired, true);
    assert.equal(review.findings.some((finding) => finding.code === "horror_pacing"), true);
    assert.equal(review.findings.some((finding) => finding.code === "cliffhanger"), true);
  });

  it("rewrites overly intense passages into calmer bedtime language", () => {
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a baker in Abbasid Baghdad"
    });
    const script = {
      ...fixtureScript(),
      chapters: [
        {
          ...fixtureScript().chapters[0],
          text: "The terrifying nightmare fades, but then disaster struck beside the oven."
        }
      ]
    };
    const review = reviewStoryScript(request, fixtureDossier(), script, now);
    const rewritten = rewriteOverlyIntensePassages(script, review);
    const rewrittenReview = reviewStoryScript(request, fixtureDossier(), rewritten, now);

    assert.match(rewritten.chapters[0]?.text ?? "", /difficult troubled memory/);
    assert.doesNotMatch(rewritten.chapters[0]?.text ?? "", /terrifying|nightmare|disaster struck/);
    assert.equal(rewrittenReview.reviewStatus, "passed");
  });

  it("detects copied source phrasing in generated chapter text", () => {
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a scribe in Ptolemaic Alexandria"
    });
    const sourcePhrase = "Papyrus records reveal quiet administrative routines beside the harbor with reed pens and ink";
    const review = reviewStoryScript(request, {
      ...fixtureDossier(),
      sources: [
        {
          id: "source_copied",
          title: sourcePhrase,
          publisher: "Fixture Archive"
        }
      ]
    }, {
      ...fixtureScript(),
      sourceMap: [
        {
          sourceId: "source_copied",
          title: sourcePhrase,
          claimIds: ["claim_scribe"],
          chapterIds: ["chapter_01"]
        }
      ],
      chapters: [
        {
          ...fixtureScript().chapters[0],
          sourceIds: ["source_copied"],
          text: `The scribe remembers that ${sourcePhrase} before setting down the lamp.`
        }
      ]
    }, now);

    assert.equal(review.reviewStatus, "rewrite_required");
    assert.equal(review.findings[0]?.code, "copied_source_phrase");
    assert.equal(review.findings[0]?.sourceId, "source_copied");
  });

  it("passes a gentle original script", () => {
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a gardener in Heian Kyoto",
      era: "11th century CE",
      location: "Kyoto"
    });
    const review = reviewStoryScript(request, fixtureDossier(), fixtureScript(), now);

    assert.equal(review.reviewStatus, "passed");
    assert.equal(review.promptPolicyDecision, "allow");
    assert.deepEqual(review.findings, []);
  });

  it("stores review findings in job metadata", () => {
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a baker in Abbasid Baghdad"
    });
    const review = reviewStoryScript(request, fixtureDossier(), {
      ...fixtureScript(),
      chapters: [
        {
          ...fixtureScript().chapters[0],
          text: "The quiet day becomes a terrifying nightmare."
        }
      ]
    }, now);
    const updatedJob = attachContentReviewToJob(job(request), review);

    assert.equal(updatedJob.metadata?.contentReview?.review_status, "rewrite_required");
    assert.equal(updatedJob.metadata?.contentReview?.content_policy_version, "2026-05-09");
    assert.deepEqual(updatedJob.metadata?.contentReview?.rewrite_required_chapter_ids, ["chapter_01"]);
    assert.equal(Array.isArray(updatedJob.metadata?.contentReview?.findings), true);
  });
});

function fixtureDossier(): ResearchDossier {
  return {
    subject: "a baker in Abbasid Baghdad",
    era: "9th century CE",
    location: "Baghdad",
    chronology: ["Market ovens served neighborhoods before dawn."],
    dailyLifeDetails: ["Bakers prepared dough, tended ovens, and sold bread in calm morning rhythms."],
    pronunciationCandidates: ["Abbasid", "Baghdad"],
    uncertaintyNotes: ["Exact household routines varied by district."],
    claims: [
      {
        id: "claim_bread",
        text: "Bread work relied on ovens and markets.",
        sourceIds: ["source_foodways"],
        confidence: "grounded"
      }
    ],
    sources: [
      {
        id: "source_foodways",
        title: "Fixture Urban Foodways",
        publisher: "Sleepy History Fixture Archive"
      }
    ],
    groundingMetadata: [
      {
        provider: "gemini",
        modelId: "gemini-3.1-pro-preview",
        sourceIds: ["source_foodways"]
      }
    ]
  };
}

function fixtureScript(): StoryScript {
  return {
    title: "A Quiet Oven at Dawn",
    synopsis: "A calm story about ordinary bread work.",
    storyBible: {
      premise: "Follow an ordinary worker through a gentle market day.",
      narrativePointOfView: "quiet third person",
      toneGuidelines: ["slow", "gentle"],
      historicalBoundaries: ["Stay within sourced daily-life details."],
      pronunciationGuide: ["Abbasid", "Baghdad"]
    },
    targetDurationMinutes: 60,
    estimatedTotalWords: 7800,
    wordsPerMinute: 130,
    sourceMap: [
      {
        sourceId: "source_foodways",
        title: "Fixture Urban Foodways",
        claimIds: ["claim_bread"],
        chapterIds: ["chapter_01"]
      }
    ],
    continuitySummary: "Keep the morning market quiet and grounded.",
    chapters: [
      {
        id: "chapter_01",
        index: 1,
        title: "Before the Market Opens",
        checkpoint: "Introduce the oven, street, and slow routine.",
        summary: "A gentle opening in the bakery.",
        continuitySummary: "Keep sensory details soft and low drama.",
        estimatedWords: 7800,
        text: "The oven is warm, the street is quiet, and the baker moves through familiar work with an easy pace.",
        sourceIds: ["source_foodways"]
      }
    ]
  };
}

function job(request: GenerationJob["request"]): GenerationJob {
  return {
    id: "job_content_review",
    status: "reviewing",
    request,
    progress: {
      stage: "reviewing",
      percent: 50
    },
    createdAt: "2026-05-10T02:00:00.000Z",
    updatedAt: "2026-05-10T02:00:00.000Z"
  };
}
