import type { StoryMetadata } from "./domain.js";
import type { ScriptChapter, ScriptSourceMapEntry, StoryScript } from "./providers.js";

export interface CoverArtPromptInput {
  readonly metadata: CoverArtStoryMetadata;
  readonly script?: Pick<StoryScript, "storyBible" | "sourceMap" | "chapters">;
  readonly dailyLifeDetails?: readonly string[];
}

export interface CoverArtPrompt {
  readonly prompt: string;
  readonly negativePrompt: string;
}

export type CoverArtStoryMetadata = Pick<
  StoryMetadata,
  "kind" | "subject" | "title" | "subtitle" | "era" | "location" | "perspective" | "synopsis"
>;

const MAX_CUES = 4;
const MAX_PROMPT_LENGTH = 1400;

const bannedReferencePatterns: readonly RegExp[] = [
  /\bboring\s+history\s+for\s+sleep\b/gi,
  /\bhistory\s*and\s*sleep\s*official\b/gi,
  /\bsleepy\s+history\b/gi,
  /\bpodcast\b/gi,
  /\bepisode\b/gi,
  /\bnetflix\b/gi,
  /\bdisney\b/gi,
  /\bmarvel\b/gi,
  /\bstar\s+wars\b/gi,
  /\bpixar\b/gi,
  /\bstudio\s+ghibli\b/gi,
  /\bghibli\b/gi,
  /\bin\s+the\s+style\s+of\b/gi,
  /\bcover\s+of\b/gi,
  /\blogo\b/gi,
  /\bbrand(?:ed|ing)?\b/gi
];

const intensePatterns: readonly RegExp[] = [
  /\bbattle(?:field|s)?\b/gi,
  /\bcombat\b/gi,
  /\bwarfare\b/gi,
  /\bsoldier(?:s)?\b/gi,
  /\bweapon(?:s)?\b/gi,
  /\bblood(?:y)?\b/gi,
  /\bgore\b/gi,
  /\bhorror\b/gi,
  /\bterrifying\b/gi,
  /\bnightmare\b/gi,
  /\bscreaming?\b/gi,
  /\bexecution(?:s)?\b/gi,
  /\bcorpse(?:s)?\b/gi
];

const modernArtifactPatterns: readonly RegExp[] = [
  /\bmodern\s+UI\b/gi,
  /\bUI\b/g,
  /\bneon\b/gi,
  /\bscreen(?:s)?\b/gi,
  /\bwatermark\b/gi,
  /\bcaption(?:s)?\b/gi,
  /\btypography\b/gi
];

const negativePrompt = [
  "text, captions, typography, logo, watermark, brand marks",
  "modern UI, screens, neon, sci-fi elements, anachronistic objects",
  "celebrity likeness, copyrighted character, podcast cover imitation",
  "combat, horror, gore, weapons, flames, panic, harsh contrast"
].join("; ");

