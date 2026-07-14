import type { GenerationRequest } from "./schemas.js";
import type { ProviderContext, ResearchDossier } from "./providers.js";
import { MockResearchProvider, type ResearchProvider } from "./providers.js";

export interface GeminiResearchConfig {
  readonly apiKey: string;
  readonly modelId?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

interface GeminiResponse {
  readonly candidates?: readonly {
    readonly content?: {
      readonly parts?: readonly {
        readonly text?: string;
      }[];
    };
    readonly groundingMetadata?: {
      readonly webSearchQueries?: readonly string[];
      readonly groundingChunks?: readonly {
        readonly web?: {
          readonly uri?: string;
          readonly title?: string;
        };
      }[];
    };
  }[];
}

export class MockGeminiResearchProvider extends MockResearchProvider {
  override readonly name = "mock-gemini-research";
}

export class GeminiResearchProvider implements ResearchProvider {
  readonly name = "gemini-research";
  private readonly modelId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: GeminiResearchConfig) {
    this.modelId = config.modelId ?? "gemini-3.1-pro-preview";
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async buildDossier(request: GenerationRequest, context: ProviderContext): Promise<ResearchDossier> {
    const response = await this.fetchImpl(`${this.baseUrl}/models/${this.modelId}:generateContent?key=${this.config.apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sleepy-History-Job": context.jobId
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: researchPrompt(request)
              }
            ]
          }
        ],
        tools: [
          {
            googleSearch: {}
          }
        ],
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini research request failed: ${response.status}`);
    }

    return parseGeminiResearchResponse(await response.json(), request, this.modelId, response.headers.get("x-request-id") ?? undefined);
  }

  async verifyModelAvailable(): Promise<boolean> {
    const response = await this.fetchImpl(`${this.baseUrl}/models?key=${this.config.apiKey}`);
    if (!response.ok) {
      throw new Error(`Gemini model list failed: ${response.status}`);
    }

    const payload = await response.json() as { readonly models?: readonly { readonly name?: string }[] };
    return (payload.models ?? []).some((model) => model.name === `models/${this.modelId}` || model.name === this.modelId);
  }
}

export function parseGeminiResearchResponse(
  input: unknown,
  request: GenerationRequest,
  modelId = "gemini-3.1-pro-preview",
  requestId?: string
): ResearchDossier {
  const response = input as GeminiResponse;
  const candidate = response.candidates?.[0];
  const text = candidate?.content?.parts?.find((part) => typeof part.text === "string")?.text;
  if (!text) {
    throw new Error("Gemini research response did not include JSON text");
  }

  const dossier = readDossierJson(JSON.parse(text), request);
  const groundingChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const groundedSources = groundingChunks.flatMap((chunk, index) => {
    const uri = chunk.web?.uri;
    if (!uri) {
      return [];
    }

    return [{
      id: `gemini_grounding_${index + 1}`,
      title: readString(chunk.web?.title, `groundingChunks[${index}].web.title`) ?? sourceTitleFromUrl(uri, index),
      url: uri,
      publisher: "Gemini grounding"
    }];
  });
  const sourceIds = [...dossier.sources, ...groundedSources].map((source) => source.id);

  return {
    ...dossier,
    sources: [...dossier.sources, ...groundedSources],
    groundingMetadata: [
      {
        provider: "gemini",
        modelId,
        requestId,
        searchQueries: candidate?.groundingMetadata?.webSearchQueries ?? [],
        sourceIds
      }
    ]
  };
}

function researchPrompt(request: GenerationRequest): string {
  return [
    "Build a source-grounded research dossier for an original calm bedtime history story.",
    "Return only JSON with subject, era, location, chronology, dailyLifeDetails, pronunciationCandidates, uncertaintyNotes, claims, and sources.",
    "Claims must include sourceIds. Prefer daily life, routines, objects, food, weather, labor, and quiet setting details.",
    `Story kind: ${request.kind}`,
    `Subject: ${request.subject}`,
    `Era: ${request.era ?? "unspecified"}`,
    `Location: ${request.location ?? "unspecified"}`,
    `Perspective: ${request.perspective ?? "unspecified"}`
  ].join("\n");
}

