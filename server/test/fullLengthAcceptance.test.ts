import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSilentWav, inspectWav } from "../src/audioAssembly.js";
import {
  fullLengthAcceptanceAudioDurationRangeSeconds,
  missingFullLengthAcceptanceEnv,
  runFullLengthAcceptance
} from "../src/fullLengthAcceptance.js";
import {
  MockImageProvider,
  MockResearchProvider,
  MockStorageProvider,
  MockWriterProvider,
  type NarrationAsset,
  type NarrationInput,
  type ProviderContext,
  type ResearchDossier,
  type StoryScript,
  type VoiceOption,
  type VoiceProvider
} from "../src/providers.js";
import type { GenerationRequest } from "../src/schemas.js";
import {
  createStoryScriptDiagnostics,
  StoryScriptValidationError,
  validateStoryScript
} from "../src/storyScriptValidation.js";

describe("full-length acceptance workflow", () => {
  it("reports all required provider and R2 storage configuration before spending", () => {
    assert.deepEqual(missingFullLengthAcceptanceEnv({}), [
      "GEMINI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ELEVENLABS_API_KEY",
      "ELEVENLABS_VOICE_ID",
      "OPENAI_API_KEY",
      "STORAGE_PROVIDER",
      "STORAGE_ENDPOINT",
      "STORAGE_BUCKET",
      "STORAGE_ACCESS_KEY_ID",
      "STORAGE_SECRET_ACCESS_KEY"
    ]);
  });

  it("fails closed when the estimated cost exceeds the explicit acceptance budget cap", async () => {
    await assert.rejects(
      runFullLengthAcceptance({
        providers: mockAcceptanceProviders(),
        budgetCapUsd: 1,
        targetDurationMinutes: 60
      }),
      /exceeds approved budget cap/
    );
  });

  it("uses a broad around-an-hour audio duration window by default", () => {
    assert.deepEqual(fullLengthAcceptanceAudioDurationRangeSeconds(60), {
      min: 45 * 60,
      max: 80 * 60
    });
  });

  it("runs a restart-backed acceptance pass with mocked providers", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sleepy-history-full-acceptance-test-"));
    const result = await runFullLengthAcceptance({
      outputDirectory,
      providers: mockAcceptanceProviders(),
      budgetCapUsd: 25,
      targetDurationMinutes: 55,
      now: tickingNow(),
      expectedDurationSecondsRange: {
        min: 7,
        max: 9
      }
    });

    assert.equal(result.skipped, false);
    assert.equal(result.finalStatus, "completed");
    assert.equal(result.storyId, "story_full_length_acceptance");
    assert.equal(result.approvedBudgetCapUsd, 25);
    assert.equal(result.estimatedCostUsd <= 25, true);
    assert.equal(result.targetDurationMinutes, 55);
    assert.equal(result.restartEvidence.queuedBeforeRestart, true);
    assert.equal(result.restartEvidence.processedAfterRestart, true);
    assert.equal(result.retryEvidence.queueAttempts, 1);
    assert.equal(result.retryEvidence.paidRetriesUsed, 0);
    assert.equal(result.retryEvidence.failureCount, 0);
    assert.equal(result.chunkCount, 8);
    assert.equal(result.links.some((link) => link.role === "audio"), true);

    const audioBytes = await readFile(result.audioPath);
    const audioInspection = inspectWav(audioBytes);
    assert.equal(audioInspection.durationSeconds, 8);
    const summary = JSON.parse(await readFile(result.summaryPath, "utf8")) as {
      readonly restartEvidence?: { readonly queuedBeforeRestart?: boolean };
      readonly retryEvidence?: { readonly paidRetriesUsed?: number };
      readonly chunkCount?: number;
    };
    assert.equal(summary.restartEvidence?.queuedBeforeRestart, true);
    assert.equal(summary.retryEvidence?.paidRetriesUsed, 0);
    assert.equal(summary.chunkCount, 8);
  });

  it("writes sanitized draft diagnostics when acceptance fails during script validation", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sleepy-history-full-acceptance-failure-test-"));

    await assert.rejects(
      runFullLengthAcceptance({
        outputDirectory,
        providers: {
          ...mockAcceptanceProviders(),
          writer: new DiagnosticsFailingWriter()
        },
        budgetCapUsd: 25,
        targetDurationMinutes: 55,
        now: tickingNow()
      }),
      /Full-length acceptance did not complete: failed/
    );

    const failureSummary = JSON.parse(await readFile(join(outputDirectory, "failure-summary.json"), "utf8")) as {
      readonly diagnosticsPath?: string;
    };
    const diagnostics = JSON.parse(await readFile(join(outputDirectory, "draft-script-diagnostics.json"), "utf8")) as {
      readonly issues?: readonly string[];
      readonly chapters?: readonly { readonly actualWords?: number; readonly targetWords?: number }[];
    };

    assert.equal(failureSummary.diagnosticsPath, "draft-script-diagnostics.json");
    assert.match(diagnostics.issues?.join("; ") ?? "", /estimated duration falls outside tolerance/);
    assert.equal(diagnostics.chapters?.[0]?.actualWords, 2);
    assert.equal(JSON.stringify(diagnostics).includes("short text"), false);
    assert.equal((diagnostics.chapters?.[0]?.targetWords ?? 0) > 2, true);
  });
});

function mockAcceptanceProviders() {
  return {
    research: new MockResearchProvider(),
    writer: new MockWriterProvider(),
    voice: new OneSecondVoiceProvider(),
    image: new MockImageProvider(),
    storage: new MockStorageProvider({
      signingSecret: "full-length-acceptance-test-signing-secret"
    })
  };
}

class OneSecondVoiceProvider implements VoiceProvider {
  readonly name = "one-second-voice";

  async listVoices(_context: ProviderContext): Promise<readonly VoiceOption[]> {
    return [];
  }

  async narrateChapter(input: NarrationInput, _context: ProviderContext): Promise<NarrationAsset> {
    const bytes = createSilentWav(1);
    return {
      id: `asset_${input.storyId}_${input.chapter.id}_audio`,
      kind: "audio",
      mimeType: "audio/wav",
      uri: `mock://voice/${input.storyId}/${input.chapter.id}.wav`,
      sizeBytes: bytes.byteLength,
      durationSeconds: 1,
      bytes
    };
  }
}

class DiagnosticsFailingWriter extends MockWriterProvider {
  override async writeScript(
    dossier: ResearchDossier,
    request: GenerationRequest,
    context: ProviderContext
  ): Promise<StoryScript> {
    const script = await super.writeScript(dossier, request, context);
    const brokenScript: StoryScript = {
      ...script,
      chapters: script.chapters.map((chapter) => ({
        ...chapter,
        text: "short text"
      }))
    };
    const result = validateStoryScript(brokenScript, {
      targetDurationMinutes: request.targetDurationMinutes
    });
    throw new StoryScriptValidationError(
      brokenScript,
      result,
      createStoryScriptDiagnostics(brokenScript, result)
    );
  }
}

function tickingNow(): () => string {
  let tick = 0;
  const start = Date.UTC(2026, 4, 12, 12, 0, 0);
  return () => new Date(start + tick++ * 1_000).toISOString();
}