export function buildCoverArtPrompt(input: CoverArtPromptInput): CoverArtPrompt {
  const metadata = input.metadata;
  const title = cleanCue(metadata.title);
  const subtitle = cleanCue(metadata.subtitle);
  const subject = cleanCue(metadata.subject) || "a quiet historical subject";
  const era = cleanCue(metadata.era) || "the relevant historical period";
  const location = cleanCue(metadata.location) || "the historically appropriate setting";
  const perspective = cleanCue(metadata.perspective) || defaultPerspective(metadata.kind);
  const synopsis = cleanCue(metadata.synopsis);
  const storyIdentity = selectCues([title, subtitle], 2);
  const chapterCues = buildChapterCues(input.script?.chapters);
  const narrativeCues = selectCues([
    ...(input.dailyLifeDetails ?? []),
    ...chapterCues
  ]);
  const storyBibleCues = buildStoryBibleCues(input.script?.storyBible);
  const sourceCues = buildSourceCues(input.script?.sourceMap, input.script?.chapters);

  const sections = [
    `Square 1:1 calm bedtime history cover art about ${subject}. Text-free: no written words, letters, numbers, signage, labels, title lettering, or maker marks anywhere.`,
    storyIdentity.length > 0 ? `Story identity used only as visual context: ${storyIdentity.join("; ")}.` : undefined,
    `Anchor: ${era}, ${location}; viewpoint: ${perspective}.`,
    synopsis ? `Synopsis: ${synopsis}.` : undefined,
    `Scene details: ordinary daily life, period clothing, tools, architecture, foodways, and evening light for ${location} in ${era}.`,
    narrativeCues.length > 0 ? `Narrative/script cues: ${narrativeCues.join("; ")}.` : undefined,
    storyBibleCues.length > 0 ? `Story-bible cues: ${storyBibleCues.join("; ")}.` : undefined,
    sourceCues.length > 0 ? `Source-map cues to honor: ${sourceCues.join("; ")}.` : undefined,
    "Style: hushed, warm, unhurried, low-suspense, sleep-friendly painterly editorial illustration, soft natural palette, restful negative space, no faces in close-up, no text anywhere.",
    "Exclude company names, franchise cues, anachronisms, and sensational imagery."
  ].filter((section): section is string => Boolean(section));

  return {
    prompt: truncatePrompt(sections.join(" ")),
    negativePrompt
  };
}

function buildChapterCues(chapters: readonly ScriptChapter[] | undefined): readonly string[] {
  if (!chapters) {
    return [];
  }

  return selectCues(chapters.flatMap((chapter) => [
    chapter.summary,
    chapter.checkpoint,
    chapter.continuitySummary
  ]));
}

function buildStoryBibleCues(storyBible: StoryScript["storyBible"] | undefined): readonly string[] {
  if (!storyBible) {
    return [];
  }

  return selectCues([
    storyBible.premise,
    storyBible.narrativePointOfView,
    ...storyBible.historicalBoundaries,
    ...storyBible.toneGuidelines
  ], 3);
}

function buildSourceCues(
  sourceMap: readonly ScriptSourceMapEntry[] | undefined,
  chapters: readonly ScriptChapter[] | undefined
): readonly string[] {
  if (!sourceMap) {
    return [];
  }

  const chaptersById = new Map((chapters ?? []).map((chapter) => [chapter.id, chapter]));
  return selectCues(sourceMap.flatMap((entry) => {
    const chapterCues = entry.chapterIds
      .map((chapterId) => {
        const chapter = chaptersById.get(chapterId);
        if (!chapter) {
          return undefined;
        }

        return cleanCue(chapter.title);
      })
      .filter((cue): cue is string => Boolean(cue));
    const titleCue = cleanCue(entry.title);
    const chapterCue = selectCues(chapterCues, 2).join(", ");

    if (!titleCue) {
      return chapterCue;
    }

    return chapterCue ? `${titleCue} (${chapterCue})` : titleCue;
  }));
}

function selectCues(values: readonly string[], limit = MAX_CUES): readonly string[] {
  const selected: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const cue = cleanCue(value);
    const key = cue.toLowerCase();
    if (!cue || seen.has(key)) {
      continue;
    }

    seen.add(key);
    selected.push(cue);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

function defaultPerspective(kind: StoryMetadata["kind"]): string {
  return kind === "historical_figure"
    ? "a respectful quiet portrait from a distance"
    : "an ordinary person moving through calm routines";
}

function cleanCue(value: string | undefined): string {
  if (!value) {
    return "";
  }

  let cleaned = value.normalize("NFKC");
  for (const pattern of [...bannedReferencePatterns, ...intensePatterns, ...modernArtifactPatterns]) {
    cleaned = cleaned.replace(pattern, "");
  }

  return cleaned
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "")
    .trim();
}

function truncatePrompt(prompt: string): string {
  if (prompt.length <= MAX_PROMPT_LENGTH) {
    return prompt;
  }

  return `${prompt.slice(0, MAX_PROMPT_LENGTH - 1).replace(/\s+\S*$/, "")}.`;
}
