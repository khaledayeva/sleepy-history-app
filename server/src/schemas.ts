export const storyKinds = ["historical_figure", "daily_life"] as const;
export const ambienceKinds = ["none", "rain", "fireplace", "ocean"] as const;
export const jobStatuses = [
  "queued",
  "researching",
  "outlining",
  "writing",
  "reviewing",
  "voicing",
  "imaging",
  "assembling",
  "completed",
  "failed",
  "canceled"
] as const;
export const assetKinds = [
  "cover_full",
  "cover_thumbnail",
  "audio",
  "transcript",
  "sources",
  "placeholder"
] as const;

export type StoryKind = typeof storyKinds[number];
export type AmbienceKind = typeof ambienceKinds[number];
export type JobStatus = typeof jobStatuses[number];
export type AssetKind = typeof assetKinds[number];

export interface GenerationRequest {
  readonly schemaVersion: "2026-05-10";
  readonly kind: StoryKind;
  readonly subject: string;
  readonly targetDurationMinutes: number;
  readonly era?: string;
  readonly location?: string;
  readonly perspective?: string;
  readonly voiceId?: string;
  readonly ambience?: AmbienceKind;
  readonly safety: {
    readonly bedtimeTone: "gentle" | "very_gentle";
    readonly allowHistoricalViolenceContext: boolean;
  };
}

export interface JobProgress {
  readonly stage: JobStatus;
  readonly percent: number;
  readonly message?: string;
}

export interface GenerationJob {
  readonly id: string;
  readonly status: JobStatus;
  readonly request: GenerationRequest;
  readonly progress: JobProgress;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly storyId?: string;
  readonly error?: ApiError;
  readonly metadata?: {
    readonly contentReview?: JsonRecord;
    readonly assetAccess?: JsonRecord;
    readonly imageGeneration?: JsonRecord;
    readonly writerDiagnostics?: JsonRecord;
  };
}

export interface Chapter {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly summary: string;
  readonly estimatedDurationSeconds: number;
  readonly transcript: string;
  readonly sourceIds: readonly string[];
}

export interface SourceRecord {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly publisher?: string;
  readonly retrievedAt?: string;
  readonly notes?: string;
}

export interface Asset {
  readonly id: string;
  readonly kind: AssetKind;
  readonly mimeType: string;
  readonly uri: string;
  readonly sizeBytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly checksum?: string;
}

export interface Story {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly kind: StoryKind;
  readonly subject: string;
  readonly synopsis: string;
  readonly targetDurationMinutes: number;
  readonly estimatedDurationSeconds: number;
  readonly createdAt: string;
  readonly chapters: readonly Chapter[];
  readonly sources: readonly SourceRecord[];
  readonly assets: readonly Asset[];
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, string | number | boolean | null>;
}

type JsonRecord = Record<string, unknown>;
type IssueList = string[];

export class SchemaValidationError extends Error {
  constructor(
    readonly schemaName: string,
    readonly issues: readonly string[]
  ) {
    super(`${schemaName} validation failed: ${issues.join("; ")}`);
    this.name = "SchemaValidationError";
  }
}

export function parseGenerationRequest(input: unknown): GenerationRequest {
  return parseSchema("GenerationRequest", input, readGenerationRequest);
}

export function parseGenerationJob(input: unknown): GenerationJob {
  return parseSchema("GenerationJob", input, readGenerationJob);
}

export function parseStory(input: unknown): Story {
  return parseSchema("Story", input, readStory);
}

export function parseChapter(input: unknown): Chapter {
  return parseSchema("Chapter", input, readChapter);
}

export function parseSourceRecord(input: unknown): SourceRecord {
  return parseSchema("SourceRecord", input, readSourceRecord);
}

export function parseAsset(input: unknown): Asset {
  return parseSchema("Asset", input, readAsset);
}

export function parseApiError(input: unknown): ApiError {
  return parseSchema("ApiError", input, readApiError);
}

function parseSchema<T>(
  schemaName: string,
  input: unknown,
  reader: (input: unknown, path: string, issues: IssueList) => T | undefined
): T {
  const issues: IssueList = [];
  const value = reader(input, "$", issues);

  if (issues.length > 0 || value === undefined) {
    throw new SchemaValidationError(schemaName, issues);
  }

  return value;
}

