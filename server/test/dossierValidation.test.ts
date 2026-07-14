import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeSourceFetcher, type SafeSourceFetcherOptions, validateDossier } from "../src/dossierValidation.js";
import type { ResearchDossier } from "../src/providers.js";

describe("dossier validation", () => {
  it("accepts sourced dossiers with grounding metadata and quiet daily-life details", () => {
    const result = validateDossier(validDossier());

    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
  });

  it("rejects unsupported claims and missing grounding metadata", () => {
    const dossier: ResearchDossier = {
      ...validDossier(),
      groundingMetadata: [],
      claims: [
        {
          id: "claim_unknown_source",
          text: "A market routine claim without a known source.",
          sourceIds: ["missing_source"],
          confidence: "grounded"
        }
      ]
    };
    const result = validateDossier(dossier);

    assert.equal(result.ok, false);
    assert.match(result.issues.join("\n"), /missing grounding metadata/);
    assert.match(result.issues.join("\n"), /unknown source missing_source/);
  });

  it("rejects conflicting dates and dates outside the requested era", () => {
    const dossier: ResearchDossier = {
      ...validDossier(),
      era: "900 to 950 CE",
      chronology: ["The story begins in 920 CE.", "A conflicting event is listed in 1900 CE."]
    };
    const result = validateDossier(dossier);

    assert.equal(result.ok, false);
    assert.match(result.issues.join("\n"), /outside the requested era/);
  });

  it("rejects unsupported era claims without weakening sourced dossiers", () => {
    const dossier: ResearchDossier = {
      ...validDossier(),
      era: "17th century CE",
      chronology: ["The fixture incorrectly uses a detail from 920 CE."]
    };
    const result = validateDossier(dossier);

    assert.equal(result.ok, false);
    assert.match(result.issues.join("\n"), /outside the requested era/);
  });
});

describe("safe source fetcher", () => {
  it("does not perform arbitrary live citation fetches by default", async () => {
    await assert.rejects(
      safeSourceFetcher("https://example.com/source"),
      /Live source fetching is disabled/
    );
  });

  it("stores sanitized citation metadata for HTTPS sources", async () => {
    const metadata = await safeSourceFetcher("https://example.com/source", {
      resolveHost: async () => ["93.184.216.34"],
      now: () => "2026-05-10T01:30:00.000Z",
      fetchImpl: async () => new Response("<html><head><title> Fixture Source </title></head><body>ignored</body></html>", {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": "76"
        }
      })
    });

    assert.equal(metadata.url, "https://example.com/source");
    assert.equal(metadata.finalUrl, "https://example.com/source");
    assert.equal(metadata.title, "Fixture Source");
    assert.equal(metadata.contentType, "text/html; charset=utf-8");
    assert.equal(metadata.contentLength, 76);
    assert.equal(metadata.fetchedAt, "2026-05-10T01:30:00.000Z");
  });

  it("blocks non-HTTPS and private source URLs", async () => {
    await assert.rejects(safeSourceFetcher("http://example.com", safeOptions()), /Only HTTPS/);
    await assert.rejects(safeSourceFetcher("https://localhost/source", safeOptions()), /Private or local/);
    await assert.rejects(safeSourceFetcher("https://127.0.0.1/source", safeOptions()), /Private or local/);
    await assert.rejects(safeSourceFetcher("https://192.168.1.10/source", safeOptions()), /Private or local/);
    await assert.rejects(safeSourceFetcher("https://[::1]/source", safeOptions()), /Private or local/);
    await assert.rejects(safeSourceFetcher("https://[fe81::1]/source", safeOptions()), /Private or local/);
    await assert.rejects(safeSourceFetcher("https://metadata.example/source", safeOptions({
      resolveHost: async () => ["169.254.169.254"]
    })), /Private or local/);
    await assert.rejects(safeSourceFetcher("https://ipv6.example/source", safeOptions({
      resolveHost: async () => ["fe81::1"]
    })), /Private or local/);
    await assert.rejects(safeSourceFetcher("https://mapped-private.example/source", safeOptions({
      resolveHost: async () => ["::ffff:172.16.0.1"]
    })), /Private or local/);
    await assert.rejects(safeSourceFetcher("https://mapped-metadata.example/source", safeOptions({
      resolveHost: async () => ["::ffff:169.254.169.254"]
    })), /Private or local/);
  });

  it("caps redirects and validates redirected targets", async () => {
    await assert.rejects(
      safeSourceFetcher("https://example.com/start", {
        resolveHost: async () => ["93.184.216.34"],
        maxRedirects: 1,
        fetchImpl: async () => new Response("", {
          status: 302,
          headers: {
            Location: "https://example.com/next"
          }
        })
      }),
      /Redirect limit exceeded/
    );

    await assert.rejects(
      safeSourceFetcher("https://example.com/start", {
        resolveHost: async () => ["93.184.216.34"],
        fetchImpl: async () => new Response("", {
          status: 302,
          headers: {
            Location: "http://example.com/insecure"
          }
        })
      }),
      /Only HTTPS/
    );

    await assert.rejects(
      safeSourceFetcher("https://example.com/start", {
        resolveHost: async (hostname) => hostname === "internal.example" ? ["10.0.0.8"] : ["93.184.216.34"],
        fetchImpl: async () => new Response("", {
          status: 302,
          headers: {
            Location: "https://internal.example/source"
          }
        })
      }),
      /Private or local/
    );
  });

  it("caps response size by headers and body bytes", async () => {
    await assert.rejects(
      safeSourceFetcher("https://example.com/too-large-header", {
        resolveHost: async () => ["93.184.216.34"],
        maxBytes: 10,
        fetchImpl: async () => new Response("small", {
          status: 200,
          headers: {
            "Content-Length": "100"
          }
        })
      }),
      /size limit/
    );

    await assert.rejects(
      safeSourceFetcher("https://example.com/too-large-body", {
        resolveHost: async () => ["93.184.216.34"],
        maxBytes: 3,
        fetchImpl: async () => new Response("larger than three bytes", {
          status: 200
        })
      }),
      /size limit/
    );
  });

  it("honors timeout caps", async () => {
    await assert.rejects(
      safeSourceFetcher("https://example.com/slow", {
        resolveHost: async () => ["93.184.216.34"],
        timeoutMs: 1,
        fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
        })
      }),
      /aborted by timeout/
    );
  });
});

function validDossier(): ResearchDossier {
  return {
    subject: "a baker in Abbasid Baghdad",
    era: "900 to 950 CE",
    location: "Baghdad",
    chronology: ["The story context stays near 920 CE."],
    dailyLifeDetails: ["Bread ovens and morning markets support the daily-life perspective."],
    pronunciationCandidates: ["Abbasid", "Baghdad"],
    uncertaintyNotes: ["Specific household routines are represented cautiously."],
    claims: [
      {
        id: "claim_bread_market",
        text: "Bread and markets shaped ordinary daily routines in 920 CE.",
        sourceIds: ["source_foodways"],
        confidence: "grounded"
      }
    ],
    sources: [
      {
        id: "source_foodways",
        title: "Fixture Foodways Source",
        publisher: "Sleepy History Fixture Archive"
      }
    ],
    groundingMetadata: [
      {
        provider: "gemini",
        modelId: "gemini-3.1-pro-preview",
        sourceIds: ["source_foodways"]
      }
    ]
  };
}

function safeOptions(overrides: SafeSourceFetcherOptions = {}): SafeSourceFetcherOptions {
  return {
    resolveHost: async () => ["93.184.216.34"],
    fetchImpl: async () => new Response("", { status: 200 }),
    ...overrides
  };
}
