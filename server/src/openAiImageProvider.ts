import { createHash } from "node:crypto";
import type { CoverArtAsset, CoverArtInput, ImageProvider, ProviderContext } from "./providers.js";

export interface OpenAIImageProviderOptions {
  readonly apiKey?: string;
  readonly modelId?: string;
  readonly endpoint?: string;
  readonly size?: string;
  readonly fetchImpl?: FetchLike;
}

export interface OpenAIImageMetadata {
  readonly provider: "openai";
  readonly modelId: string;
  readonly requestId?: string;
  readonly created?: number;
  readonly revisedPrompt?: string;
  readonly size: string;
}

export interface OpenAICoverArtAsset extends CoverArtAsset {
  readonly providerMetadata: OpenAIImageMetadata;
}

type FetchLike = (url: string, init: {
  readonly method: "POST";
  readonly headers: Record<string, string>;
  readonly body: string;
}) => Promise<FetchResponseLike>;

interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
}

interface OpenAIImageGenerationResponse {
  readonly created?: number;
  readonly data: readonly {
    readonly b64_json?: string;
    readonly revised_prompt?: string;
  }[];
}

export class OpenAIImageProvider implements ImageProvider {
  readonly name = "openai-image";
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly endpoint: string;
  private readonly size: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenAIImageProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for OpenAI image generation");
    }

    this.apiKey = apiKey;
    this.modelId = options.modelId ?? process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/images/generations";
    this.size = options.size ?? "1024x1024";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createCoverArt(input: CoverArtInput, context: ProviderContext): Promise<OpenAICoverArtAsset> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...(context.idempotencyKey ? { "idempotency-key": context.idempotencyKey } : {})
      },
      body: JSON.stringify({
        model: this.modelId,
        prompt: input.prompt,
        n: 1,
        size: this.size
      })
    });
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(`OpenAI image generation failed (${response.status}): ${readErrorMessage(payload)}`);
    }

    const parsed = readImageGenerationResponse(payload);
    const image = parsed.data[0];
    if (!image?.b64_json) {
      throw new Error("OpenAI image generation response did not include b64_json image data");
    }

    const bytes = Buffer.from(image.b64_json, "base64");
    if (bytes.byteLength === 0) {
      throw new Error("OpenAI image generation returned empty image data");
    }

    return {
      id: `asset_${input.storyId}_cover_openai`,
      kind: "cover_full",
      mimeType: "image/png",
      uri: `openai://images/${input.storyId}/cover.png`,
      sizeBytes: bytes.byteLength,
      width: parseSquareSize(this.size),
      height: parseSquareSize(this.size),
      checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      bytes,
      providerMetadata: {
        provider: "openai",
        modelId: this.modelId,
        requestId,
        created: parsed.created,
        revisedPrompt: image.revised_prompt,
        size: this.size
      }
    };
  }
}

export function hasOpenAIImageSmokeConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OPENAI_API_KEY);
}

function readImageGenerationResponse(input: unknown): OpenAIImageGenerationResponse {
  if (!isRecord(input) || !Array.isArray(input.data)) {
    throw new Error("OpenAI image generation response must include a data array");
  }

  return {
    created: typeof input.created === "number" ? input.created : undefined,
    data: input.data.map((item) => {
      if (!isRecord(item)) {
        return {};
      }

      return {
        b64_json: typeof item.b64_json === "string" ? item.b64_json : undefined,
        revised_prompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined
      };
    })
  };
}

function readErrorMessage(input: unknown): string {
  if (isRecord(input) && isRecord(input.error) && typeof input.error.message === "string") {
    return input.error.message;
  }

  return "unknown error";
}

function parseSquareSize(size: string): number | undefined {
  const [width, height, extra] = size.split("x");
  if (extra !== undefined || !width || width !== height || !/^\d+$/.test(width)) {
    return undefined;
  }

  return Number(width);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
