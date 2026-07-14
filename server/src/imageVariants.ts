import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { Asset } from "./schemas.js";
import type { CoverArtAsset } from "./providers.js";

export type ImageVariantRole = "full" | "thumbnail" | "placeholder";

export interface ImageVariant {
  readonly role: ImageVariantRole;
  readonly asset: CoverArtAsset;
  readonly targetWidth: number;
  readonly targetHeight: number;
}

const variantDimensions: Record<ImageVariantRole, { readonly width: number; readonly height: number }> = {
  full: { width: 1536, height: 1536 },
  thumbnail: { width: 320, height: 320 },
  placeholder: { width: 32, height: 32 }
};

export function createImageVariants(source: CoverArtAsset): readonly ImageVariant[] {
  const decodedSource = decodePng(source.bytes);
  const fullDimensions = {
    width: source.width ?? variantDimensions.full.width,
    height: source.height ?? variantDimensions.full.height
  };
  const thumbnailBytes = encodePng(resizeNearest(decodedSource, variantDimensions.thumbnail));
  const placeholderBytes = encodePng(resizeAveraged(decodedSource, variantDimensions.placeholder));

  return [
    createVariant(source, "full", source.bytes, fullDimensions),
    createVariant(source, "thumbnail", thumbnailBytes, variantDimensions.thumbnail),
    createVariant(source, "placeholder", placeholderBytes, variantDimensions.placeholder)
  ];
}

export function imageVariantStorageKey(storyId: string, role: ImageVariantRole): string {
  switch (role) {
    case "full":
      return `stories/${storyId}/cover.png`;
    case "thumbnail":
      return `stories/${storyId}/cover-thumbnail.png`;
    case "placeholder":
      return `stories/${storyId}/cover-placeholder.png`;
  }
}

function createVariant(
  source: CoverArtAsset,
  role: ImageVariantRole,
  bytes: Uint8Array | undefined,
  dimensions: { readonly width: number; readonly height: number }
): ImageVariant {
  if (!bytes || bytes.byteLength === 0) {
    throw new Error(`Missing cover art bytes for ${role} image variant`);
  }

  const asset: CoverArtAsset = {
    id: variantAssetId(source.id, role),
    kind: variantAssetKind(role),
    mimeType: source.mimeType,
    uri: variantUri(source.uri, role),
    sizeBytes: bytes.byteLength,
    width: dimensions.width,
    height: dimensions.height,
    checksum: checksum(bytes),
    bytes
  };

  return {
    role,
    asset,
    targetWidth: dimensions.width,
    targetHeight: dimensions.height
  };
}

function variantAssetId(sourceId: string, role: ImageVariantRole): string {
  return role === "full" ? `${sourceId}_full` : `${sourceId}_${role}`;
}

function variantAssetKind(role: ImageVariantRole): Asset["kind"] {
  switch (role) {
    case "full":
      return "cover_full";
    case "thumbnail":
      return "cover_thumbnail";
    case "placeholder":
      return "placeholder";
  }
}

function variantUri(sourceUri: string, role: ImageVariantRole): string {
  return `${sourceUri}#${role}`;
}

function checksum(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodePng(bytes: Uint8Array | undefined): DecodedPng {
  if (!bytes || bytes.byteLength === 0) {
    throw new Error("Missing cover art bytes");
  }

  const buffer = Buffer.from(bytes);
  if (!buffer.subarray(0, pngSignature.byteLength).equals(pngSignature)) {
    throw new Error("Cover art variants require PNG source bytes");
  }

  let offset = pngSignature.byteLength;
  let width = 0;
  let height = 0;
  let colorType: number | undefined;
  let bitDepth: number | undefined;
  const compressed: Buffer[] = [];

  while (offset < buffer.byteLength) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) {
        throw new Error("Interlaced PNG cover art is not supported for variants");
      }
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0 || bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error("Cover art variants require 8-bit RGB or RGBA PNG source bytes");
  }

  const channels = colorType === 6 ? 4 : 3;
  const inflated = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  let readOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[readOffset++];
    const row = new Uint8Array(inflated.subarray(readOffset, readOffset + stride));
    readOffset += stride;
    unfilterRow(row, previous, filter, channels);

    for (let x = 0; x < width; x += 1) {
      const sourceOffset = x * channels;
      const targetOffset = (y * width + x) * 4;
      rgba[targetOffset] = row[sourceOffset] ?? 0;
      rgba[targetOffset + 1] = row[sourceOffset + 1] ?? 0;
      rgba[targetOffset + 2] = row[sourceOffset + 2] ?? 0;
      rgba[targetOffset + 3] = channels === 4 ? row[sourceOffset + 3] ?? 255 : 255;
    }

    previous.set(row);
  }

  return { width, height, rgba };
}

