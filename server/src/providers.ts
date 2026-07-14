import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Asset, GenerationRequest, SourceRecord } from "./schemas.js";
import { createSilentWav } from "./audioAssembly.js";
import { listApprovedVoices, resolveVoiceSettings, validateVoiceId } from "./voiceCatalog.js";

export interface ProviderContext {
  readonly jobId: string;
  readonly idempotencyKey?: string;
  readonly onWriterProgress?: (event: WriterProgressEvent) => Promise<void> | void;
}

export interface ProviderQuotaDetails {
  readonly provider: string;
  readonly status: number;
  readonly creditsRemaining?: number;
  readonly creditsRequired?: number;
  readonly requestId?: string;
}

export class ProviderQuotaExceededError extends Error {
  constructor(
    message: string,
    readonly details: ProviderQuotaDetails
  ) {
    super(message);
    this.name = "ProviderQuotaExceededError";
  }
}

export type WriterProgressPhase = "plan" | "chapter" | "repair" | "complete";

export interface WriterProgressEvent {
  readonly phase: WriterProgressPhase;
  readonly chapterId?: string;
  readonly chapterIndex?: number;
  readonly chapterCount?: number;
  readonly targetWords?: number;
  readonly actualWords?: number;
  readonly message: string;
}

export interface ResearchClaim {
  readonly id: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly confidence: "grounded" | "uncertain";
}

export interface GroundingMetadata {
  readonly provider: string;
  readonly modelId: string;
  readonly requestId?: string;
  readonly searchQueries?: readonly string[];
  readonly sourceIds: readonly string[];
}

export interface ResearchDossier {
  readonly subject: string;
  readonly era?: string;
  readonly location?: string;
  readonly chronology: readonly string[];
  readonly dailyLifeDetails: readonly string[];
  readonly pronunciationCandidates: readonly string[];
  readonly uncertaintyNotes: readonly string[];
  readonly claims: readonly ResearchClaim[];
  readonly sources: readonly SourceRecord[];
  readonly groundingMetadata: readonly GroundingMetadata[];
}

export interface ScriptChapter {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly checkpoint: string;
  readonly summary: string;
  readonly continuitySummary: string;
  readonly estimatedWords: number;
  readonly text: string;
  readonly sourceIds: readonly string[];
}

export interface StoryBible {
  readonly premise: string;
  readonly narrativePointOfView: string;
  readonly toneGuidelines: readonly string[];
  readonly historicalBoundaries: readonly string[];
  readonly pronunciationGuide: readonly string[];
}

export interface ScriptSourceMapEntry {
  readonly sourceId: string;
  readonly title: string;
  readonly claimIds: readonly string[];
  readonly chapterIds: readonly string[];
}

export interface StoryScript {
  readonly title: string;
  readonly synopsis: string;
  readonly storyBible: StoryBible;
  readonly targetDurationMinutes: number;
  readonly estimatedTotalWords: number;
  readonly wordsPerMinute: number;
  readonly sourceMap: readonly ScriptSourceMapEntry[];
  readonly chapters: readonly ScriptChapter[];
  readonly continuitySummary: string;
}

export interface VoiceOption {
  readonly id: string;
  readonly name: string;
  readonly source: "provider_library" | "licensed_custom";
  readonly rightsNote: string;
  readonly defaultSettings: VoiceSettings;
}

export interface VoiceSettings {
  readonly speed: number;
  readonly stability: number;
  readonly similarity: number;
  readonly modelId: string;
}

export interface NarrationInput {
  readonly storyId: string;
  readonly chapter: ScriptChapter;
  readonly voiceId: string;
  readonly settings?: Partial<VoiceSettings>;
}

export interface NarrationAsset extends Asset {
  readonly bytes?: Uint8Array;
}

export interface CoverArtInput {
  readonly storyId: string;
  readonly title: string;
  readonly subject: string;
  readonly prompt: string;
}

export interface CoverArtAsset extends Asset {
  readonly bytes?: Uint8Array;
}

export interface StoredObject {
  readonly key: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly metadata?: Record<string, string>;
}

export interface StoredFileObject {
  readonly key: string;
  readonly mimeType: string;
  readonly filePath: string;
  readonly metadata?: Record<string, string>;
}

export interface StoredObjectResult {
  readonly key: string;
  readonly uri: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
}

export interface ResearchProvider {
  readonly name: string;
  buildDossier(request: GenerationRequest, context: ProviderContext): Promise<ResearchDossier>;
}

export interface WriterProvider {
  readonly name: string;
  writeScript(dossier: ResearchDossier, request: GenerationRequest, context: ProviderContext): Promise<StoryScript>;
}

