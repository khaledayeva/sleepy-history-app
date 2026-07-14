import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  MockImageProvider,
  MockResearchProvider,
  S3CompatibleStorageProvider,
  createStorageProviderFromEnv,
  MockStorageProvider,
  MockVoiceProvider,
  MockWriterProvider
} from "../src/providers.js";
import type { GenerationRequest } from "../src/schemas.js";

const request: GenerationRequest = {
  schemaVersion: "2026-05-10",
  kind: "daily_life",
  subject: "a night watchman in medieval Cordoba",
  targetDurationMinutes: 60,
  era: "10th century CE",
  location: "Cordoba",
  perspective: "ordinary worker finishing a calm night shift",
  voiceId: "calm_narrator_01",
  ambience: "none",
  safety: {
    bedtimeTone: "very_gentle",
    allowHistoricalViolenceContext: false
  }
};

const context = {
  jobId: "job_provider_contract",
  idempotencyKey: "idem_provider_contract"
};

describe("modular provider contracts", () => {
  it("builds a research dossier with claims and sources", async () => {
    const provider = new MockResearchProvider();
    const dossier = await provider.buildDossier(request, context);

    assert.equal(provider.name, "mock-research");
    assert.equal(dossier.subject, request.subject);
    assert.equal(dossier.claims[0]?.confidence, "grounded");
    assert.equal(dossier.sources.length, 1);
  });

  it("writes a chaptered story script from a dossier", async () => {
    const dossier = await new MockResearchProvider().buildDossier(request, context);
    const script = await new MockWriterProvider().writeScript(dossier, request, context);

    assert.equal(script.targetDurationMinutes, 60);
    assert.equal(script.chapters.length, 8);
    assert.equal(script.chapters[0]?.index, 1);
    assert.ok(script.storyBible.premise);
    assert.ok(script.sourceMap[0]?.chapterIds.includes("chapter_01"));
    assert.ok(script.chapters[0]?.sourceIds.length);
  });

  it("lists approved mock voices and narrates a chapter", async () => {
    const dossier = await new MockResearchProvider().buildDossier(request, context);
    const script = await new MockWriterProvider().writeScript(dossier, request, context);
    const voiceProvider = new MockVoiceProvider();
    const voices = await voiceProvider.listVoices(context);
    const chapter = script.chapters[0];

    assert.ok(chapter);
    assert.equal(voices[0]?.id, "calm_narrator_01");
    assert.equal(voices[0]?.source, "provider_library");

    const asset = await voiceProvider.narrateChapter({
      storyId: "story_provider_contract",
      chapter,
      voiceId: voices[0]?.id ?? "calm_narrator_01"
    }, context);

    assert.equal(asset.kind, "audio");
    assert.equal(asset.mimeType, "audio/wav");
    assert.ok(asset.bytes);
  });

  it("creates cover art assets behind an image provider interface", async () => {
    const asset = await new MockImageProvider().createCoverArt({
      storyId: "story_provider_contract",
      title: "A Quiet Hour",
      subject: request.subject,
      prompt: "A calm historical bedtime cover, non-branded."
    }, context);

    assert.equal(asset.kind, "cover_full");
    assert.equal(asset.width, 1536);
    assert.equal(asset.height, 1536);
    assert.equal(asset.mimeType, "image/png");
    assert.ok(asset.bytes);
  });

  it("stores, resolves, and deletes generated objects behind token-protected URLs", async () => {
    const storage = new MockStorageProvider({
      signingSecret: "test-storage-signing-secret-32-bytes-minimum",
      now: () => new Date("2026-05-10T02:30:00.000Z"),
      urlTtlSeconds: 60
    });
    const result = await storage.putObject({
      key: "stories/story_provider_contract/transcript.json",
      mimeType: "application/json",
      bytes: new TextEncoder().encode("{\"ok\":true}")
    }, context);
    const url = await storage.getObjectUrl(result.key, context);
    const resolved = await storage.resolveObjectUrl(url, context);

    assert.equal(result.sizeBytes, 11);
    assert.match(url, /^https:\/\/sleepy-history\.local\/objects\//);
    assert.equal(resolved.mimeType, "application/json");

    await storage.deleteObject(result.key, context);
    await assert.rejects(storage.getObjectUrl(result.key, context), /Stored object not found/);
  });

  it("rejects expired and tampered storage URLs", async () => {
    let now = new Date("2026-05-10T02:30:00.000Z");
    const storage = new MockStorageProvider({
      signingSecret: "test-storage-signing-secret-32-bytes-minimum",
      now: () => now,
      urlTtlSeconds: 60
    });
    await storage.putObject({
      key: "stories/story_provider_contract/sources.json",
      mimeType: "application/json",
      bytes: new TextEncoder().encode("[]")
    }, context);
    const url = await storage.getObjectUrl("stories/story_provider_contract/sources.json", context);
    const tampered = new URL(url);
    tampered.searchParams.set("token", "bad-token");

    await assert.rejects(storage.resolveObjectUrl(tampered.toString(), context), /token is invalid/);

    now = new Date("2026-05-10T02:31:01.000Z");
    await assert.rejects(storage.resolveObjectUrl(url, context), /expired/);
  });

  it("requires an explicit storage signing secret and rejects invalid expiry values", async () => {
    assert.throws(() => new MockStorageProvider(), /signing secret/);

    const storage = new MockStorageProvider({
      signingSecret: "test-storage-signing-secret-32-bytes-minimum",
      now: () => new Date("2026-05-10T02:30:00.000Z"),
      urlTtlSeconds: 60
    });
    await storage.putObject({
      key: "stories/story_provider_contract/audio.wav",
      mimeType: "audio/wav",
      bytes: new Uint8Array([1, 2, 3])
    }, context);
    const url = await storage.getObjectUrl("stories/story_provider_contract/audio.wav", context);
    const malformedExpiry = new URL(url);
    malformedExpiry.searchParams.set("expiresAt", "not-a-date");
    malformedExpiry.searchParams.set(
      "token",
      "ulkhFMRjuz6EBUSyewGH0nSMsXsDMgLSBVxrpMLHxR0"
    );

    await assert.rejects(storage.resolveObjectUrl(malformedExpiry.toString(), context), /expiry is invalid/);
  });

  it("stores and signs objects for R2-compatible S3 storage", async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        init: init ?? {}
      });
      return new Response("", { status: 200 });
    };
    const storage = new S3CompatibleStorageProvider({
      endpoint: "https://abc123.r2.cloudflarestorage.com",
      bucket: "sleepy-history-stories",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      now: () => new Date("2026-05-10T02:30:00.000Z"),
      fetchImpl
    });

    const stored = await storage.putObject({
      key: "stories/story_provider_contract/transcript.json",
      mimeType: "application/json",
      bytes: new TextEncoder().encode("{\"ok\":true}")
    }, context);
    const signedUrl = new URL(await storage.getObjectUrl(stored.key, context));
    await storage.deleteObject(stored.key, context);

    assert.equal(stored.uri, "https://abc123.r2.cloudflarestorage.com/sleepy-history-stories/stories/story_provider_contract/transcript.json");
    assert.equal(requests[0]?.url, stored.uri);
    assert.equal(requests[0]?.init.method, "PUT");
    assert.match(String(new Headers(requests[0]?.init.headers).get("authorization")), /^AWS4-HMAC-SHA256 Credential=test-access-key\//);
    assert.equal(new Headers(requests[0]?.init.headers).get("content-type"), "application/json");
    assert.equal(signedUrl.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
    assert.equal(signedUrl.searchParams.get("X-Amz-SignedHeaders"), "host");
    assert.match(signedUrl.searchParams.get("X-Amz-Signature") ?? "", /^[a-f0-9]{64}$/);
    assert.equal(requests[1]?.init.method, "DELETE");
  });

  it("streams file objects to R2-compatible S3 storage without buffering the body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sleepy-history-s3-file-"));
    try {
      const filePath = join(directory, "audio.wav");
      await writeFile(filePath, Buffer.from("streamed audio bytes"));
      const requests: { readonly url: string; readonly init: RequestInit }[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        requests.push({
          url: String(input),
          init: init ?? {}
        });
        return new Response("", { status: 200 });
      };
      const storage = new S3CompatibleStorageProvider({
        endpoint: "https://abc123.r2.cloudflarestorage.com",
        bucket: "sleepy-history-stories",
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
        now: () => new Date("2026-05-10T02:30:00.000Z"),
        fetchImpl
      });

      const stored = await storage.putObjectFile({
        key: "stories/story_provider_contract/audio.wav",
        mimeType: "audio/wav",
        filePath
      }, context);
      const headers = new Headers(requests[0]?.init.headers);
      const body = requests[0]?.init.body;

      assert.equal(stored.sizeBytes, Buffer.byteLength("streamed audio bytes"));
      assert.equal(requests[0]?.init.method, "PUT");
      assert.equal(headers.get("content-length"), String(Buffer.byteLength("streamed audio bytes")));
      assert.equal(headers.get("content-type"), "audio/wav");
      assert.match(headers.get("x-amz-content-sha256") ?? "", /^[a-f0-9]{64}$/);
      assert.equal(body instanceof Uint8Array, false);
      assert.equal(typeof (body as { readonly pipe?: unknown } | undefined)?.pipe, "function");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates the configured storage provider from environment variables", () => {
    const storage = createStorageProviderFromEnv({
      STORAGE_PROVIDER: "s3",
      STORAGE_BUCKET: "sleepy-history-stories",
      STORAGE_ENDPOINT: "https://abc123.r2.cloudflarestorage.com",
      STORAGE_ACCESS_KEY_ID: "test-access-key",
      STORAGE_SECRET_ACCESS_KEY: "test-secret-key"
    });

    assert.equal(storage.name, "s3-compatible-storage");
    assert.throws(() => createStorageProviderFromEnv({ STORAGE_PROVIDER: "s3" }), /STORAGE_ENDPOINT is required/);
    assert.throws(() => createStorageProviderFromEnv({ STORAGE_PROVIDER: "unknown" }), /Unsupported STORAGE_PROVIDER/);
  });
});
