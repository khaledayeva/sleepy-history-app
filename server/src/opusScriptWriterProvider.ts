import type { GenerationRequest } from "./schemas.js";
import type {
  ProviderContext,
  ProviderQuotaDetails,
  ProviderQuotaExceededError as ProviderQuotaExceededErrorType,
  ResearchDossier,
  ScriptChapter,
  StoryScript,
  WriterProgressEvent,
  WriterProvider
} from "./providers.js";
import { ProviderQuotaExceededError } from "./providers.js";
import {
  assertValidStoryScript,
  createStoryScriptDiagnostics,
  defaultDurationToleranceMinutes,
  StoryScriptValidationError
} from "./storyScriptValidation.js";

export interface OpusScriptWriterConfig {
  readonly apiKey: string;
  readonly modelId?: string;
  readonly baseUrl?: string;
  readonly anthropicVersion?: string;
  readonly maxTokens?: number;
  readonly fetchImpl?: typeof fetch;
}

interface AnthropicMessageResponse {
  readonly id?: string;
  readonly content?: readonly {
    readonly type?: string;
    readonly text?: string;
  }[];
}

interface AnthropicErrorResponse {
  readonly type?: string;
  readonly error?: {
    readonly type?: string;
    readonly message?: string;
  };
  readonly request_id?: string;
}

type ScriptPlanChapter = Omit<ScriptChapter, "text">;

interface StoryScriptPlan extends Omit<StoryScript, "chapters"> {
  readonly chapters: readonly ScriptPlanChapter[];
}

