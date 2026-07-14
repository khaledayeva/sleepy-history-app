import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCoverArtPrompt } from "../src/coverArtPrompt.js";
import type { CoverArtStoryMetadata } from "../src/coverArtPrompt.js";
import type { StoryScript } from "../src/providers.js";

const metadata: CoverArtStoryMetadata = {
  kind: "daily_life",
  title: "A Lantern Beside the Abbasid Oven",
  subtitle: "A quiet evening in ninth-century Baghdad",
  subject: "a baker in Abbasid Baghdad",
  era: "9th century CE",
  location: "Baghdad",
  perspective: "ordinary baker closing a calm market day",
  synopsis: "A gentle walk through grain, bread ovens, water jars, and a market lane settling toward sleep."
};

describe("cover art prompt builder", () => {
  it("turns story metadata into a historically grounded bedtime cover prompt", () => {
    const result = buildCoverArtPrompt({
      metadata,
      script: fixtureScript(),
      dailyLifeDetails: [
        "flatbread dough resting under cloth",
        "ceramic lamps and shaded brickwork",
        "quiet market tools arranged after closing"
      ]
    });

    assert.ok(result.prompt.length <= 1400);
    assert.match(result.prompt, /Square 1:1 calm bedtime history cover art/);
    assert.match(result.prompt, /Text-free: no written words, letters, numbers, signage, labels, title lettering/);
    assert.match(result.prompt, /A Lantern Beside the Abbasid Oven/);
    assert.match(result.prompt, /A quiet evening in ninth-century Baghdad/);
    assert.match(result.prompt, /a baker in Abbasid Baghdad/);
    assert.match(result.prompt, /9th century CE/);
    assert.match(result.prompt, /Baghdad/);
    assert.match(result.prompt, /ordinary baker closing a calm market day/);
    assert.match(result.prompt, /A gentle walk through grain, bread ovens, water jars/);
    assert.match(result.prompt, /ordinary daily life/);
    assert.match(result.prompt, /flatbread dough resting under cloth/);
    assert.match(result.prompt, /The baker prepares grain, water, cloth, and a quiet workbench/);
    assert.match(result.prompt, /Story-bible cues: A gentle, original story following a baker/);
    assert.match(result.prompt, /quiet third-person bedtime narrator/);
    assert.match(result.prompt, /Stay within sourced Abbasid urban life/);
    assert.match(result.prompt, /Daily Life in Abbasid Baghdad \(Before the First Ember, The Market Softens\)/);
    assert.match(result.prompt, /Bread and Urban Foodways \(The Market Softens\)/);
    assert.match(result.prompt, /hushed, warm, unhurried, low-suspense, sleep-friendly/);
    assert.match(result.prompt, /no text anywhere/);
    assert.match(result.prompt, /Exclude company names/);
    assert.equal(result.prompt, buildCoverArtPrompt({
      metadata,
      script: fixtureScript(),
      dailyLifeDetails: [
        "flatbread dough resting under cloth",
        "ceramic lamps and shaded brickwork",
        "quiet market tools arranged after closing"
      ]
    }).prompt);
  });

  it("keeps the negative prompt concise and focused on excluded artifacts", () => {
    const result = buildCoverArtPrompt({ metadata });

    assert.ok(result.negativePrompt.length < 260);
    assert.match(result.negativePrompt, /text, captions, typography, logo/);
    assert.match(result.negativePrompt, /watermark/);
    assert.match(result.negativePrompt, /modern UI/);
    assert.match(result.negativePrompt, /copyrighted character/);
    assert.match(result.negativePrompt, /combat, horror, gore, weapons/);
  });

  it("scrubs branded, imitation, modern artifact, and intense imagery from story cues", () => {
    const unsafeMetadata: CoverArtStoryMetadata = {
      ...metadata,
      subject: "Boring History For Sleep podcast cover of a battlefield baker with weapons",
      title: "Sleepy History x Studio Ghibli",
      synopsis: "In the style of Disney with logo marks, combat, blood, and nightmare flames."
    };
    const unsafeScript: Pick<StoryScript, "storyBible" | "sourceMap" | "chapters"> = {
      storyBible: {
        premise: "Netflix podcast logo about a combat bakery.",
        narrativePointOfView: "modern UI screen narrator with captions.",
        toneGuidelines: ["no typography", "very gentle"],
        historicalBoundaries: ["No Disney logo, neon screens, blood, or nightmare imagery."],
        pronunciationGuide: []
      },
      sourceMap: [
        {
          sourceId: "unsafe_source",
          title: "Star Wars source with Studio Ghibli logo",
          claimIds: ["claim_unsafe"],
          chapterIds: ["unsafe_chapter"]
        }
      ],
      chapters: [
        {
          id: "unsafe_chapter",
          index: 1,
          title: "Episode logo chapter",
          checkpoint: "A neon screen caption appears beside weapons.",
          summary: "A calm market table with folded linen.",
          continuitySummary: "Keep the market table with folded linen.",
          estimatedWords: 900,
          text: "The table waits.",
          sourceIds: ["unsafe_source"]
        }
      ]
    };

    const result = buildCoverArtPrompt({
      metadata: unsafeMetadata,
      script: unsafeScript,
      dailyLifeDetails: [
        "podcast episode logo with neon UI",
        "market table with folded linen"
      ]
    });

    assert.doesNotMatch(result.prompt, /Boring History For Sleep/i);
    assert.doesNotMatch(result.prompt, /podcast/i);
    assert.doesNotMatch(result.prompt, /Netflix/i);
    assert.doesNotMatch(result.prompt, /Star Wars/i);
    assert.doesNotMatch(result.prompt, /Disney/i);
    assert.doesNotMatch(result.prompt, /Ghibli/i);
    assert.doesNotMatch(result.prompt, /neon|modern UI|\bUI\b|screens?|captions?|typography|logo|watermark/i);
    assert.doesNotMatch(result.prompt, /battlefield|combat|weapons|blood|nightmare/i);
    assert.match(result.prompt, /market table with folded linen/);
    assert.match(result.prompt, /Text-free: no written words/);
    assert.match(result.negativePrompt, /logo/);
  });

  it("uses calm fallback context when optional era, location, and script details are absent", () => {
    const sparseMetadata: CoverArtStoryMetadata = {
      kind: "historical_figure",
      title: "A Quiet Hour",
      subject: "Hypatia",
      synopsis: "A calm historical portrait centered on study, teaching, and evening streets."
    };

    const result = buildCoverArtPrompt({ metadata: sparseMetadata });

    assert.match(result.prompt, /Hypatia/);
    assert.match(result.prompt, /the relevant historical period/);
    assert.match(result.prompt, /the historically appropriate setting/);
    assert.match(result.prompt, /respectful quiet portrait from a distance/);
    assert.match(result.prompt, /no faces in close-up/);
  });
});