function readGenerationRequest(input: unknown, path: string, issues: IssueList): GenerationRequest | undefined {
  const record = asRecord(input, path, issues);
  if (!record) {
    return undefined;
  }

  const schemaVersion = readLiteral(record, "schemaVersion", "2026-05-10", path, issues);
  const kind = readEnum(record, "kind", storyKinds, path, issues);
  const subject = readString(record, "subject", path, issues);
  const targetDurationMinutes = readNumber(record, "targetDurationMinutes", path, issues, { min: 1, max: 65 });
  const safety = readSafety(record.safety, `${path}.safety`, issues);

  if (!schemaVersion || !kind || !subject || targetDurationMinutes === undefined || !safety) {
    return undefined;
  }

  return {
    schemaVersion,
    kind,
    subject,
    targetDurationMinutes,
    era: readOptionalString(record, "era", path, issues),
    location: readOptionalString(record, "location", path, issues),
    perspective: readOptionalString(record, "perspective", path, issues),
    voiceId: readOptionalString(record, "voiceId", path, issues),
    ambience: readOptionalEnum(record, "ambience", ambienceKinds, path, issues),
    safety
  };
}

function readGenerationJob(input: unknown, path: string, issues: IssueList): GenerationJob | undefined {
  const record = asRecord(input, path, issues);
  if (!record) {
    return undefined;
  }

  const id = readString(record, "id", path, issues);
  const status = readEnum(record, "status", jobStatuses, path, issues);
  const request = readGenerationRequest(record.request, `${path}.request`, issues);
  const progress = readProgress(record.progress, `${path}.progress`, issues);
  const createdAt = readIsoString(record, "createdAt", path, issues);
  const updatedAt = readIsoString(record, "updatedAt", path, issues);
  const error = record.error === undefined ? undefined : readApiError(record.error, `${path}.error`, issues);

  if (!id || !status || !request || !progress || !createdAt || !updatedAt) {
    return undefined;
  }

  return {
    id,
    status,
    request,
    progress,
    createdAt,
    updatedAt,
    storyId: readOptionalString(record, "storyId", path, issues),
    error,
    metadata: readOptionalJobMetadata(record, path, issues)
  };
}

function readStory(input: unknown, path: string, issues: IssueList): Story | undefined {
  const record = asRecord(input, path, issues);
  if (!record) {
    return undefined;
  }

  const id = readString(record, "id", path, issues);
  const title = readString(record, "title", path, issues);
  const kind = readEnum(record, "kind", storyKinds, path, issues);
  const subject = readString(record, "subject", path, issues);
  const synopsis = readString(record, "synopsis", path, issues);
  const targetDurationMinutes = readNumber(record, "targetDurationMinutes", path, issues, { min: 1, max: 65 });
  const estimatedDurationSeconds = readNumber(record, "estimatedDurationSeconds", path, issues, { min: 1 });
  const createdAt = readIsoString(record, "createdAt", path, issues);
  const chapters = readArray(record.chapters, `${path}.chapters`, issues, readChapter);
  const sources = readArray(record.sources, `${path}.sources`, issues, readSourceRecord);
  const assets = readArray(record.assets, `${path}.assets`, issues, readAsset);

  if (
    !id ||
    !title ||
    !kind ||
    !subject ||
    !synopsis ||
    targetDurationMinutes === undefined ||
    estimatedDurationSeconds === undefined ||
    !createdAt ||
    !chapters ||
    !sources ||
    !assets
  ) {
    return undefined;
  }

  return {
    id,
    title,
    subtitle: readOptionalString(record, "subtitle", path, issues),
    kind,
    subject,
    synopsis,
    targetDurationMinutes,
    estimatedDurationSeconds,
    createdAt,
    chapters,
    sources,
    assets
  };
}

function readChapter(input: unknown, path: string, issues: IssueList): Chapter | undefined {
  const record = asRecord(input, path, issues);
  if (!record) {
    return undefined;
  }

  const id = readString(record, "id", path, issues);
  const index = readInteger(record, "index", path, issues, { min: 1 });
  const title = readString(record, "title", path, issues);
  const summary = readString(record, "summary", path, issues);
  const estimatedDurationSeconds = readNumber(record, "estimatedDurationSeconds", path, issues, { min: 1 });
  const transcript = readString(record, "transcript", path, issues);
  const sourceIds = readStringArray(record.sourceIds, `${path}.sourceIds`, issues);

  if (!id || index === undefined || !title || !summary || estimatedDurationSeconds === undefined || !transcript || !sourceIds) {
    return undefined;
  }

  return {
    id,
    index,
    title,
    summary,
    estimatedDurationSeconds,
    transcript,
    sourceIds
  };
}