export class OpusScriptWriterProvider implements WriterProvider {
  readonly name = "opus-script-writer";
  private readonly modelId: string;
  private readonly baseUrl: string;
  private readonly anthropicVersion: string;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpusScriptWriterConfig) {
    this.modelId = config.modelId ?? "claude-opus-4-6";
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com/v1";
    this.anthropicVersion = config.anthropicVersion ?? "2023-06-01";
    this.maxTokens = config.maxTokens ?? 8192;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async writeScript(
    dossier: ResearchDossier,
    request: GenerationRequest,
    context: ProviderContext
  ): Promise<StoryScript> {
    await reportWriterProgress(context, {
      phase: "plan",
      message: "Planning story bible and chapter targets"
    });
    const plan = normalizePlanWordTargets(await this.parseScriptPlanWithRepair(
      await this.sendMessage(writerSystemPrompt(), writerPlanPrompt(dossier, request), context, "plan"),
      request,
      context
    ), request);
    await reportWriterProgress(context, {
      phase: "plan",
      chapterCount: plan.chapters.length,
      targetWords: plan.estimatedTotalWords,
      message: `Planned ${plan.chapters.length} chapters for ${plan.estimatedTotalWords} target words`
    });
    const chapters: ScriptChapter[] = [];

    for (const chapter of plan.chapters) {
      const text = await this.writeChapterTranscript(dossier, request, plan, chapter, context);
      chapters.push({
        ...chapter,
        text
      });
    }

    const fittedChapters = fitOverlongChaptersToDuration(plan, chapters, request);
    const draftScript: StoryScript = {
      ...plan,
      chapters: fittedChapters
    };
    let script: StoryScript;
    try {
      script = assertValidStoryScript(normalizePlanWithTranscriptCounts(plan, fittedChapters), {
        targetDurationMinutes: request.targetDurationMinutes
      });
    } catch (error) {
      if (error instanceof StoryScriptValidationError || isStoryScriptValidationErrorLike(error)) {
        const validationError = error as StoryScriptValidationError;
        throw new StoryScriptValidationError(
          draftScript,
          validationError.result,
          createStoryScriptDiagnostics(draftScript, validationError.result)
        );
      }
      throw error;
    }
    await reportWriterProgress(context, {
      phase: "complete",
      chapterCount: script.chapters.length,
      targetWords: script.estimatedTotalWords,
      actualWords: script.estimatedTotalWords,
      message: `Completed ${script.chapters.length} chapter transcripts`
    });
    return script;
  }

  private async writeChapterTranscript(
    dossier: ResearchDossier,
    request: GenerationRequest,
    plan: StoryScriptPlan,
    chapter: ScriptPlanChapter,
    context: ProviderContext
  ): Promise<string> {
    const firstText = await this.parseChapterTranscriptWithRepair(
      await this.sendMessage(writerSystemPrompt(), writerChapterPrompt(dossier, request, plan, chapter), context, chapter.id),
      chapter.id,
      context,
      chapter.id
    );
    const firstWordCount = countWords(firstText);
    if (isWithinWordTolerance(firstWordCount, chapter.estimatedWords)) {
      await reportWriterProgress(context, chapterProgressEvent("chapter", chapter, plan.chapters.length, firstWordCount));
      return firstText;
    }

    await reportWriterProgress(context, {
      ...chapterProgressEvent("chapter", chapter, plan.chapters.length, firstWordCount),
      message: `Chapter ${chapter.index} missed target and will be repaired`
    });
    const repairedText = await this.parseChapterTranscriptWithRepair(
      await this.sendMessage(
        writerSystemPrompt(),
        writerChapterRepairPrompt(dossier, request, plan, chapter, firstText, firstWordCount),
        context,
        `${chapter.id}:repair`
      ),
      chapter.id,
      context,
      `${chapter.id}:repair`
    );
    await reportWriterProgress(context, chapterProgressEvent(
      "repair",
      chapter,
      plan.chapters.length,
      countWords(repairedText)
    ));

    return repairedText;
  }

  private async sendMessage(
    system: string,
    content: string,
    context: ProviderContext,
    operationId: string
  ): Promise<unknown> {
    const idempotencyKey = context.idempotencyKey ? `${context.idempotencyKey}:${operationId}` : undefined;
    const response = await this.fetchImpl(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": this.anthropicVersion,
        "X-Sleepy-History-Job": context.jobId,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
      },
      body: JSON.stringify({
        model: this.modelId,
        max_tokens: this.maxTokens,
        system,
        messages: [
          {
            role: "user",
            content
          }
        ]
      })
    });

    if (!response.ok) {
      throw await opusRequestError(response);
    }

    return response.json();
  }

  private async parseScriptPlanWithRepair(
    input: unknown,
    request: GenerationRequest,
    context: ProviderContext
  ): Promise<StoryScriptPlan> {
    try {
      return parseOpusScriptPlanResponse(input, request);
    } catch (error) {
      if (!isMalformedModelJsonError(error)) {
        throw error;
      }

      await reportWriterProgress(context, {
        phase: "plan",
        message: "Repairing writer plan formatting"
      });
      const repairedInput = await this.sendMessage(
        writerSystemPrompt(),
        writerJsonRepairPrompt(
          "Opus script plan",
          error.rawText,
          error.parseErrorMessage,
          "title, synopsis, storyBible, targetDurationMinutes, estimatedTotalWords, wordsPerMinute, sourceMap, continuitySummary, chapters without transcript text"
        ),
        context,
        "plan:json-repair"
      );

      try {
        return parseOpusScriptPlanResponse(repairedInput, request);
      } catch (repairError) {
        if (isMalformedModelJsonError(repairError)) {
          throw new Error("Opus script plan returned malformed JSON after repair. Retry the job to regenerate this stage.");
        }
        throw repairError;
      }
    }
  }

  private async parseChapterTranscriptWithRepair(
    input: unknown,
    chapterId: string,
    context: ProviderContext,
    operationId: string
  ): Promise<string> {
    try {
      return parseOpusChapterTranscriptResponse(input, chapterId);
    } catch (error) {
      if (!isMalformedModelJsonError(error)) {
        throw error;
      }

      const repairedInput = await this.sendMessage(
        writerSystemPrompt(),
        writerJsonRepairPrompt(
          `Opus transcript for ${chapterId}`,
          error.rawText,
          error.parseErrorMessage,
          "{\"text\":\"complete chapter transcript\"}"
        ),
        context,
        `${operationId}:json-repair`
      );

      try {
        return parseOpusChapterTranscriptResponse(repairedInput, chapterId);
      } catch (repairError) {
        if (isMalformedModelJsonError(repairError)) {
          throw new Error(`Opus transcript for ${chapterId} returned malformed JSON after repair. Retry the job to regenerate this chapter.`);
        }
        throw repairError;
      }
    }
  }
}