function unfilterRow(row: Uint8Array, previous: Uint8Array, filter: number, bytesPerPixel: number): void {
  for (let index = 0; index < row.byteLength; index += 1) {
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] ?? 0 : 0;
    const up = previous[index] ?? 0;
    const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0;

    switch (filter) {
      case 0:
        break;
      case 1:
        row[index] = (row[index] ?? 0) + left;
        break;
      case 2:
        row[index] = (row[index] ?? 0) + up;
        break;
      case 3:
        row[index] = (row[index] ?? 0) + Math.floor((left + up) / 2);
        break;
      case 4:
        row[index] = (row[index] ?? 0) + paethPredictor(left, up, upperLeft);
        break;
      default:
        throw new Error(`Unsupported PNG filter type ${filter}`);
    }
  }
}

function paethPredictor(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);

  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function resizeNearest(source: DecodedPng, target: { readonly width: number; readonly height: number }): DecodedPng {
  const rgba = new Uint8Array(target.width * target.height * 4);

  for (let y = 0; y < target.height; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor((y / target.height) * source.height));
    for (let x = 0; x < target.width; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor((x / target.width) * source.width));
      copyPixel(source.rgba, rgba, (sourceY * source.width + sourceX) * 4, (y * target.width + x) * 4);
    }
  }

  return { ...target, rgba };
}

function resizeAveraged(source: DecodedPng, target: { readonly width: number; readonly height: number }): DecodedPng {
  const rgba = new Uint8Array(target.width * target.height * 4);

  for (let y = 0; y < target.height; y += 1) {
    const startY = Math.floor((y / target.height) * source.height);
    const endY = Math.max(startY + 1, Math.ceil(((y + 1) / target.height) * source.height));
    for (let x = 0; x < target.width; x += 1) {
      const startX = Math.floor((x / target.width) * source.width);
      const endX = Math.max(startX + 1, Math.ceil(((x + 1) / target.width) * source.width));
      const targetOffset = (y * target.width + x) * 4;
      averagePixel(source, rgba, targetOffset, startX, endX, startY, endY);
    }
  }

  return { ...target, rgba };
}

function copyPixel(source: Uint8Array, target: Uint8Array, sourceOffset: number, targetOffset: number): void {
  target[targetOffset] = source[sourceOffset] ?? 0;
  target[targetOffset + 1] = source[sourceOffset + 1] ?? 0;
  target[targetOffset + 2] = source[sourceOffset + 2] ?? 0;
  target[targetOffset + 3] = source[sourceOffset + 3] ?? 255;
}

function averagePixel(
  source: DecodedPng,
  target: Uint8Array,
  targetOffset: number,
  startX: number,
  endX: number,
  startY: number,
  endY: number
): void {
  let red = 0;
  let green = 0;
  let blue = 0;
  let alpha = 0;
  let count = 0;

  for (let y = startY; y < Math.min(source.height, endY); y += 1) {
    for (let x = startX; x < Math.min(source.width, endX); x += 1) {
      const offset = (y * source.width + x) * 4;
      red += source.rgba[offset] ?? 0;
      green += source.rgba[offset + 1] ?? 0;
      blue += source.rgba[offset + 2] ?? 0;
      alpha += source.rgba[offset + 3] ?? 255;
      count += 1;
    }
  }

  target[targetOffset] = Math.round(red / count);
  target[targetOffset + 1] = Math.round(green / count);
  target[targetOffset + 2] = Math.round(blue / count);
  target[targetOffset + 3] = Math.round(alpha / count);
}

function encodePng(image: DecodedPng): Uint8Array {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);

  for (let y = 0; y < image.height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    raw.set(image.rgba.subarray(y * stride, (y + 1) * stride), rowStart + 1);
  }

  return Buffer.concat([
    pngSignature,
    pngChunk("IHDR", createIhdr(image.width, image.height)),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function createIhdr(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