function readSourceRecord(input: unknown, path: string, issues: IssueList): SourceRecord | undefined {
  const record = asRecord(input, path, issues);
  if (!record) {
    return undefined;
  }

  const id = readString(record, "id", path, issues);
  const title = readString(record, "title", path, issues);

  if (!id || !title) {
    return undefined;
  }

  return {
    id,
    title,
    url: readOptionalUrl(record, "url", path, issues),
    publisher: readOptionalString(record, "publisher", path, issues),
    retrievedAt: readOptionalIsoString(record, "retrievedAt", path, issues),
    notes: readOptionalString(record, "notes", path, issues)
  };
}

function readAsset(input: unknown, path: string, issues: IssueList): Asset | undefined {
  const record = asRecord(input, path, issues);
  if (!record) {
    return undefined;
  }

  const id = readString(record, "id", path, issues);
  const kind = readEnum(record, "kind", assetKinds, path, issues);
  const mimeType = readString(record, "mimeType", path, issues);
  const uri = readString(record, "uri", path, issues);

  if (!id || !kind || !mimeType || !uri) {
    return undefined;
  }

  return {
    id,
    kind,
    mimeType,
    uri,
    sizeBytes: readOptionalNumber(record, "sizeBytes", path, issues, { min: 0 }),
    width: readOptionalInteger(record, "width", path, issues, { min: 1 }),
    height: readOptionalInteger(record, "height", path, issues, { min: 1 }),
    durationSeconds: readOptionalNumber(record, "durationSeconds", path, issues, { min: 0 }),
    checksum: readOptionalString(record, "checksum", path, issues)
  };
}

function readApiError(input: unknown, path: string, issues: IssueList): ApiError | undefined {
  const record = asRecord(input, path, issues);
  if (!record) {
    return undefined;
  }

  const code = readString(record, "code", path, issues);
  const message = readString(record, "message", path, issues);
  const retryable = readBoolean(record, "retryable", path, issues);
  const details = record.details === undefined ? undefined : readDetails(record.details, `${path}.details`, issues);

  if (!code || !message || retryable === undefined) {
    return undefined;
  }

  return {
    code,
    message,
    retryable,
    details
  };
}

function readSafety(input: unknown, path: string, issues: IssueList): GenerationRequest["safety"] | undefined {
  const record = asRecord(input, path, issues);
  if (!record) {
    return undefined;
  }

  const bedtimeTone = readEnum(record, "bedtimeTone", ["gentle", "very_gentle"] as const, path, issues);
  const allowHistoricalViolenceContext = readBoolean(record, "allowHistoricalViolenceContext", path, issues);

  if (!bedtimeTone || allowHistoricalViolenceContext === undefined) {
    return undefined;
  }

  return {
    bedtimeTone,
    allowHistoricalViolenceContext
  };
}

function readProgress(input: unknown, path: string, issues: IssueList): JobProgress | undefined {
  const record = asRecord(input, path, issues);
  if (!record) {
    return undefined;
  }

  const stage = readEnum(record, "stage", jobStatuses, path, issues);
  const percent = readNumber(record, "percent", path, issues, { min: 0, max: 100 });

  if (!stage || percent === undefined) {
    return undefined;
  }

  return {
    stage,
    percent,
    message: readOptionalString(record, "message", path, issues)
  };
}

function readOptionalJobMetadata(record: JsonRecord, path: string, issues: IssueList): GenerationJob["metadata"] | undefined {
  if (record.metadata === undefined) {
    return undefined;
  }

  const metadata = asRecord(record.metadata, `${path}.metadata`, issues);
  if (!metadata) {
    return undefined;
  }

  return {
    contentReview: metadata.contentReview === undefined ? undefined : asRecord(metadata.contentReview, `${path}.metadata.contentReview`, issues),
    assetAccess: metadata.assetAccess === undefined ? undefined : asRecord(metadata.assetAccess, `${path}.metadata.assetAccess`, issues),
    imageGeneration: metadata.imageGeneration === undefined ? undefined : asRecord(metadata.imageGeneration, `${path}.metadata.imageGeneration`, issues),
    writerDiagnostics: metadata.writerDiagnostics === undefined ? undefined : asRecord(metadata.writerDiagnostics, `${path}.metadata.writerDiagnostics`, issues)
  };
}

function asRecord(input: unknown, path: string, issues: IssueList): JsonRecord | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }

  return input as JsonRecord;
}

