import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GeminiResearchProvider,
  MockGeminiResearchProvider,
  parseGeminiResearchResponse
} from "../src/geminiResearchProvider.js";
import { createGenerationRequest } from "../src/generationRequests.js";

const request = createGenerationRequest({
  kind: "daily_life",
  subject: "a baker in Abbasid Baghdad",
  era: "9th century CE",
  location: "Baghdad",
  perspective: "ordinary worker closing a market day"
});

const context = {
  jobId: "job_gemini_research",
  idempotencyKey: "sleepy-history:job_gemini_research:researching"
};

describe("Gemini research adapter", () => {
  it("returns a mock dossier with claims, sources, chronology, pronunciation, and uncertainty notes", async () => {
    const dossier = await new MockGeminiResearchProvider().buildDossier(request, context);

    assert.equal(dossier.subject, request.subject);
    assert.ok(dossier.chronology.length);
    assert.ok(dossier.dailyLifeDetails.length);
    assert.ok(dossier.pronunciationCandidates.includes(request.subject));
    assert.ok(Array.isArray(dossier.uncertaintyNotes));
    assert.equal(dossier.claims[0]?.sourceIds[0], dossier.sources[0]?.id);
    assert.equal(dossier.groundingMetadata[0]?.provider, "mock-gemini-research");
  });

  it("parses Gemini JSON text and grounding metadata into the shared dossier shape", () => {
    const dossier = parseGeminiResearchResponse({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  subject: request.subject,
                  era: request.era,
                  location: request.location,
                  chronology: ["Baghdad flourished as an Abbasid capital."],
                  dailyLifeDetails: ["Bread ovens served neighborhoods and markets."],
                  pronunciationCandidates: ["Baghdad", "Abbasid"],
                  uncertaintyNotes: ["Specific routines vary by household and district."],
                  claims: [
                    {
                      id: "claim_market_bread",
                      text: "Bread and markets were central to urban daily life.",
                      sourceIds: ["source_market_food"],
                      confidence: "grounded"
                    }
                  ],
                  sources: [
                    {
                      id: "source_market_food",
                      title: "Fixture Study of Abbasid Foodways",
                      publisher: "Sleepy History Fixture Archive"
                    }
                  ]
                })
              }
            ]
          },
          groundingMetadata: {
            webSearchQueries: ["Abbasid Baghdad daily life bread markets"],
            groundingChunks: [
              {
                web: {
                  uri: "https://www.worldhistory.org/Abbasid_Dynasty/",
                  title: "Abbasid Dynasty"
                }
              }
            ]
          }
        }
      ]
    }, request, "gemini-3.1-pro-preview", "request_fixture");

    assert.equal(dossier.claims[0]?.id, "claim_market_bread");
    assert.equal(dossier.sources.length, 2);
    assert.equal(dossier.groundingMetadata[0]?.modelId, "gemini-3.1-pro-preview");
    assert.equal(dossier.groundingMetadata[0]?.requestId, "request_fixture");
    assert.equal(dossier.groundingMetadata[0]?.searchQueries?.[0], "Abbasid Baghdad daily life bread markets");
  });

  it("falls back when real Gemini source titles are blank", () => {
    const dossier = parseGeminiResearchResponse({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  subject: request.subject,
                  chronology: ["Market ovens served neighborhoods before dawn."],
                  dailyLifeDetails: ["Bakers prepared dough, tended ovens, and sold bread in familiar morning rhythms."],
                  pronunciationCandidates: ["Abbasid", "Baghdad"],
                  uncertaintyNotes: ["Exact routines varied by district and household."],
                  claims: [
                    {
                      id: "claim_oven_routine",
                      text: "Urban bread work relied on ovens and market routines.",
                      sourceIds: ["source_blank_title"],
                      confidence: "grounded"
                    }
                  ],
                  sources: [
                    {
                      id: "source_blank_title",
                      title: "",
                      url: "https://example.org/foodways"
                    }
                  ]
                })
              }
            ]
          },
          groundingMetadata: {
            groundingChunks: [
              {
                web: {
                  uri: "https://example.com/grounding",
                  title: ""
                }
              }
            ]
          }
        }
      ]
    }, request);

    assert.equal(dossier.sources[0]?.title, "example.org");
    assert.equal(dossier.sources[1]?.title, "example.com");
  });

  it("uses the configured Gemini model endpoint and can verify model availability with mocked fetch", async () => {
    const requests: string[] = [];
    const provider = new GeminiResearchProvider({
      apiKey: "test-key",
      baseUrl: "https://gemini.test/v1beta",
      fetchImpl: async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify({
          models: [
            {
              name: "models/gemini-3.1-pro-preview"
            }
          ]
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }
    });

    assert.equal(await provider.verifyModelAvailable(), true);
    assert.equal(requests[0], "https://gemini.test/v1beta/models?key=test-key");
  });

  it("calls generateContent with grounding enabled and returns the adapter dossier shape", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const provider = new GeminiResearchProvider({
      apiKey: "test-key",
      baseUrl: "https://gemini.test/v1beta",
      fetchImpl: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;

        return new Response(JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      subject: request.subject,
                      era: request.era,
                      location: request.location,
                      chronology: ["Market ovens served neighborhoods before dawn."],
                      dailyLifeDetails: ["Bakers prepared dough, tended ovens, and sold bread in familiar morning rhythms."],
                      pronunciationCandidates: ["Abbasid", "Baghdad"],
                      uncertaintyNotes: ["Exact routines varied by district and household."],
                      claims: [
                        {
                          id: "claim_oven_routine",
                          text: "Urban bread work relied on ovens and market routines.",
                          sourceIds: ["source_oven_routine"],
                          confidence: "grounded"
                        }
                      ],
                      sources: [
                        {
                          id: "source_oven_routine",
                          title: "Fixture Urban Foodways",
                          publisher: "Sleepy History Fixture Archive"
                        }
                      ]
                    })
                  }
                ]
              },
              groundingMetadata: {
                webSearchQueries: ["Abbasid Baghdad bread markets"],
                groundingChunks: [
                  {
                    web: {
                      uri: "https://www.worldhistory.org/Abbasid_Dynasty/",
                      title: "Abbasid Dynasty"
                    }
                  }
                ]
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-request-id": "mocked_gemini_request"
          }
        });
      }
    });

    const dossier = await provider.buildDossier(request, context);
    const body = JSON.parse(String(capturedInit?.body)) as {
      readonly contents: readonly { readonly parts: readonly { readonly text: string }[] }[];
      readonly tools: readonly { readonly googleSearch?: Record<string, never> }[];
      readonly generationConfig: { readonly responseMimeType: string };
    };

    assert.equal(capturedUrl, "https://gemini.test/v1beta/models/gemini-3.1-pro-preview:generateContent?key=test-key");
    assert.equal(capturedInit?.method, "POST");
    assert.equal((capturedInit?.headers as Record<string, string>)["X-Sleepy-History-Job"], "job_gemini_research");
    assert.deepEqual(body.tools, [{ googleSearch: {} }]);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.match(body.contents[0]?.parts[0]?.text ?? "", /source-grounded research dossier/);
    assert.equal(dossier.claims[0]?.sourceIds[0], "source_oven_routine");
    assert.equal(dossier.chronology[0], "Market ovens served neighborhoods before dawn.");
    assert.equal(dossier.dailyLifeDetails[0], "Bakers prepared dough, tended ovens, and sold bread in familiar morning rhythms.");
    assert.equal(dossier.pronunciationCandidates[0], "Abbasid");
    assert.equal(dossier.uncertaintyNotes[0], "Exact routines varied by district and household.");
    assert.equal(dossier.groundingMetadata[0]?.requestId, "mocked_gemini_request");
    assert.equal(dossier.groundingMetadata[0]?.sourceIds.includes("gemini_grounding_1"), true);
  });

  it("can run a real-provider smoke test when GEMINI_API_KEY is present", {
    skip: !process.env.GEMINI_API_KEY
  }, async () => {
    const provider = new GeminiResearchProvider({
      apiKey: process.env.GEMINI_API_KEY ?? ""
    });

    assert.equal(await provider.verifyModelAvailable(), true);
  });
});