export interface VoiceProvider {
  readonly name: string;
  listVoices(context: ProviderContext): Promise<readonly VoiceOption[]>;
  narrateChapter(input: NarrationInput, context: ProviderContext): Promise<NarrationAsset>;
}

export interface ImageProvider {
  readonly name: string;
  createCoverArt(input: CoverArtInput, context: ProviderContext): Promise<CoverArtAsset>;
}

export interface StorageProvider {
  readonly name: string;
  putObject(object: StoredObject, context: ProviderContext): Promise<StoredObjectResult>;
  putObjectFile?(object: StoredFileObject, context: ProviderContext): Promise<StoredObjectResult>;
  getObject(key: string, context: ProviderContext): Promise<StoredObject>;
  getObjectUrl(key: string, context: ProviderContext): Promise<string>;
  deleteObject(key: string, context: ProviderContext): Promise<void>;
}

export class MockResearchProvider implements ResearchProvider {
  readonly name: string = "mock-research";

  async buildDossier(request: GenerationRequest, _context: ProviderContext): Promise<ResearchDossier> {
    const sourceId = `source_${slug(request.subject)}`;

    return {
      subject: request.subject,
      era: request.era,
      location: request.location,
      chronology: [
        `${request.subject} fixture chronology begins in ${request.era ?? "the requested era"}.`
      ],
      dailyLifeDetails: [
        "Quiet routines, food, tools, clothing, and evening rituals are emphasized for bedtime pacing."
      ],
      pronunciationCandidates: [request.subject],
      uncertaintyNotes: [],
      claims: [
        {
          id: `claim_${slug(request.subject)}`,
          text: `${request.subject} has enough grounded fixture context for a calm story.`,
          sourceIds: [sourceId],
          confidence: "grounded"
        }
      ],
      sources: [
        {
          id: sourceId,
          title: `${request.subject} mock source`,
          publisher: "Sleepy History Mock Research"
        }
      ],
      groundingMetadata: [
        {
          provider: this.name,
          modelId: "mock-research-model",
          sourceIds: [sourceId]
        }
      ]
    };
  }
}

export class MockWriterProvider implements WriterProvider {
  readonly name = "mock-writer";

  async writeScript(dossier: ResearchDossier, request: GenerationRequest, _context: ProviderContext): Promise<StoryScript> {
    const sourceIds = dossier.sources.map((source) => source.id);
    const chapterCount = 8;
    const wordsPerMinute = 130;
    const estimatedTotalWords = request.targetDurationMinutes * wordsPerMinute;
    const estimatedWords = Math.round(estimatedTotalWords / chapterCount);

    return {
      title: `A Quiet Hour With ${dossier.subject}`,
      synopsis: `A calm original sleep story based on ${dossier.subject}.`,
      storyBible: {
        premise: `A gentle, original story following ${dossier.subject} through ordinary historical routines.`,
        narrativePointOfView: request.perspective ?? "quiet third-person bedtime narrator",
        toneGuidelines: ["slow", "factual", "very gentle", "low suspense"],
        historicalBoundaries: dossier.uncertaintyNotes.length ? dossier.uncertaintyNotes : ["Stay within the sourced dossier."],
        pronunciationGuide: dossier.pronunciationCandidates
      },
      targetDurationMinutes: request.targetDurationMinutes,
      estimatedTotalWords,
      wordsPerMinute,
      sourceMap: dossier.sources.map((source) => ({
        sourceId: source.id,
        title: source.title,
        claimIds: dossier.claims.filter((claim) => claim.sourceIds.includes(source.id)).map((claim) => claim.id),
        chapterIds: Array.from({ length: chapterCount }, (_value, index) => `chapter_${String(index + 1).padStart(2, "0")}`)
      })),
      continuitySummary: "Keep the pacing slow, factual, and gentle across chapters.",
      chapters: Array.from({ length: chapterCount }, (_value, index) => ({
        id: `chapter_${String(index + 1).padStart(2, "0")}`,
        index: index + 1,
        title: index === 0 ? "The Day Settles" : `A Softer Hour ${index + 1}`,
        checkpoint: `Chapter ${index + 1} continues the quiet routine without raising tension.`,
        summary: "A slow checkpoint that adds place, routine, and grounded texture.",
        continuitySummary: "Carry forward the same calm setting, ordinary work, and gentle sensory details.",
        estimatedWords,
        text: `The story continues softly with ${dossier.subject}, keeping the details unhurried and source grounded.`,
        sourceIds
      }))
    };
  }
}