function fixtureScript(): Pick<StoryScript, "storyBible" | "sourceMap" | "chapters"> {
  return {
    storyBible: {
      premise: "A gentle, original story following a baker through ordinary historical routines.",
      narrativePointOfView: "quiet third-person bedtime narrator",
      toneGuidelines: ["slow", "factual", "very gentle", "low suspense"],
      historicalBoundaries: [
        "Stay within sourced Abbasid urban life and bread-making evidence.",
        "Treat uncertain details as atmosphere rather than claims."
      ],
      pronunciationGuide: ["Abbasid", "Baghdad"]
    },
    sourceMap: [
      {
        sourceId: "source_abbasid_baghdad",
        title: "Daily Life in Abbasid Baghdad",
        claimIds: ["claim_urban_life"],
        chapterIds: ["chapter_01", "chapter_02"]
      },
      {
        sourceId: "source_medieval_bread",
        title: "Bread and Urban Foodways",
        claimIds: ["claim_bread"],
        chapterIds: ["chapter_02"]
      }
    ],
    chapters: [
      {
        id: "chapter_01",
        index: 1,
        title: "Before the First Ember",
        checkpoint: "The bakery opens in pre-dawn quiet.",
        summary: "The baker prepares grain, water, cloth, and a quiet workbench.",
        continuitySummary: "Keep the same soft workroom and ordinary tools.",
        estimatedWords: 900,
        text: "The oven room is still.",
        sourceIds: ["source_abbasid_baghdad"]
      },
      {
        id: "chapter_02",
        index: 2,
        title: "The Market Softens",
        checkpoint: "The stall closes in a gentle market lane.",
        summary: "Neighbors trade small words as the market grows softer.",
        continuitySummary: "Carry the slow market atmosphere forward.",
        estimatedWords: 900,
        text: "The market settles.",
        sourceIds: ["source_abbasid_baghdad", "source_medieval_bread"]
      }
    ]
  };
}
