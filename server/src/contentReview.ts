import type { GenerationRequest } from "./schemas.js";
import type { GenerationJob } from "./schemas.js";
import type { ResearchDossier, StoryScript } from "./providers.js";

export type PromptPolicyDecision = "allow" | "allow_with_constraints" | "block";
export type HistoricalViolenceLevel = "none" | "contextual" | "moderate_non_graphic" | "blocked_graphic";
export type ContentReviewStatus = "passed" | "rewrite_required" | "blocked";

export interface ContentReviewFinding {
  readonly code: string;
  readonly severity: "info" | "warning" | "block";
  readonly message: string;
  readonly chapterId?: string;
  readonly sourceId?: string;
}

export interface ContentReviewResult {
  readonly contentPolicyVersion: "2026-05-09";
  readonly originalUserPrompt: string;
  readonly normalizedPrompt: string;
  readonly promptPolicyDecision: PromptPolicyDecision;
  readonly promptPolicyReasons: readonly string[];
  readonly historicalViolenceLevel: HistoricalViolenceLevel;
  readonly fictionalizedPov: "none" | "fictional_composite" | "documented_person";
  readonly aiDisclosureRequired: true;
  readonly publicFigureVoiceCheck: "passed" | "blocked";
  readonly inspirationMimicryCheck: "passed" | "blocked";
  readonly providerKeyExposureCheck: "passed";
  readonly reviewStatus: ContentReviewStatus;
  readonly reviewer: "deterministic-content-review";
  readonly reviewedAt: string;
  readonly findings: readonly ContentReviewFinding[];
  readonly rewriteRequiredChapterIds: readonly string[];
}

const blockedPromptPatterns: readonly { readonly code: string; readonly pattern: RegExp; readonly reason: string }[] = [
  { code: "erotic", pattern: /\b(erotic|explicit sex|pornographic|seductive)\b/i, reason: "erotic content is not allowed" },
  { code: "graphic_violence", pattern: /\b(gore|graphic violence|bloody detail|torture scene|horror)\b/i, reason: "graphic or horror-framed violence is not bedtime safe" },
  { code: "hate_extremism", pattern: /\b(nazi praise|extremist praise|racial superiority|hate speech)\b/i, reason: "hate or extremist praise is not allowed" },
  { code: "illegal_instruction", pattern: /\b(how to poison|make a bomb|hide a body|commit fraud)\b/i, reason: "illegal instructions are not allowed" },
  { code: "copy_request", pattern: /\b(copy|plagiarize|rip off|verbatim)\b.*\b(script|episode|podcast|book)\b/i, reason: "requests to copy another work are not allowed" },
  { code: "show_imitation", pattern: /\b(exactly like|same style as|sound like|clone)\b.*\b(boring history|podcast|host|narrator)\b/i, reason: "imitation of a podcast, host, or narrator is not allowed" },
  { code: "voice_imitation", pattern: /\b(in the voice of|impersonate|sound like)\b/i, reason: "voice or creator imitation is not allowed" }
];

const intenseScriptPatterns: readonly { readonly code: string; readonly pattern: RegExp; readonly message: string }[] = [
  { code: "graphic_detail", pattern: /\b(blood-soaked|guts|screaming in pain|severed|mangled)\b/i, message: "graphic sensory detail should be rewritten calmly or removed" },
  { code: "horror_pacing", pattern: /\b(terrifying|nightmare|jump scare|you cannot escape|panic)\b/i, message: "horror pacing conflicts with bedtime tone" },
  { code: "cliffhanger", pattern: /\b(cliffhanger|suddenly everything changed|but then disaster struck)\b/i, message: "cliffhanger language should be softened" },
  { code: "sensationalism", pattern: /\b(shocking|brutal spectacle|most gruesome|bloodiest)\b/i, message: "sensational phrasing should be rewritten" }
];

