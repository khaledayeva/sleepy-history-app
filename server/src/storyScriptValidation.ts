import type { StoryScript } from "./providers.js";

export interface StoryScriptValidationOptions {
  readonly targetDurationMinutes?: number;
  readonly durationToleranceMinutes?: number;
}

export function defaultDurationToleranceMinutes(targetDurationMinutes: number): number {
  return Math.max(3, targetDurationMinutes * 0.25);
}

export interface StoryScriptValidationResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly estimatedDurationMinutes: number;
}

export interface StoryScriptDiagnostics {
  readonly title: string;
  readonly targetDurationMinutes: number;
  readonly estimatedDurationMinutes: number;
  readonly wordsPerMinute: number;
  readonly estimatedTotalWords: number;
  readonly actualTotalWords: number;
  readonly issues: readonly string[];
  readonly chapters: readonly {
    readonly id: string;
    readonly index: number;
    readonly title: string;
    readonly targetWords: number;
    readonly actualWords: number;
    readonly deltaWords: number;
    readonly withinTolerance: boolean;
  }[];
}

export class StoryScriptValidationError extends Error {
  constructor(
    readonly script: StoryScript,
    readonly result: StoryScriptValidationResult,
    readonly diagnostics: StoryScriptDiagnostics
  ) {
    super(`Story script validation failed: ${result.issues.join("; ")}`);
    this.name = "StoryScriptValidationError";
  }
}

export function validateStoryScript(
  script: StoryScript,
  options: StoryScriptValidationOptions = {}
): StoryScriptValidationResult {
  const issues: string[] = [];
  const chapterIds = new Set(script.chapters.map((chapter) => chapter.id));
  const sourceIds = new Set(script.sourceMap.map((source) => source.sourceId));
  const totalEstimatedWords = script.chapters.reduce((sum, chapter) => sum + chapter.estimatedWords, 0);
  const totalTranscriptWords = script.chapters.reduce((sum, chapter) => sum + countWords(chapter.text), 0);
  const wordsPerMinute = script.wordsPerMinute > 0 ? script.wordsPerMinute : 130;
  const estimatedDurationMinutes = totalTranscriptWords / wordsPerMinute;
  const targetDurationMinutes = options.targetDurationMinutes ?? script.targetDurationMinutes;
  const tolerance = options.durationToleranceMinutes ?? defaultDurationToleranceMinutes(targetDurationMinutes);

  if (!script.storyBible.premise || !script.storyBible.narrativePointOfView) {
    issues.push("missing story bible premise or point of view");
  }
  if (script.storyBible.toneGuidelines.length === 0) {
    issues.push("missing story bible tone guidelines");
  }
  if (script.storyBible.historicalBoundaries.length === 0) {
    issues.push("missing story bible historical boundaries");
  }
  if (script.chapters.length < 8 || script.chapters.length > 12) {
    issues.push("script must include 8 to 12 chapter checkpoints");
  }
  if (script.sourceMap.length === 0) {
    issues.push("missing source map");
  }
  if (Math.abs(script.estimatedTotalWords - totalEstimatedWords) > script.chapters.length) {
    issues.push("estimated total words does not match chapter word estimates");
  }
  if (Math.abs(script.estimatedTotalWords - totalTranscriptWords) > Math.max(script.chapters.length * 20, script.estimatedTotalWords * 0.15)) {
    issues.push("estimated total words does not match transcript word count");
  }
  if (Math.abs(estimatedDurationMinutes - targetDurationMinutes) > tolerance) {
    issues.push("estimated duration falls outside tolerance");
  }

  for (const [index, chapter] of script.chapters.entries()) {
    if (chapter.index !== index + 1) {
      issues.push(`chapter ${chapter.id} has non-sequential index`);
    }
    if (!chapter.checkpoint) {
      issues.push(`chapter ${chapter.id} missing checkpoint`);
    }
    if (!chapter.continuitySummary) {
      issues.push(`chapter ${chapter.id} missing continuity summary`);
    }
    if (!chapter.text) {
      issues.push(`chapter ${chapter.id} missing transcript text`);
    }
    if (chapter.estimatedWords <= 0) {
      issues.push(`chapter ${chapter.id} missing estimated words`);
    }
    if (Math.abs(chapter.estimatedWords - countWords(chapter.text)) > Math.max(20, chapter.estimatedWords * 0.15)) {
      issues.push(`chapter ${chapter.id} estimated words do not match transcript text`);
    }
    if (chapter.sourceIds.length === 0) {
      issues.push(`chapter ${chapter.id} missing source IDs`);
    }
    for (const sourceId of chapter.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        issues.push(`chapter ${chapter.id} references unmapped source ${sourceId}`);
      }
    }
  }

  for (const entry of script.sourceMap) {
    for (const chapterId of entry.chapterIds) {
      if (!chapterIds.has(chapterId)) {
        issues.push(`source map entry ${entry.sourceId} references unknown chapter ${chapterId}`);
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    estimatedDurationMinutes
  };
}

export function assertValidStoryScript(
  script: StoryScript,
  options: StoryScriptValidationOptions = {}
): StoryScript {
  const result = validateStoryScript(script, options);
  if (!result.ok) {
    throw new StoryScriptValidationError(script, result, createStoryScriptDiagnostics(script, result));
  }

  return script;
}

export function createStoryScriptDiagnostics(
  script: StoryScript,
  result: StoryScriptValidationResult = validateStoryScript(script)
): StoryScriptDiagnostics {
  const actualTotalWords = script.chapters.reduce((sum, chapter) => sum + countWords(chapter.text), 0);

  return {
    title: script.title,
    targetDurationMinutes: script.targetDurationMinutes,
    estimatedDurationMinutes: result.estimatedDurationMinutes,
    wordsPerMinute: script.wordsPerMinute,
    estimatedTotalWords: script.estimatedTotalWords,
    actualTotalWords,
    issues: result.issues,
    chapters: script.chapters.map((chapter) => {
      const actualWords = countWords(chapter.text);
      const deltaWords = actualWords - chapter.estimatedWords;
      return {
        id: chapter.id,
        index: chapter.index,
        title: chapter.title,
        targetWords: chapter.estimatedWords,
        actualWords,
        deltaWords,
        withinTolerance: Math.abs(deltaWords) <= Math.max(20, chapter.estimatedWords * 0.15)
      };
    })
  };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