export class MockVoiceProvider implements VoiceProvider {
  readonly name = "mock-voice";

  async listVoices(_context: ProviderContext): Promise<readonly VoiceOption[]> {
    return listApprovedVoices();
  }

  async narrateChapter(input: NarrationInput, _context: ProviderContext): Promise<NarrationAsset> {
    validateVoiceId(input.voiceId);
    resolveVoiceSettings(input.voiceId, input.settings);
    const durationSeconds = Math.max(1, Math.round(input.chapter.estimatedWords / 140));
    const bytes = createSilentWav(durationSeconds);

    return {
      id: `asset_${input.storyId}_${input.chapter.id}_audio`,
      kind: "audio",
      mimeType: "audio/wav",
      uri: `mock://voice/${input.storyId}/${input.chapter.id}.wav`,
      sizeBytes: bytes.byteLength,
      durationSeconds,
      bytes
    };
  }
}

export class MockImageProvider implements ImageProvider {
  readonly name = "mock-image";

  async createCoverArt(input: CoverArtInput, _context: ProviderContext): Promise<CoverArtAsset> {
    const bytes = minimalPngFixture();

    return {
      id: `asset_${input.storyId}_cover`,
      kind: "cover_full",
      mimeType: "image/png",
      uri: `mock://image/${input.storyId}/cover.png`,
      sizeBytes: bytes.byteLength,
      width: 1536,
      height: 1536,
      bytes
    };
  }
}

export interface MockStorageProviderOptions {
  readonly baseUrl?: string;
  readonly signingSecret?: string;
  readonly urlTtlSeconds?: number;
  readonly now?: () => Date;
}

export interface S3CompatibleStorageProviderOptions {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region?: string;
  readonly urlTtlSeconds?: number;
  readonly now?: () => Date;
  readonly fetchImpl?: typeof fetch;
}

export class S3CompatibleStorageProvider implements StorageProvider {
  readonly name = "s3-compatible-storage";
  private readonly endpoint: URL;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly region: string;
  private readonly urlTtlSeconds: number;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;

