import type { ProviderContext, ScriptChapter, StoryScript, VoiceSettings } from "./providers.js";
import { providerIdempotencyKey } from "./durableQueue.js";

export interface TtsChunkingOptions {
  readonly maxCharacters?: number;
  readonly targetCharacters?: number;
}

export interface TtsChunk {
  readonly chunkId: string;
  readonly chapterId: string;
  readonly index: number;
  readonly text: string;
  readonly characterCount: number;
  readonly continuityContext: string;
  readonly previousChunkId?: string;
  readonly nextChunkId?: string;
  readonly providerRequestId: string;
  readonly idempotencyKey: string;
}

export interface TtsChapterPlan {
  readonly chapterId: string;
  readonly title: string;
  readonly chunks: readonly TtsChunk[];
}

export interface TtsPlan {
  readonly storyTitle: string;
  readonly voiceId: string;
  readonly settings?: Partial<VoiceSettings>;
  readonly chapters: readonly TtsChapterPlan[];
}

export function createTtsPlan(
  script: StoryScript,
  voiceId: string,
  context: ProviderContext,
  settings?: Partial<VoiceSettings>,
  options: TtsChunkingOptions = {}
): TtsPlan {
  const maxCharacters = options.maxCharacters ?? 4500;
  const targetCharacters = options.targetCharacters ?? Math.min(3800, maxCharacters);
  if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) {
    throw new Error("TTS maxCharacters must be a positive integer");
  }
  if (!Number.isInteger(targetCharacters) || targetCharacters <= 0) {
    throw new Error("TTS targetCharacters must be a positive integer");
  }
  if (targetCharacters > maxCharacters) {
    throw new Error("TTS targetCharacters must be at most maxCharacters");
  }

  const chapters = script.chapters.map((chapter) => createChapterPlan(
    script,
    chapter,
    voiceId,
    context,
    targetCharacters,
    maxCharacters
  ));

  return {
    storyTitle: script.title,
    voiceId,
    settings,
    chapters
  };
}

function createChapterPlan(
  script: StoryScript,
  chapter: ScriptChapter,
  voiceId: string,
  context: ProviderContext,
  targetCharacters: number,
  maxCharacters: number
): TtsChapterPlan {
  const textChunks = splitText(chapter.text, targetCharacters, maxCharacters);
  const chunkIds = textChunks.map((_text, index) => `${chapter.id}_tts_${String(index + 1).padStart(3, "0")}`);
  const chunks = textChunks.map((text, index): TtsChunk => {
    const chunkId = chunkIds[index] ?? `${chapter.id}_tts_${String(index + 1).padStart(3, "0")}`;

    return {
      chunkId,
      chapterId: chapter.id,
      index: index + 1,
      text,
      characterCount: text.length,
      continuityContext: buildContinuityContext(script, chapter, index + 1, textChunks.length),
      previousChunkId: chunkIds[index - 1],
      nextChunkId: chunkIds[index + 1],
      providerRequestId: `${context.jobId}:${voiceId}:${chunkId}`,
      idempotencyKey: providerIdempotencyKey(context.jobId, "voice", chunkId)
    };
  });

  return {
    chapterId: chapter.id,
    title: chapter.title,
    chunks
  };
}

function splitText(text: string, targetCharacters: number, maxCharacters: number): readonly string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new Error("TTS chapter text must be non-empty");
  }
  if (normalized.length <= maxCharacters) {
    return [normalized];
  }

  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (sentence.length > maxCharacters) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitLongSentence(sentence, maxCharacters));
      continue;
    }

    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > targetCharacters && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
}

function splitLongSentence(sentence: string, maxCharacters: number): readonly string[] {
  const words = sentence.split(/\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const word of words) {
    if (word.length > maxCharacters) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitOverlongToken(word, maxCharacters));
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharacters && current) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitOverlongToken(value: string, maxCharacters: number): readonly string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += maxCharacters) {
    chunks.push(value.slice(index, index + maxCharacters));
  }

  return chunks;
}

function buildContinuityContext(script: StoryScript, chapter: ScriptChapter, chunkIndex: number, chunkCount: number): string {
  return [
    `Story: ${script.title}`,
    `Global continuity: ${script.continuitySummary}`,
    `Chapter ${chapter.index}: ${chapter.title}`,
    `Chapter continuity: ${chapter.continuitySummary}`,
    `Chunk ${chunkIndex} of ${chunkCount}. Maintain the same calm narrator, slow pace, pronunciation choices, and room tone.`
  ].join("\n");
}