async function opusRequestError(response: Response): Promise<Error | ProviderQuotaExceededErrorType> {
  const text = await response.text();
  const body = parseAnthropicErrorResponse(text);
  const errorType = body?.error?.type;
  const errorMessage = sanitizeAnthropicErrorMessage(body?.error?.message);
  const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? body?.request_id;
  const safeProvider = "Anthropic Claude";

  if (isAnthropicQuotaOrBillingError(response.status, errorType, errorMessage)) {
    const details: ProviderQuotaDetails = {
      provider: safeProvider,
      status: response.status,
      ...(requestId ? { requestId } : {})
    };
    return new ProviderQuotaExceededError(
      `${safeProvider} credits are depleted or billing is not available. Refill Anthropic credits, then retry the writing step.`,
      details
    );
  }

  const safeSuffix = [errorType, errorMessage].filter(Boolean).join(": ");
  return new Error(`Opus script writer request failed: ${response.status}${safeSuffix ? ` (${safeSuffix})` : ""}`);
}

function parseAnthropicErrorResponse(text: string): AnthropicErrorResponse | undefined {
  if (!text.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text) as AnthropicErrorResponse;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeAnthropicErrorMessage(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }

  return message.replace(/\s+/g, " ").trim().slice(0, 300);
}

function isAnthropicQuotaOrBillingError(
  status: number,
  errorType: string | undefined,
  message: string | undefined
): boolean {
  const normalized = `${errorType ?? ""} ${message ?? ""}`.toLowerCase();
  return status === 402 ||
    status === 429 ||
    normalized.includes("credit balance") ||
    normalized.includes("credits") ||
    normalized.includes("quota") ||
    normalized.includes("billing") ||
    normalized.includes("purchase credits") ||
    normalized.includes("insufficient");
}

export function parseOpusScriptResponse(input: unknown, request: GenerationRequest): StoryScript {
  return readStoryScriptJson(parseMessageJson(input, "Opus script writer"), request);
}

export function parseOpusScriptPlanResponse(input: unknown, request: GenerationRequest): StoryScriptPlan {
  return readStoryScriptPlanJson(parseMessageJson(input, "Opus script plan"), request);
}