  constructor(options: S3CompatibleStorageProviderOptions) {
    this.endpoint = new URL(options.endpoint);
    this.bucket = requireNonEmpty(options.bucket, "storage bucket");
    this.accessKeyId = requireNonEmpty(options.accessKeyId, "storage access key id");
    this.secretAccessKey = requireNonEmpty(options.secretAccessKey, "storage secret access key");
    this.region = options.region ?? "auto";
    this.urlTtlSeconds = options.urlTtlSeconds ?? 3600;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async putObject(object: StoredObject, _context: ProviderContext): Promise<StoredObjectResult> {
    const url = this.objectUrl(object.key);
    const body = object.bytes instanceof Uint8Array ? object.bytes : new Uint8Array(object.bytes);
    const headers = this.signedHeaders("PUT", url, body, {
      "content-type": object.mimeType
    });
    const response = await this.fetchImpl(url, {
      method: "PUT",
      headers,
      body: Buffer.from(body)
    });
    await assertStorageResponse(response, `put object ${object.key}`);

    return {
      key: object.key,
      uri: url.toString(),
      sizeBytes: body.byteLength,
      mimeType: object.mimeType
    };
  }

  async putObjectFile(object: StoredFileObject, _context: ProviderContext): Promise<StoredObjectResult> {
    const url = this.objectUrl(object.key);
    const fileStat = await stat(object.filePath);
    const payloadHash = await sha256HexFile(object.filePath);
    const headers = this.signedHeadersForPayloadHash("PUT", url, payloadHash, {
      "content-length": String(fileStat.size),
      "content-type": object.mimeType
    });
    const requestInit: RequestInit & { duplex?: "half" } = {
      method: "PUT",
      headers,
      body: createReadStream(object.filePath) as unknown as BodyInit,
      duplex: "half"
    };
    const response = await this.fetchImpl(url, requestInit);
    await assertStorageResponse(response, `put object ${object.key}`);

    return {
      key: object.key,
      uri: url.toString(),
      sizeBytes: fileStat.size,
      mimeType: object.mimeType
    };
  }

  async getObjectUrl(key: string, _context: ProviderContext): Promise<string> {
    return this.presignedUrl("GET", this.objectUrl(key), this.urlTtlSeconds).toString();
  }

  async getObject(key: string, _context: ProviderContext): Promise<StoredObject> {
    const url = this.objectUrl(key);
    const headers = this.signedHeaders("GET", url, new Uint8Array());
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers
    });
    await assertStorageResponse(response, `get object ${key}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      key,
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
      bytes
    };
  }

  async deleteObject(key: string, _context: ProviderContext): Promise<void> {
    const url = this.objectUrl(key);
    const headers = this.signedHeaders("DELETE", url, new Uint8Array());
    const response = await this.fetchImpl(url, {
      method: "DELETE",
      headers
    });
    await assertStorageResponse(response, `delete object ${key}`);
  }

  private objectUrl(key: string): URL {
    const url = new URL(this.endpoint.toString());
    url.pathname = joinUrlPath(url.pathname, this.bucket, key);
    return url;
  }

  private signedHeaders(method: string, url: URL, body: Uint8Array, extraHeaders: Record<string, string> = {}): Record<string, string> {
    return this.signedHeadersForPayloadHash(method, url, sha256Hex(body), extraHeaders);
  }

  private signedHeadersForPayloadHash(method: string, url: URL, payloadHash: string, extraHeaders: Record<string, string> = {}): Record<string, string> {
    const amzDate = amzDateString(this.now());
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extraHeaders
    };
    const canonical = canonicalRequest(method, url.pathname, "", headers, payloadHash);
    const date = amzDate.slice(0, 8);
    const scope = this.credentialScope(date);
    const signature = this.signature(date, stringToSign(amzDate, scope, canonical));

    return {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames(headers)}, Signature=${signature}`
    };
  }

  private presignedUrl(method: string, url: URL, expiresSeconds: number): URL {
    if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 604800) {
      throw new Error(`Invalid storage signed URL expiry: ${expiresSeconds}`);
    }

    const amzDate = amzDateString(this.now());
    const date = amzDate.slice(0, 8);
    const scope = this.credentialScope(date);
    const signedUrl = new URL(url.toString());
    signedUrl.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    signedUrl.searchParams.set("X-Amz-Credential", `${this.accessKeyId}/${scope}`);
    signedUrl.searchParams.set("X-Amz-Date", amzDate);
    signedUrl.searchParams.set("X-Amz-Expires", String(expiresSeconds));
    signedUrl.searchParams.set("X-Amz-SignedHeaders", "host");

    const canonical = canonicalRequest(
      method,
      signedUrl.pathname,
      canonicalQueryString(signedUrl.searchParams),
      { host: signedUrl.host },
      "UNSIGNED-PAYLOAD"
    );
    signedUrl.searchParams.set("X-Amz-Signature", this.signature(date, stringToSign(amzDate, scope, canonical)));
    return signedUrl;
  }

  private credentialScope(date: string): string {
    return `${date}/${this.region}/s3/aws4_request`;
  }

  private signature(date: string, value: string): string {
    const dateKey = hmacBytes(`AWS4${this.secretAccessKey}`, date);
    const regionKey = hmacBytes(dateKey, this.region);
    const serviceKey = hmacBytes(regionKey, "s3");
    const signingKey = hmacBytes(serviceKey, "aws4_request");
    return createHmac("sha256", signingKey).update(value).digest("hex");
  }
}

export function createStorageProviderFromEnv(env: NodeJS.ProcessEnv = process.env): StorageProvider {
  const provider = env.STORAGE_PROVIDER ?? "local";
  if (provider === "s3") {
    return new S3CompatibleStorageProvider({
      endpoint: requireEnvValue(env, "STORAGE_ENDPOINT"),
      bucket: requireEnvValue(env, "STORAGE_BUCKET"),
      accessKeyId: requireEnvValue(env, "STORAGE_ACCESS_KEY_ID"),
      secretAccessKey: requireEnvValue(env, "STORAGE_SECRET_ACCESS_KEY")
    });
  }

  if (provider === "local") {
    return new MockStorageProvider({
      signingSecret: requireEnvValue(env, "STORAGE_SIGNING_SECRET"),
      baseUrl: env.PUBLIC_API_BASE_URL
    });
  }

  throw new Error(`Unsupported STORAGE_PROVIDER: ${provider}`);
}

export class MockStorageProvider implements StorageProvider {
  readonly name = "mock-storage";
  private readonly objects = new Map<string, StoredObject>();
  private readonly baseUrl: string;
  private readonly signingSecret: string;
  private readonly urlTtlSeconds: number;
  private readonly now: () => Date;

  constructor(options: MockStorageProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://sleepy-history.local";
    if (!options.signingSecret || options.signingSecret.length < 32) {
      throw new Error("Storage signing secret must be explicitly configured with at least 32 characters");
    }
    this.signingSecret = options.signingSecret;
    this.urlTtlSeconds = options.urlTtlSeconds ?? 3600;
    this.now = options.now ?? (() => new Date());
  }

