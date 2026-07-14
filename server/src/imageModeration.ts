import type { CoverArtAsset, CoverArtInput, ImageProvider, ProviderContext } from "./providers.js";

export interface ImageGenerationResult {
  readonly asset: CoverArtAsset;
  readonly metadata: ImageGenerationMetadata;
}

export interface ImageGenerationMetadata {
  readonly status: "generated" | "fallback";
  readonly reviewStatus: "allowed" | "rejected";
  readonly fallbackReason?: string;
  readonly attempts: number;
  readonly retryCount: number;
  readonly providerName: string;
  readonly errors: readonly string[];
}

const rejectedImagePromptPatterns: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /\b(?:logo|watermark|branded?|brand marks?)\b/i, reason: "branded_artifact" },
  { pattern: /\b(?:boring history for sleep|historyandsleepofficial|podcast cover imitation)\b/i, reason: "podcast_imitation" },
  { pattern: /\b(?:gore|bloody|corpse|execution|horror|nightmare)\b/i, reason: "too_intense_for_bedtime" },
  { pattern: /\b(?:weapon|battlefield|combat)\b/i, reason: "violent_visual_focus" }
];

export async function createModeratedCoverArt(
  provider: ImageProvider,
  input: CoverArtInput,
  context: ProviderContext
): Promise<ImageGenerationResult> {
  const rejectionReason = rejectedImagePromptPatterns.find(({ pattern }) => pattern.test(input.prompt))?.reason;
  if (rejectionReason) {
    return {
      asset: createFallbackCoverArtAsset(input, rejectionReason),
      metadata: {
        status: "fallback",
        reviewStatus: "rejected",
        fallbackReason: rejectionReason,
        attempts: 0,
        retryCount: 0,
        providerName: provider.name,
        errors: []
      }
    };
  }

  const errors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const asset = await provider.createCoverArt(input, {
        ...context,
        idempotencyKey: context.idempotencyKey ? `${context.idempotencyKey}:attempt-${attempt}` : undefined
      });

      return {
        asset,
        metadata: {
          status: "generated",
          reviewStatus: "allowed",
          attempts: attempt,
          retryCount: attempt - 1,
          providerName: provider.name,
          errors
        }
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Image provider failed");
    }
  }

  return {
    asset: createFallbackCoverArtAsset(input, "provider_failed_after_retry"),
    metadata: {
      status: "fallback",
      reviewStatus: "allowed",
      fallbackReason: "provider_failed_after_retry",
      attempts: 2,
      retryCount: 1,
      providerName: provider.name,
      errors
    }
  };
}

export function createFallbackCoverArtAsset(input: CoverArtInput, reason: string): CoverArtAsset {
  const bytes = fallbackPngFixture();

  return {
    id: `asset_${input.storyId}_cover_fallback`,
    kind: "cover_full",
    mimeType: "image/png",
    uri: `sleepy-history://fallback-cover/${input.storyId}.png`,
    sizeBytes: bytes.byteLength,
    width: 1,
    height: 1,
    checksum: `fallback:${reason}`,
    bytes
  };
}

function fallbackPngFixture(): Uint8Array {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4cf7AfwAI0QOHKybRAwAAAABJRU5ErkJggg==",
    "base64"
  );
}
