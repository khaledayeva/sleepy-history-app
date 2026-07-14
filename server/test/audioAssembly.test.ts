import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  assembleWavChapterFiles,
  assembleWavChapters,
  createSilentWav,
  inspectWav,
  inspectWavFile
} from "../src/audioAssembly.js";

describe("audio assembly", () => {
  it("concatenates chapter WAV audio and emits chapter markers", () => {
    const assembled = assembleWavChapters([
      {
        chapterId: "chapter_01",
        title: "First Lamp",
        wavBytes: createSilentWav(1.5)
      },
      {
        chapterId: "chapter_02",
        title: "Second Lamp",
        wavBytes: createSilentWav(2.25)
      }
    ]);
    const inspection = inspectWav(assembled.bytes);

    assert.equal(assembled.mimeType, "audio/wav");
    assert.equal(inspection.format, "wav");
    assert.equal(inspection.mimeType, "audio/wav");
    assert.equal(inspection.sampleRate, 16000);
    assert.equal(inspection.channelCount, 1);
    assert.equal(inspection.bitsPerSample, 16);
    assert.equal(inspection.sizeBytes, assembled.bytes.byteLength);
    assert.equal(assembled.durationSeconds, 3.75);
    assert.equal(inspection.durationSeconds, 3.75);
    assert.deepEqual(assembled.markers, [
      {
        chapterId: "chapter_01",
        title: "First Lamp",
        startSeconds: 0,
        durationSeconds: 1.5
      },
      {
        chapterId: "chapter_02",
        title: "Second Lamp",
        startSeconds: 1.5,
        durationSeconds: 2.25
      }
    ]);
  });

  it("streams chapter WAV files into an assembled output file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sleepy-history-audio-test-"));
    try {
      const firstPath = join(tempDir, "chapter_01.wav");
      const secondPath = join(tempDir, "chapter_02.wav");
      const outputPath = join(tempDir, "assembled.wav");
      await writeFile(firstPath, createSilentWav(1.25, 24000));
      await writeFile(secondPath, createSilentWav(2, 24000));

      const assembled = await assembleWavChapterFiles([
        {
          chapterId: "chapter_01",
          title: "First Lamp",
          filePath: firstPath
        },
        {
          chapterId: "chapter_02",
          title: "Second Lamp",
          filePath: secondPath
        }
      ], outputPath);
      const outputBytes = await readFile(outputPath);
      const inspection = await inspectWavFile(outputPath);

      assert.equal(assembled.mimeType, "audio/wav");
      assert.equal(assembled.filePath, outputPath);
      assert.equal(assembled.sizeBytes, outputBytes.byteLength);
      assert.equal(inspection.sampleRate, 24000);
      assert.equal(inspection.channelCount, 1);
      assert.equal(inspection.bitsPerSample, 16);
      assert.equal(assembled.durationSeconds, 3.25);
      assert.equal(inspection.durationSeconds, 3.25);
      assert.deepEqual(assembled.markers, [
        {
          chapterId: "chapter_01",
          title: "First Lamp",
          startSeconds: 0,
          durationSeconds: 1.25
        },
        {
          chapterId: "chapter_02",
          title: "Second Lamp",
          startSeconds: 1.25,
          durationSeconds: 2
        }
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects mismatched audio formats before assembly", () => {
    assert.throws(
      () => assembleWavChapters([
        {
          chapterId: "chapter_01",
          title: "First",
          wavBytes: createSilentWav(1, 16000)
        },
        {
          chapterId: "chapter_02",
          title: "Second",
          wavBytes: createSilentWav(1, 22050)
        }
      ]),
      /same audio format/
    );
  });

  it("rejects malformed or unsupported media", () => {
    assert.throws(() => inspectWav(new Uint8Array([1, 2, 3])), /too small/);

    const wav = createSilentWav(1);
    wav[0] = "N".charCodeAt(0);
    assert.throws(() => inspectWav(wav), /RIFF\/WAVE/);
  });

  it("rejects incomplete fmt chunks and non-frame-aligned data", () => {
    const incompleteFmt = createSilentWav(1);
    incompleteFmt[16] = 12;
    incompleteFmt[17] = 0;
    incompleteFmt[18] = 0;
    incompleteFmt[19] = 0;
    assert.throws(() => inspectWav(incompleteFmt), /fmt chunk is too small/);

    const truncatedData = createSilentWav(1);
    new DataView(truncatedData.buffer).setUint32(40, 31999, true);
    assert.throws(() => inspectWav(truncatedData), /complete PCM frames/);
  });

  it("rejects empty assembly input and non-positive fixture duration", () => {
    assert.throws(() => assembleWavChapters([]), /At least one/);
    assert.throws(() => createSilentWav(0), /positive/);
    assert.throws(() => createSilentWav(1, 16000, 1, 12), /byte-aligned/);
  });
});