  async putObject(object: StoredObject, _context: ProviderContext): Promise<StoredObjectResult> {
    this.objects.set(object.key, object);

    return {
      key: object.key,
      uri: `sleepy-history://storage/${encodeURIComponent(object.key)}`,
      sizeBytes: object.bytes.byteLength,
      mimeType: object.mimeType
    };
  }

  async getObjectUrl(key: string, _context: ProviderContext): Promise<string> {
    if (!this.objects.has(key)) {
      throw new Error(`Stored object not found: ${key}`);
    }

    const expiresAt = new Date(this.now().getTime() + this.urlTtlSeconds * 1000).toISOString();
    const token = signStorageUrl(key, expiresAt, this.signingSecret);
    const url = new URL(`/objects/${encodeURIComponent(key)}`, this.baseUrl);
    url.searchParams.set("expiresAt", expiresAt);
    url.searchParams.set("token", token);
    return url.toString();
  }

  async getObject(key: string, _context: ProviderContext): Promise<StoredObject> {
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`Stored object not found: ${key}`);
    }
    return object;
  }

  async resolveObjectUrl(urlValue: string, _context: ProviderContext): Promise<StoredObject> {
    const url = new URL(urlValue);
    if (url.origin !== new URL(this.baseUrl).origin || !url.pathname.startsWith("/objects/")) {
      throw new Error("Storage URL origin or path is not recognized");
    }

    const key = decodeURIComponent(url.pathname.slice("/objects/".length));
    const expiresAt = url.searchParams.get("expiresAt");
    const token = url.searchParams.get("token");
    if (!expiresAt || !token) {
      throw new Error("Storage URL is missing token or expiry");
    }
    const expiresAtTime = new Date(expiresAt).getTime();
    if (!Number.isFinite(expiresAtTime)) {
      throw new Error("Storage URL expiry is invalid");
    }
    if (expiresAtTime <= this.now().getTime()) {
      throw new Error("Storage URL has expired");
    }
    if (!isValidStorageToken(key, expiresAt, token, this.signingSecret)) {
      throw new Error("Storage URL token is invalid");
    }

    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`Stored object not found: ${key}`);
    }
    return object;
  }

  async deleteObject(key: string, _context: ProviderContext): Promise<void> {
    this.objects.delete(key);
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function requireEnvValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

async function assertStorageResponse(response: Response, action: string): Promise<void> {
  if (response.ok) {
    return;
  }

  let detail = "";
  try {
    detail = await response.text();
  } catch {
    detail = "";
  }
  throw new Error(`Storage failed to ${action}: HTTP ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ""}`);
}

function joinUrlPath(basePath: string, bucket: string, key: string): string {
  return [
    ...basePath.split("/").filter(Boolean).map(encodeURIComponent),
    encodeURIComponent(bucket),
    ...key.split("/").filter(Boolean).map(encodeURIComponent)
  ].join("/").replace(/^/, "/");
}

function amzDateString(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256HexFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function hmacBytes(key: string | Uint8Array, value: string): Uint8Array {
  return createHmac("sha256", key).update(value).digest();
}

function canonicalRequest(
  method: string,
  pathname: string,
  query: string,
  headers: Record<string, string>,
  payloadHash: string
): string {
  return [
    method.toUpperCase(),
    canonicalUri(pathname),
    query,
    canonicalHeaders(headers),
    signedHeaderNames(headers),
    payloadHash
  ].join("\n");
}

function canonicalUri(pathname: string): string {
  return pathname.split("/").map((part) => encodeURIComponent(decodeURIComponent(part))).join("/");
}

function canonicalHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
}

function signedHeaderNames(headers: Record<string, string>): string {
  return Object.keys(headers).map((name) => name.toLowerCase()).sort().join(";");
}

function canonicalQueryString(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      const nameOrder = leftName.localeCompare(rightName);
      return nameOrder === 0 ? leftValue.localeCompare(rightValue) : nameOrder;
    })
    .map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`)
    .join("&");
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function stringToSign(amzDate: string, scope: string, request: string): string {
  return [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(request)
  ].join("\n");
}

function signStorageUrl(key: string, expiresAt: string, secret: string): string {
  return createHmac("sha256", secret).update(`${key}\n${expiresAt}`).digest("base64url");
}

function isValidStorageToken(key: string, expiresAt: string, token: string, secret: string): boolean {
  const expected = Buffer.from(signStorageUrl(key, expiresAt, secret));
  const actual = Buffer.from(token);
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

function minimalPngFixture(): Uint8Array {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4cf7AfwAI0QOHKybRAwAAAABJRU5ErkJggg==",
    "base64"
  );
}