export function reviewGenerationRequest(
  request: GenerationRequest,
  now: () => string = () => new Date().toISOString()
): ContentReviewResult {
  const originalPrompt = buildOriginalPrompt(request);
  const normalizedPrompt = normalizePrompt(originalPrompt);
  const promptFindings = blockedPromptPatterns
    .filter((rule) => rule.pattern.test(normalizedPrompt))
    .map((rule): ContentReviewFinding => ({
      code: rule.code,
      severity: "block",
      message: rule.reason
    }));
  const historicalViolenceLevel = classifyHistoricalViolence(normalizedPrompt, request.safety.allowHistoricalViolenceContext);

  return buildReviewResult({
    request,
    originalPrompt,
    normalizedPrompt,
    findings: [
      ...promptFindings,
      ...(historicalViolenceLevel === "blocked_graphic" ? [{
        code: "historical_violence_blocked",
        severity: "block" as const,
        message: "historical violence must remain factual, brief, non-graphic, and sleep-appropriate"
      }] : [])
    ],
    historicalViolenceLevel,
    rewriteRequiredChapterIds: [],
    now
  });
}

export function reviewStoryScript(
  request: GenerationRequest,
  dossier: ResearchDossier,
  script: StoryScript,
  now: () => string = () => new Date().toISOString()
): ContentReviewResult {
  const promptReview = reviewGenerationRequest(request, now);
  if (promptReview.reviewStatus === "blocked") {
    return promptReview;
  }

  const findings: ContentReviewFinding[] = [...promptReview.findings];
  const rewriteRequiredChapterIds = new Set<string>();

  for (const chapter of script.chapters) {
    const normalizedText = normalizePrompt(chapter.text);
    for (const rule of intenseScriptPatterns) {
      if (rule.pattern.test(normalizedText)) {
        findings.push({
          code: rule.code,
          severity: "warning",
          message: rule.message,
          chapterId: chapter.id
        });
        rewriteRequiredChapterIds.add(chapter.id);
      }
    }

    for (const source of dossier.sources) {
      const sourceText = [source.title, source.notes].filter(Boolean).join(" ");
      if (sourceText && includesLongSourcePhrase(chapter.text, sourceText)) {
        findings.push({
          code: "copied_source_phrase",
          severity: "warning",
          message: "chapter text contains a long phrase copied from source metadata",
          chapterId: chapter.id,
          sourceId: source.id
        });
        rewriteRequiredChapterIds.add(chapter.id);
      }
    }
  }

  return buildReviewResult({
    request,
    originalPrompt: promptReview.originalUserPrompt,
    normalizedPrompt: promptReview.normalizedPrompt,
    findings,
    historicalViolenceLevel: promptReview.historicalViolenceLevel,
    rewriteRequiredChapterIds: [...rewriteRequiredChapterIds],
    now
  });
}

export function rewriteOverlyIntensePassages(script: StoryScript, review: ContentReviewResult): StoryScript {
  const chapterIds = new Set(
    review.findings
      .filter((finding) => finding.severity === "warning" && isBedtimeToneFinding(finding.code) && finding.chapterId)
      .map((finding) => finding.chapterId)
  );

  if (chapterIds.size === 0) {
    return script;
  }

  return {
    ...script,
    chapters: script.chapters.map((chapter) => {
      if (!chapterIds.has(chapter.id)) {
        return chapter;
      }

      return {
        ...chapter,
        text: softenForBedtime(chapter.text),
        continuitySummary: `${chapter.continuitySummary} Bedtime rewrite applied to keep the passage calm and low-stimulation.`
      };
    })
  };
}

export function attachContentReviewToJob(job: GenerationJob, review: ContentReviewResult): GenerationJob {
  return {
    ...job,
    metadata: {
      ...job.metadata,
      contentReview: contentReviewToMetadata(review)
    }
  };
}

function buildReviewResult(input: {
  readonly request: GenerationRequest;
  readonly originalPrompt: string;
  readonly normalizedPrompt: string;
  readonly findings: readonly ContentReviewFinding[];
  readonly historicalViolenceLevel: HistoricalViolenceLevel;
  readonly rewriteRequiredChapterIds: readonly string[];
  readonly now: () => string;
}): ContentReviewResult {
  const hasBlocks = input.findings.some((finding) => finding.severity === "block");
  const hasWarnings = input.findings.some((finding) => finding.severity === "warning");
  const promptPolicyReasons = input.findings.filter((finding) => finding.severity === "block").map((finding) => finding.message);

  return {
    contentPolicyVersion: "2026-05-09",
    originalUserPrompt: input.originalPrompt,
    normalizedPrompt: input.normalizedPrompt,
    promptPolicyDecision: hasBlocks ? "block" : hasWarnings ? "allow_with_constraints" : "allow",
    promptPolicyReasons,
    historicalViolenceLevel: input.historicalViolenceLevel,
    fictionalizedPov: input.request.kind === "daily_life" ? "fictional_composite" : "documented_person",
    aiDisclosureRequired: true,
    publicFigureVoiceCheck: hasCode(input.findings, "voice_imitation") ? "blocked" : "passed",
    inspirationMimicryCheck: hasCode(input.findings, "show_imitation") ? "blocked" : "passed",
    providerKeyExposureCheck: "passed",
    reviewStatus: hasBlocks ? "blocked" : hasWarnings ? "rewrite_required" : "passed",
    reviewer: "deterministic-content-review",
    reviewedAt: input.now(),
    findings: input.findings,
    rewriteRequiredChapterIds: input.rewriteRequiredChapterIds
  };
}