function readString(record: JsonRecord, key: string, path: string, issues: IssueList): string | undefined {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${path}.${key} must be a non-empty string`);
    return undefined;
  }

  return value;
}

function readOptionalString(record: JsonRecord, key: string, path: string, issues: IssueList): string | undefined {
  if (record[key] === undefined) {
    return undefined;
  }

  return readString(record, key, path, issues);
}

function readBoolean(record: JsonRecord, key: string, path: string, issues: IssueList): boolean | undefined {
  const value = record[key];
  if (typeof value !== "boolean") {
    issues.push(`${path}.${key} must be a boolean`);
    return undefined;
  }

  return value;
}

function readNumber(
  record: JsonRecord,
  key: string,
  path: string,
  issues: IssueList,
  bounds: { readonly min?: number; readonly max?: number } = {}
): number | undefined {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${path}.${key} must be a finite number`);
    return undefined;
  }

  if (bounds.min !== undefined && value < bounds.min) {
    issues.push(`${path}.${key} must be at least ${bounds.min}`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    issues.push(`${path}.${key} must be at most ${bounds.max}`);
  }

  return value;
}

function readOptionalNumber(
  record: JsonRecord,
  key: string,
  path: string,
  issues: IssueList,
  bounds: { readonly min?: number; readonly max?: number } = {}
): number | undefined {
  if (record[key] === undefined) {
    return undefined;
  }

  return readNumber(record, key, path, issues, bounds);
}

function readInteger(
  record: JsonRecord,
  key: string,
  path: string,
  issues: IssueList,
  bounds: { readonly min?: number; readonly max?: number } = {}
): number | undefined {
  const value = readNumber(record, key, path, issues, bounds);
  if (value !== undefined && !Number.isInteger(value)) {
    issues.push(`${path}.${key} must be an integer`);
  }

  return value;
}

function readOptionalInteger(
  record: JsonRecord,
  key: string,
  path: string,
  issues: IssueList,
  bounds: { readonly min?: number; readonly max?: number } = {}
): number | undefined {
  if (record[key] === undefined) {
    return undefined;
  }

  return readInteger(record, key, path, issues, bounds);
}

function readEnum<const T extends readonly string[]>(
  record: JsonRecord,
  key: string,
  values: T,
  path: string,
  issues: IssueList
): T[number] | undefined {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value)) {
    issues.push(`${path}.${key} must be one of ${values.join(", ")}`);
    return undefined;
  }

  return value;
}

function readOptionalEnum<const T extends readonly string[]>(
  record: JsonRecord,
  key: string,
  values: T,
  path: string,
  issues: IssueList
): T[number] | undefined {
  if (record[key] === undefined) {
    return undefined;
  }

  return readEnum(record, key, values, path, issues);
}

function readLiteral<const T extends string>(
  record: JsonRecord,
  key: string,
  expected: T,
  path: string,
  issues: IssueList
): T | undefined {
  const value = record[key];
  if (value !== expected) {
    issues.push(`${path}.${key} must be ${expected}`);
    return undefined;
  }

  return expected;
}

function readIsoString(record: JsonRecord, key: string, path: string, issues: IssueList): string | undefined {
  const value = readString(record, key, path, issues);
  if (value !== undefined && Number.isNaN(Date.parse(value))) {
    issues.push(`${path}.${key} must be an ISO date-time string`);
  }

  return value;
}

function readOptionalIsoString(record: JsonRecord, key: string, path: string, issues: IssueList): string | undefined {
  if (record[key] === undefined) {
    return undefined;
  }

  return readIsoString(record, key, path, issues);
}

function readOptionalUrl(record: JsonRecord, key: string, path: string, issues: IssueList): string | undefined {
  const value = readOptionalString(record, key, path, issues);
  if (value === undefined) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      issues.push(`${path}.${key} must use https`);
    }
  } catch {
    issues.push(`${path}.${key} must be a valid URL`);
  }

  return value;
}

function readArray<T>(
  input: unknown,
  path: string,
  issues: IssueList,
  reader: (input: unknown, path: string, issues: IssueList) => T | undefined
): readonly T[] | undefined {
  if (!Array.isArray(input)) {
    issues.push(`${path} must be an array`);
    return undefined;
  }

  const values = input.map((item, index) => reader(item, `${path}[${index}]`, issues));
  if (values.some((value) => value === undefined)) {
    return undefined;
  }

  return values as readonly T[];
}

function readStringArray(input: unknown, path: string, issues: IssueList): readonly string[] | undefined {
  if (!Array.isArray(input)) {
    issues.push(`${path} must be an array`);
    return undefined;
  }

  const values: string[] = [];
  input.forEach((value, index) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      issues.push(`${path}[${index}] must be a non-empty string`);
    } else {
      values.push(value);
    }
  });

  return values.length === input.length ? values : undefined;
}

function readDetails(input: unknown, path: string, issues: IssueList): Record<string, string | number | boolean | null> | undefined {
  const record = asRecord(input, path, issues);
  if (!record) {
    return undefined;
  }

  const details: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      details[key] = value;
    } else {
      issues.push(`${path}.${key} must be a string, number, boolean, or null`);
    }
  }

  return details;
}