function readDossierJson(input: unknown, request: GenerationRequest): ResearchDossier {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Gemini dossier JSON must be an object");
  }

  const record = input as Record<string, unknown>;
  const sources = readSources(record.sources);
  const fallbackSourceIds = sources.map((source) => source.id);
  const subject = readString(record.subject, "subject") ?? request.subject;
  const era = readOptionalString(record.era) ?? request.era;
  const location = readOptionalString(record.location) ?? request.location;

  return {
    subject,
    era,
    location,
    chronology: readStringArray(record.chronology, "chronology", [
      `${subject} belongs to ${era ?? "the requested historical setting"}.`
    ]),
    dailyLifeDetails: readStringArray(record.dailyLifeDetails, "dailyLifeDetails", [
      `Quiet daily routines around ${subject} should be treated as source-grounded context.`
    ]),
    pronunciationCandidates: readStringArray(record.pronunciationCandidates, "pronunciationCandidates", [subject]),
    uncertaintyNotes: readStringArray(record.uncertaintyNotes, "uncertaintyNotes", []),
    claims: readClaims(record.claims, subject, fallbackSourceIds),
    sources,
    groundingMetadata: []
  };
}

function readClaims(input: unknown, subject: string, fallbackSourceIds: readonly string[]): ResearchDossier["claims"] {
  if (!Array.isArray(input)) {
    return fallbackClaim(subject, fallbackSourceIds);
  }

  const claims = input.flatMap((claim, index) => {
    if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
      return [];
    }
    const record = claim as Record<string, unknown>;
    const text = readString(record.text, `claims[${index}].text`);
    if (!text) {
      return [];
    }
    const sourceIds = readStringArray(record.sourceIds, `claims[${index}].sourceIds`, fallbackSourceIds);

    const confidence: ResearchDossier["claims"][number]["confidence"] = record.confidence === "uncertain" ? "uncertain" : "grounded";

    return [{
      id: readString(record.id, `claims[${index}].id`) ?? `claim_${index + 1}`,
      text,
      sourceIds,
      confidence
    }];
  });

  return claims.length ? claims : fallbackClaim(subject, fallbackSourceIds);
}

function readSources(input: unknown): ResearchDossier["sources"] {
  if (!Array.isArray(input)) {
    throw new Error("sources must be an array");
  }

  return input.map((source, index) => {
    if (typeof source !== "object" || source === null || Array.isArray(source)) {
      throw new Error(`sources[${index}] must be an object`);
    }
    const record = source as Record<string, unknown>;

    const url = readOptionalString(record.url);
    const publisher = readOptionalString(record.publisher);

    return {
      id: readString(record.id, `sources[${index}].id`) ?? `source_${index + 1}`,
      title: readString(record.title, `sources[${index}].title`) ?? publisher ?? (url ? sourceTitleFromUrl(url, index) : `Source ${index + 1}`),
      url,
      publisher,
      notes: readOptionalString(record.notes)
    };
  });
}

function sourceTitleFromUrl(url: string, index: number): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || `Source ${index + 1}`;
  } catch {
    return `Source ${index + 1}`;
  }
}

function readStringArray(input: unknown, path: string, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(input)) {
    return fallback;
  }

  const values = input.flatMap((value, index) => readString(value, `${path}[${index}]`) ?? []);
  return values.length ? values : fallback;
}

function readString(input: unknown, _path: string): string | undefined {
  return typeof input === "string" && input.trim().length > 0 ? input : undefined;
}

function readOptionalString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0 ? input : undefined;
}

function fallbackClaim(subject: string, sourceIds: readonly string[]): ResearchDossier["claims"] {
  return [{
    id: "claim_research_context",
    text: `The research dossier provides source-grounded context for ${subject}.`,
    sourceIds,
    confidence: "grounded"
  }];
}