export function parseOpusChapterTranscriptResponse(input: unknown, chapterId: string): string {
  const parsed = parseMessageJson(input, `Opus transcript for ${chapterId}`);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Opus transcript for ${chapterId} JSON must be an object`);
  }

  return requireString((parsed as Record<string, unknown>).text, `chapters.${chapterId}.text`);
}

function readMessageText(input: unknown, label: string): string {
  const response = input as AnthropicMessageResponse;
  const text = response.content?.find((part) => part.type === "text" && typeof part.text === "string")?.text;
  if (!text) {
    throw new Error(`${label} response did not include JSON text`);
  }

  return text;
}

function parseMessageJson(input: unknown, label: string): unknown {
  const text = stripJsonFence(readMessageText(input, label));
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new MalformedModelJsonError(
      label,
      text,
      error instanceof Error ? error.message : "Unknown JSON parse error"
    );
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function writerSystemPrompt(): string {
  return [
    "You write original, slow, calm bedtime history scripts for Sleepy History.",
    "Never imitate any named podcast, host, narrator, transcript, brand voice, or episode phrasing.",
    "Use the dossier only as factual grounding. Keep uncertainty gentle and explicit.",
    "Avoid intense violence, suspense, jokes, modern slang, calls to action, and cliffhangers.",
    "Return only valid JSON. Do not use markdown fences or commentary.",
    "Write complete chapter transcript text that matches the requested duration and the requested estimated word counts."
  ].join("\n");
}

function writerPlanPrompt(dossier: ResearchDossier, request: GenerationRequest): string {
  return [
    `Story kind: ${request.kind}`,
    `Subject: ${request.subject}`,
    `Era: ${request.era ?? dossier.era ?? "unspecified"}`,
    `Location: ${request.location ?? dossier.location ?? "unspecified"}`,
    `Perspective: ${request.perspective ?? "quiet historical narrator"}`,
    `Target duration minutes: ${request.targetDurationMinutes}`,
    `Bedtime tone: ${request.safety.bedtimeTone}`,
    "Create the story bible and chapter plan for an original calm, drowsy, factual script.",
    "Return JSON matching: title, synopsis, storyBible, targetDurationMinutes, estimatedTotalWords, wordsPerMinute, sourceMap, continuitySummary, chapters.",
    "Use 10 to 12 chapters, preferring 12 for 60 minutes or longer so each chapter stays easier to generate and narrate.",
    "Each chapter must include id, index, title, checkpoint, summary, continuitySummary, estimatedWords, and sourceIds.",
    "Do not include chapter transcript text in this plan response; transcript text is generated chapter by chapter.",
    `Research dossier JSON: ${JSON.stringify(dossier)}`
  ].join("\n");
}

function writerChapterPrompt(
  dossier: ResearchDossier,
  request: GenerationRequest,
  plan: StoryScriptPlan,
  chapter: ScriptPlanChapter
): string {
  return [
    `Story title: ${plan.title}`,
    `Subject: ${request.subject}`,
    `Target chapter words: ${chapter.estimatedWords}`,
    `Chapter ID: ${chapter.id}`,
    `Chapter title: ${chapter.title}`,
    `Chapter checkpoint: ${chapter.checkpoint}`,
    `Chapter summary: ${chapter.summary}`,
    `Chapter continuity: ${chapter.continuitySummary}`,
    `Allowed source IDs: ${chapter.sourceIds.join(", ")}`,
    "Write the complete transcript text for this chapter only.",
    "The transcript must be calm, original, low-stimulation, source-grounded, and close to the target word count.",
    "The target word count is mandatory: stay within 15 percent of it, using slow sensory detail and ordinary historical routine rather than summary.",
    "Return JSON only with shape: {\"text\":\"complete chapter transcript\"}.",
    `Story bible JSON: ${JSON.stringify(plan.storyBible)}`,
    `Global continuity summary: ${plan.continuitySummary}`,
    `Research dossier JSON: ${JSON.stringify(dossier)}`
  ].join("\n");
}

function writerChapterRepairPrompt(
  dossier: ResearchDossier,
  request: GenerationRequest,
  plan: StoryScriptPlan,
  chapter: ScriptPlanChapter,
  previousText: string,
  previousWordCount: number
): string {
  return [
    `Story title: ${plan.title}`,
    `Subject: ${request.subject}`,
    `Required chapter words: ${chapter.estimatedWords}`,
    `Previous chapter words: ${previousWordCount}`,
    `Chapter ID: ${chapter.id}`,
    `Chapter title: ${chapter.title}`,
    "Rewrite the complete transcript text for this chapter only.",
    "The previous transcript missed the required word count. Replace it with a complete, calm, source-grounded bedtime transcript within 15 percent of the required chapter words.",
    "Keep the same checkpoint, continuity, and historical boundaries. Do not summarize.",
    "Return JSON only with shape: {\"text\":\"complete replacement chapter transcript\"}.",
    `Previous transcript JSON: ${JSON.stringify({ text: previousText })}`,
    `Story bible JSON: ${JSON.stringify(plan.storyBible)}`,
    `Global continuity summary: ${plan.continuitySummary}`,
    `Research dossier JSON: ${JSON.stringify(dossier)}`
  ].join("\n");
}

function writerJsonRepairPrompt(
  label: string,
  rawText: string,
  parseErrorMessage: string,
  expectedShape: string
): string {
  return [
    `${label} was intended to be JSON, but it could not be parsed.`,
    `Parser detail: ${parseErrorMessage}`,
    `Expected JSON shape: ${expectedShape}`,
    "Return valid JSON only. Do not use markdown fences or commentary.",
    "Preserve the story content, factual details, chapter IDs, titles, source IDs, and transcript wording from the malformed response wherever possible.",
    "Fix only JSON formatting problems such as unescaped quotes, missing commas, invalid control characters, or trailing commentary.",
    `Malformed response as a JSON string: ${JSON.stringify(rawText)}`
  ].join("\n");
}

class MalformedModelJsonError extends Error {
  constructor(
    readonly label: string,
    readonly rawText: string,
    readonly parseErrorMessage: string
  ) {
    super(`${label} returned malformed JSON.`);
    this.name = "MalformedModelJsonError";
  }
}

function readStoryScriptJson(input: unknown, request: GenerationRequest): StoryScript {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Opus story script JSON must be an object");
  }

  const record = input as Record<string, unknown>;
  const title = requireString(record.title, "title");
  const synopsis = requireString(record.synopsis, "synopsis");
  const chapters = readScriptChapters(record.chapters);
  return assertValidStoryScript({
    title,
    synopsis,
    storyBible: readStoryBible(record.storyBible, {
      premise: synopsis,
      narrativePointOfView: request.perspective ?? "quiet historical narrator"
    }),
    targetDurationMinutes: readPositiveNumber(record.targetDurationMinutes, "targetDurationMinutes") ?? request.targetDurationMinutes,
    estimatedTotalWords: readPositiveNumber(record.estimatedTotalWords, "estimatedTotalWords") ?? 0,
    wordsPerMinute: readPositiveNumber(record.wordsPerMinute, "wordsPerMinute") ?? 130,
    sourceMap: readSourceMap(record.sourceMap, chapters),
    continuitySummary: requireString(record.continuitySummary, "continuitySummary"),
    chapters
  }, {
    targetDurationMinutes: request.targetDurationMinutes
  });
}

function readStoryScriptPlanJson(input: unknown, request: GenerationRequest): StoryScriptPlan {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Opus story script plan JSON must be an object");
  }

  const record = input as Record<string, unknown>;
  const title = requireString(record.title, "title");
  const synopsis = requireString(record.synopsis, "synopsis");
  const chapters = readPlanChapters(record.chapters);
  return {
    title,
    synopsis,
    storyBible: readStoryBible(record.storyBible, {
      premise: synopsis,
      narrativePointOfView: request.perspective ?? "quiet historical narrator"
    }),
    targetDurationMinutes: readPositiveNumber(record.targetDurationMinutes, "targetDurationMinutes") ?? request.targetDurationMinutes,
    estimatedTotalWords: readPositiveNumber(record.estimatedTotalWords, "estimatedTotalWords") ?? 0,
    wordsPerMinute: readPositiveNumber(record.wordsPerMinute, "wordsPerMinute") ?? 130,
    sourceMap: readSourceMap(record.sourceMap, chapters),
    continuitySummary: requireString(record.continuitySummary, "continuitySummary"),
    chapters
  };
}

function readStoryBible(
  input: unknown,
  fallback: Pick<StoryScript["storyBible"], "premise" | "narrativePointOfView">
): StoryScript["storyBible"] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      premise: fallback.premise,
      narrativePointOfView: fallback.narrativePointOfView,
      toneGuidelines: ["slow", "gentle", "source-grounded"],
      historicalBoundaries: ["Use only the sourced research dossier and mark uncertainty gently."],
      pronunciationGuide: []
    };
  }

  const record = input as Record<string, unknown>;
  return {
    premise: readString(record.premise) ?? fallback.premise,
    narrativePointOfView: readString(record.narrativePointOfView) ?? fallback.narrativePointOfView,
    toneGuidelines: readStringArray(record.toneGuidelines, "storyBible.toneGuidelines", ["slow", "gentle", "source-grounded"]),
    historicalBoundaries: readStringArray(record.historicalBoundaries, "storyBible.historicalBoundaries", [
      "Use only the sourced research dossier and mark uncertainty gently."
    ]),
    pronunciationGuide: readStringArray(record.pronunciationGuide, "storyBible.pronunciationGuide", [])
  };
}

function readSourceMap(
  input: unknown,
  chapters: readonly Pick<ScriptChapter, "id" | "sourceIds">[]
): StoryScript["sourceMap"] {
  if (!Array.isArray(input) || input.length === 0) {
    return fallbackSourceMap(chapters);
  }

  const fallbackChapterIds = chapters.map((chapter) => chapter.id);
  const fallbackSourceIds = uniqueStrings(chapters.flatMap((chapter) => chapter.sourceIds));
  const entries = input.flatMap((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const sourceId = readString(record.sourceId) ?? fallbackSourceIds[index] ?? fallbackSourceIds[0] ?? "source_1";

    return [{
      sourceId,
      title: readString(record.title) ?? `Research dossier source ${index + 1}`,
      claimIds: readStringArray(record.claimIds, `sourceMap[${index}].claimIds`, []),
      chapterIds: readStringArray(record.chapterIds, `sourceMap[${index}].chapterIds`, fallbackChapterIds)
    }];
  });

  const fallbackEntries = fallbackSourceMap(chapters);
  if (entries.length === 0) {
    return fallbackEntries;
  }

  const mappedSourceIds = new Set(entries.map((entry) => entry.sourceId));
  const missingEntries = fallbackEntries.filter((entry) => !mappedSourceIds.has(entry.sourceId));
  return [...entries, ...missingEntries];
}

function readScriptChapters(input: unknown): StoryScript["chapters"] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("chapters must be a non-empty array");
  }

  return input.map((chapter, index) => {
    return {
      ...readPlanChapter(chapter, index),
      text: requireString((chapter as Record<string, unknown>).text, `chapters[${index}].text`)
    };
  });
}

function readPlanChapters(input: unknown): readonly ScriptPlanChapter[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("chapters must be a non-empty array");
  }

  return input.map(readPlanChapter);
}

function readPlanChapter(chapter: unknown, index: number): ScriptPlanChapter {
  if (typeof chapter !== "object" || chapter === null || Array.isArray(chapter)) {
    throw new Error(`chapters[${index}] must be an object`);
  }
  const record = chapter as Record<string, unknown>;

  return {
    id: readString(record.id) ?? `chapter_${String(index + 1).padStart(2, "0")}`,
    index: readPositiveNumber(record.index, `chapters[${index}].index`) ?? index + 1,
    title: requireString(record.title, `chapters[${index}].title`),
    checkpoint: requireString(record.checkpoint, `chapters[${index}].checkpoint`),
    summary: requireString(record.summary, `chapters[${index}].summary`),
    continuitySummary: requireString(record.continuitySummary, `chapters[${index}].continuitySummary`),
    estimatedWords: readPositiveNumber(record.estimatedWords, `chapters[${index}].estimatedWords`) ?? 0,
    sourceIds: readStringArray(record.sourceIds, `chapters[${index}].sourceIds`, ["source_1"])
  };
}

function readStringArray(input: unknown, path: string, fallback?: readonly string[]): readonly string[] {
  if (!Array.isArray(input)) {
    if (fallback) {
      return fallback;
    }
    throw new Error(`${path} must be an array`);
  }

  const values = input.flatMap((value, index) => {
    const text = readString(value);
    if (!text) {
      if (fallback) {
        return [];
      }
      throw new Error(`${path}[${index}] must be a non-empty string`);
    }

    return [text];
  });
  return values.length ? values : fallback ?? values;
}

function requireString(input: unknown, path: string): string {
  const text = readString(input);
  if (!text) {
    throw new Error(`${path} must be a non-empty string`);
  }

  return text;
}

function readString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0 ? input : undefined;
}

function fallbackSourceMap(chapters: readonly Pick<ScriptChapter, "id" | "sourceIds">[]): StoryScript["sourceMap"] {
  const sourceIds = uniqueStrings(chapters.flatMap((chapter) => chapter.sourceIds));
  const mappedSourceIds = sourceIds.length ? sourceIds : ["source_1"];

  return mappedSourceIds.map((sourceId, index) => ({
    sourceId,
    title: `Research dossier source ${index + 1}`,
    claimIds: [],
    chapterIds: chapters
      .filter((chapter) => chapter.sourceIds.includes(sourceId) || chapter.sourceIds.length === 0)
      .map((chapter) => chapter.id)
  }));
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function normalizePlanWithTranscriptCounts(plan: StoryScriptPlan, chapters: readonly ScriptChapter[]): StoryScript {
  const normalizedChapters = chapters.map((chapter) => ({
    ...chapter,
    estimatedWords: countWords(chapter.text)
  }));

  return {
    ...plan,
    estimatedTotalWords: normalizedChapters.reduce((sum, chapter) => sum + chapter.estimatedWords, 0),
    chapters: normalizedChapters
  };
}

function fitOverlongChaptersToDuration(
  plan: StoryScriptPlan,
  chapters: readonly ScriptChapter[],
  request: GenerationRequest
): readonly ScriptChapter[] {
  const wordsPerMinute = boundedWordsPerMinute(plan.wordsPerMinute);
  const targetDurationMinutes = request.targetDurationMinutes;
  const tolerance = defaultDurationToleranceMinutes(targetDurationMinutes);
  const maxTotalWords = Math.floor((targetDurationMinutes + tolerance) * wordsPerMinute);
  const actualTotalWords = chapters.reduce((sum, chapter) => sum + countWords(chapter.text), 0);
  if (actualTotalWords <= maxTotalWords) {
    return chapters;
  }

  return chapters.map((chapter, index) => {
    const targetWords = Math.max(1, plan.chapters[index]?.estimatedWords ?? chapter.estimatedWords);
    const actualWords = countWords(chapter.text);
    if (actualWords <= targetWords) {
      return chapter;
    }

    return {
      ...chapter,
      text: trimTextToWordBudget(chapter.text, targetWords)
    };
  });
}

function normalizePlanWordTargets(plan: StoryScriptPlan, request: GenerationRequest): StoryScriptPlan {
  const chapterCount = plan.chapters.length;
  if (chapterCount === 0) {
    return plan;
  }

  const wordsPerMinute = boundedWordsPerMinute(plan.wordsPerMinute);
  const targetTotalWords = Math.round(request.targetDurationMinutes * wordsPerMinute);
  const existingTotal = plan.chapters.reduce((sum, chapter) => sum + Math.max(0, chapter.estimatedWords), 0);
  const weights = existingTotal > 0
    ? plan.chapters.map((chapter) => Math.max(0, chapter.estimatedWords) / existingTotal)
    : plan.chapters.map(() => 1 / chapterCount);
  let assignedTotal = 0;
  const chapters = plan.chapters.map((chapter, index) => {
    const isLast = index === chapterCount - 1;
    const estimatedWords = isLast
      ? Math.max(1, targetTotalWords - assignedTotal)
      : Math.max(1, Math.round(targetTotalWords * (weights[index] ?? 0)));
    assignedTotal += estimatedWords;

    return {
      ...chapter,
      estimatedWords
    };
  });

  return {
    ...plan,
    wordsPerMinute,
    estimatedTotalWords: chapters.reduce((sum, chapter) => sum + chapter.estimatedWords, 0),
    targetDurationMinutes: request.targetDurationMinutes,
    chapters
  };
}

function boundedWordsPerMinute(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 130;
  }

  return Math.min(135, Math.max(115, value));
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function trimTextToWordBudget(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return text;
  }

  const sentences = text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const keptSentences: string[] = [];
  let keptWordCount = 0;
  for (const sentence of sentences) {
    const sentenceWordCount = countWords(sentence);
    if (sentenceWordCount === 0) {
      continue;
    }
    if (keptWordCount > 0 && keptWordCount + sentenceWordCount > maxWords) {
      break;
    }
    if (keptWordCount === 0 && sentenceWordCount > maxWords) {
      break;
    }
    keptSentences.push(sentence.trim());
    keptWordCount += sentenceWordCount;
  }

  if (keptSentences.length > 0 && keptWordCount >= Math.max(1, Math.floor(maxWords * 0.8))) {
    return keptSentences.join(" ");
  }

  return words.slice(0, maxWords).join(" ");
}

function isWithinWordTolerance(actualWords: number, targetWords: number): boolean {
  return Math.abs(actualWords - targetWords) <= Math.max(20, targetWords * 0.15);
}

function chapterProgressEvent(
  phase: "chapter" | "repair",
  chapter: ScriptPlanChapter,
  chapterCount: number,
  actualWords: number
): WriterProgressEvent {
  return {
    phase,
    chapterId: chapter.id,
    chapterIndex: chapter.index,
    chapterCount,
    targetWords: chapter.estimatedWords,
    actualWords,
    message: `${phase === "repair" ? "Repaired" : "Completed"} chapter ${chapter.index} of ${chapterCount}: ${actualWords}/${chapter.estimatedWords} words`
  };
}

async function reportWriterProgress(context: ProviderContext, event: WriterProgressEvent): Promise<void> {
  await context.onWriterProgress?.(event);
}

function isStoryScriptValidationErrorLike(error: unknown): error is StoryScriptValidationError {
  return typeof error === "object" &&
    error !== null &&
    "result" in error &&
    "diagnostics" in error &&
    "script" in error;
}

function isMalformedModelJsonError(error: unknown): error is MalformedModelJsonError {
  return error instanceof MalformedModelJsonError;
}

function readPositiveNumber(input: unknown, path: string): number | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    throw new Error(`${path} must be a positive number`);
  }

  return input;
}