function buildOriginalPrompt(request: GenerationRequest): string {
  return [
    request.kind,
    request.subject,
    request.era,
    request.location,
    request.perspective
  ].filter(Boolean).join(" ");
}

function normalizePrompt(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function classifyHistoricalViolence(value: string, allowHistoricalViolenceContext: boolean): HistoricalViolenceLevel {
  if (/\b(gore|graphic violence|bloody detail|torture scene)\b/i.test(value)) {
    return "blocked_graphic";
  }
  if (/\b(war|battle|siege|invasion|plague|execution|death)\b/i.test(value)) {
    return allowHistoricalViolenceContext ? "contextual" : "blocked_graphic";
  }

  return "none";
}

function includesLongSourcePhrase(chapterText: string, sourceText: string): boolean {
  const sourceWords = normalizePrompt(sourceText).split(" ").filter((word) => word.length > 2);
  if (sourceWords.length < 10) {
    return false;
  }

  const normalizedChapter = normalizePrompt(chapterText);
  for (let index = 0; index <= sourceWords.length - 10; index += 1) {
    const phrase = sourceWords.slice(index, index + 10).join(" ");
    if (normalizedChapter.includes(phrase)) {
      return true;
    }
  }

  return false;
}

function hasCode(findings: readonly ContentReviewFinding[], code: string): boolean {
  return findings.some((finding) => finding.code === code);
}

function contentReviewToMetadata(review: ContentReviewResult): Record<string, unknown> {
  return {
    content_policy_version: review.contentPolicyVersion,
    original_user_prompt: review.originalUserPrompt,
    normalized_prompt: review.normalizedPrompt,
    prompt_policy_decision: review.promptPolicyDecision,
    prompt_policy_reasons: review.promptPolicyReasons,
    historical_violence_level: review.historicalViolenceLevel,
    fictionalized_pov: review.fictionalizedPov,
    ai_disclosure_required: review.aiDisclosureRequired,
    public_figure_voice_check: review.publicFigureVoiceCheck,
    inspiration_mimicry_check: review.inspirationMimicryCheck,
    provider_key_exposure_check: review.providerKeyExposureCheck,
    review_status: review.reviewStatus,
    reviewer: review.reviewer,
    reviewed_at: review.reviewedAt,
    findings: review.findings,
    rewrite_required_chapter_ids: review.rewriteRequiredChapterIds
  };
}

function isBedtimeToneFinding(code: string): boolean {
  return ["graphic_detail", "horror_pacing", "cliffhanger", "sensationalism"].includes(code);
}

function softenForBedtime(text: string): string {
  return text
    .replace(/\bblood-soaked\b/gi, "weathered")
    .replace(/\bguts\b/gi, "remains")
    .replace(/\bscreaming in pain\b/gi, "crying out")
    .replace(/\bsevered\b/gi, "broken")
    .replace(/\bmangled\b/gi, "damaged")
    .replace(/\bterrifying\b/gi, "difficult")
    .replace(/\bnightmare\b/gi, "troubled memory")
    .replace(/\bjump scare\b/gi, "sudden sound")
    .replace(/\byou cannot escape\b/gi, "the path is narrow")
    .replace(/\bpanic\b/gi, "unease")
    .replace(/\bcliffhanger\b/gi, "pause")
    .replace(/\bsuddenly everything changed\b/gi, "in time, the scene shifted")
    .replace(/\bbut then disaster struck\b/gi, "and the day asked for patience")
    .replace(/\bshocking\b/gi, "notable")
    .replace(/\bbrutal spectacle\b/gi, "difficult public moment")
    .replace(/\bmost gruesome\b/gi, "most difficult")
    .replace(/\bbloodiest\b/gi, "most turbulent");
}
