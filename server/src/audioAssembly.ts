import { open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export interface ChapterAudioInput {
  readonly chapterId: string;
  readonly title: string;
  readonly wavBytes: Uint8Array;
}

export interface ChapterAudioFileInput {
  readonly chapterId: string;
  readonly title: string;
  readonly filePath: string;
}

export interface ChapterMarker {
  readonly chapterId: string;
  readonly title: string;
  readonly startSeconds: number;
  readonly durationSeconds: number;
}

export interface AssembledAudio {
  readonly mimeType: "audio/wav";
  readonly bytes: Uint8Array;
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly bitsPerSample: number;
  readonly markers: readonly ChapterMarker[];
}

export interface AssembledAudioFile extends Omit<AssembledAudio, "bytes"> {
  readonly filePath: string;
  readonly sizeBytes: number;
}

export interface WavInspection {
  readonly format: "wav";
  readonly mimeType: "audio/wav";
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly bitsPerSample: number;
  readonly sizeBytes: number;
  readonly dataOffset: number;
  readonly dataBytes: number;
}

export function assembleWavChapters(chapters: readonly ChapterAudioInput[]): AssembledAudio {
  if (chapters.length === 0) {
    throw new Error("At least one chapter audio file is required");
  }

  const inspected = chapters.map((chapter) => ({
    chapter,
    inspection: inspectWav(chapter.wavBytes)
  }));
  const first = inspected[0]?.inspection;
  if (!first) {
    throw new Error("Missing first audio chapter");
  }

  for (const item of inspected) {
    if (
      item.inspection.sampleRate !== first.sampleRate ||
      item.inspection.channelCount !== first.channelCount ||
      item.inspection.bitsPerSample !== first.bitsPerSample
    ) {
      throw new Error("All chapter WAV files must use the same audio format");
    }
  }

  const dataParts = inspected.map((item) => item.chapter.wavBytes.slice(
    item.inspection.dataOffset,
    item.inspection.dataOffset + item.inspection.dataBytes
  ));
  const dataByteLength = dataParts.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  const bytes = writeWav(dataParts, first.sampleRate, first.channelCount, first.bitsPerSample, dataByteLength);
  let markerStartSeconds = 0;
  const markers = inspected.map(({ chapter, inspection }) => {
    const marker = {
      chapterId: chapter.chapterId,
      title: chapter.title,
      startSeconds: roundSeconds(markerStartSeconds),
      durationSeconds: roundSeconds(inspection.durationSeconds)
    };
    markerStartSeconds += inspection.durationSeconds;
    return marker;
  });

  return {
    mimeType: "audio/wav",
    bytes,
    durationSeconds: roundSeconds(markerStartSeconds),
    sampleRate: first.sampleRate,
    channelCount: first.channelCount,
    bitsPerSample: first.bitsPerSample,
    markers
  };
}

export async function assembleWavChapterFiles(
  chapters: readonly ChapterAudioFileInput[],
  outputPath: string
): Promise<AssembledAudioFile> {
  if (chapters.length === 0) {
    throw new Error("At least one chapter audio file is required");
  }

  const inspected = [];
  for (const chapter of chapters) {
    inspected.push({
      chapter,
      inspection: await inspectWavFile(chapter.filePath)
    });
  }

  const first = inspected[0]?.inspection;
  if (!first) {
    throw new Error("Missing first audio chapter");
  }

  for (const item of inspected) {
    if (
      item.inspection.sampleRate !== first.sampleRate ||
      item.inspection.channelCount !== first.channelCount ||
      item.inspection.bitsPerSample !== first.bitsPerSample
    ) {
      throw new Error("All chapter WAV files must use the same audio format");
    }
  }

  const dataByteLength = inspected.reduce((sum, item) => sum + item.inspection.dataBytes, 0);
  const output = await open(outputPath, "w");
  try {
    await output.write(wavHeader(first.sampleRate, first.channelCount, first.bitsPerSample, dataByteLength));
    for (const item of inspected) {
      await copyWavDataRange(item.chapter.filePath, output, item.inspection.dataOffset, item.inspection.dataBytes);
    }
  } finally {
    await output.close();
  }

  let markerStartSeconds = 0;
  const markers = inspected.map(({ chapter, inspection }) => {
    const marker = {
      chapterId: chapter.chapterId,
      title: chapter.title,
      startSeconds: roundSeconds(markerStartSeconds),
      durationSeconds: roundSeconds(inspection.durationSeconds)
    };
    markerStartSeconds += inspection.durationSeconds;
    return marker;
  });

  return {
    mimeType: "audio/wav",
    filePath: outputPath,
    sizeBytes: 44 + dataByteLength,
    durationSeconds: roundSeconds(markerStartSeconds),
    sampleRate: first.sampleRate,
    channelCount: first.channelCount,
    bitsPerSample: first.bitsPerSample,
    markers
  };
}

export function inspectWav(bytes: Uint8Array): WavInspection {
  if (bytes.byteLength < 44) {
    throw new Error("WAV file is too small");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") {
    throw new Error("Audio format must be RIFF/WAVE");
  }
  const riffSize = view.getUint32(4, true);
  if (riffSize > bytes.byteLength - 8) {
    throw new Error("WAV RIFF size extends past file size");
  }

  let offset = 12;
  let sampleRate = 0;
  let channelCount = 0;
  let bitsPerSample = 0;
  let blockAlign = 0;
  let dataOffset = 0;
  let dataBytes = 0;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    if (chunkDataOffset + chunkSize > bytes.byteLength) {
      throw new Error("WAV chunk extends past file size");
    }

    if (chunkId === "fmt ") {
      if (chunkSize < 16) {
        throw new Error("WAV fmt chunk is too small");
      }
      const audioFormat = view.getUint16(chunkDataOffset, true);
      channelCount = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      blockAlign = view.getUint16(chunkDataOffset + 12, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
      if (audioFormat !== 1) {
        throw new Error("Only PCM WAV audio is supported");
      }
      if (!channelCount || !sampleRate || !blockAlign || !bitsPerSample || bitsPerSample % 8 !== 0) {
        throw new Error("WAV fmt chunk has invalid PCM values");
      }
      if (blockAlign !== channelCount * bitsPerSample / 8) {
        throw new Error("WAV block alignment does not match channel count and bit depth");
      }
    }
    if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataBytes = chunkSize;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!sampleRate || !channelCount || !bitsPerSample || !blockAlign || !dataOffset) {
    throw new Error("WAV file is missing fmt or data chunk");
  }
  if (dataBytes <= 0) {
    throw new Error("WAV data chunk is empty");
  }
  if (dataBytes % blockAlign !== 0) {
    throw new Error("WAV data chunk does not align to complete PCM frames");
  }

  return {
    format: "wav",
    mimeType: "audio/wav",
    durationSeconds: dataBytes / blockAlign / sampleRate,
    sampleRate,
    channelCount,
    bitsPerSample,
    sizeBytes: bytes.byteLength,
    dataOffset,
    dataBytes
  };
}

export async function inspectWavFile(filePath: string): Promise<WavInspection> {
  const bytes = await readFile(filePath);
  return inspectWav(new Uint8Array(bytes));
}

export function createSilentWav(durationSeconds: number, sampleRate = 16000, channelCount = 1, bitsPerSample = 16): Uint8Array {
  if (durationSeconds <= 0) {
    throw new Error("durationSeconds must be positive");
  }
  validatePcmFormat(sampleRate, channelCount, bitsPerSample);

  const blockAlign = channelCount * bitsPerSample / 8;
  const frameCount = Math.round(durationSeconds * sampleRate);
  const dataByteLength = frameCount * blockAlign;
  return writeWav([new Uint8Array(dataByteLength)], sampleRate, channelCount, bitsPerSample, dataByteLength);
}

function writeWav(
  dataParts: readonly Uint8Array[],
  sampleRate: number,
  channelCount: number,
  bitsPerSample: number,
  dataByteLength: number
): Uint8Array {
  const headerBytes = 44;
  const bytes = new Uint8Array(headerBytes + dataByteLength);
  bytes.set(wavHeader(sampleRate, channelCount, bitsPerSample, dataByteLength));

  let offset = headerBytes;
  for (const part of dataParts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }

  return bytes;
}

function wavHeader(
  sampleRate: number,
  channelCount: number,
  bitsPerSample: number,
  dataByteLength: number
): Uint8Array {
  validatePcmFormat(sampleRate, channelCount, bitsPerSample);
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  const blockAlign = channelCount * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;

  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.byteLength + dataByteLength - 8, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataByteLength, true);

  return bytes;
}

async function copyWavDataRange(
  sourcePath: string,
  output: FileHandle,
  startOffset: number,
  byteLength: number
): Promise<void> {
  const source = await open(sourcePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = startOffset;
    let remaining = byteLength;
    while (remaining > 0) {
      const bytesToRead = Math.min(buffer.byteLength, remaining);
      const { bytesRead } = await source.read(buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) {
        throw new Error("Unexpected end of WAV data while assembling chapters");
      }
      await output.write(buffer.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
    }
  } finally {
    await source.close();
  }
}

function validatePcmFormat(sampleRate: number, channelCount: number, bitsPerSample: number): void {
  if (
    !Number.isInteger(sampleRate) ||
    !Number.isInteger(channelCount) ||
    !Number.isInteger(bitsPerSample) ||
    sampleRate <= 0 ||
    channelCount <= 0 ||
    bitsPerSample <= 0 ||
    bitsPerSample % 8 !== 0
  ) {
    throw new Error("PCM format values must be positive integers with byte-aligned bit depth");
  }
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
