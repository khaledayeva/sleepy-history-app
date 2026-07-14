import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authenticateDeviceToken } from "./auth.js";
import { fullLengthAcceptanceStoryId } from "./acceptanceStory.js";
import type { BudgetUsage, CostEstimate } from "./budget.js";
import { evaluateGenerationGuardrails } from "./budget.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { reviewGenerationRequest } from "./contentReview.js";
import { FileBackedEnrollmentRuntime } from "./enrollment.js";
import { getHealth } from "./health.js";
import { createHostedRuntime, type WorkerHealth } from "./productionRuntime.js";
import {
  parseGenerationRequest,
  SchemaValidationError,
  type GenerationJob,
  type GenerationRequest,
  type Story
} from "./schemas.js";

const maxJsonBodyBytes = 64 * 1024;

type MaybePromise<T> = T | Promise<T>;

export interface AppRuntime {
  readonly budgetUsage?: () => BudgetUsage;
  readonly recordAcceptedEstimate?: (estimate: CostEstimate) => void;
  readonly createGenerationJob?: (request: GenerationRequest, estimate: CostEstimate) => MaybePromise<GenerationJob>;
  readonly getGenerationJob?: (jobId: string) => MaybePromise<GenerationJob | undefined>;
  readonly cancelGenerationJob?: (jobId: string, reason?: string) => MaybePromise<GenerationJob | undefined>;
  readonly retryGenerationJob?: (jobId: string) => MaybePromise<GenerationJob | undefined>;
  readonly deleteGenerationJob?: (
    jobId: string
  ) => MaybePromise<{ readonly deleted: true; readonly jobId: string; readonly deletedRemoteAssetKeys?: readonly string[] } | undefined>;
  readonly getStory?: (storyId: string) => MaybePromise<Story | undefined>;
  readonly getDemoStory?: (storyId: string) => MaybePromise<Story | undefined>;
  readonly workerHealth?: () => WorkerHealth;
  readonly createEnrollmentCode?: (ttlSeconds: number) => { readonly code: string; readonly expiresAt: string };
  readonly exchangeEnrollmentCode?: (
    code: string,
    deviceLabel: string
  ) => {
    readonly ok: true;
    readonly enrollment: {
      readonly deviceId: string;
      readonly deviceLabel: string;
      readonly token: string;
      readonly tokenHashPrefix: string;
    };
  } | {
    readonly ok: false;
    readonly code: string;
    readonly message: string;
  };
  readonly deviceTokenHashes?: () => readonly string[];
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

function sendApiError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, string | number | boolean | null>
): void {
  sendJson(response, statusCode, {
    error: {
      code,
      message,
      retryable,
      ...(details ? { details } : {})
    }
  });
}

async function handleRequest(
  config: ServerConfig,
  runtime: AppRuntime,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;

  if (request.method === "GET" && path === "/health") {
    sendJson(response, 200, getHealth(config, runtime.workerHealth?.()));
    return;
  }

  const demoStoryMatch = path.match(/^\/demo-stories\/([^/]+)$/);
  if (request.method === "GET" && demoStoryMatch) {
    await handleDemoStoryGet(runtime, response, decodeURIComponent(demoStoryMatch[1]));
    return;
  }

  if (request.method === "POST" && path === "/generation-jobs") {
    await handleGenerationJobCreate(config, runtime, request, response);
    return;
  }

  const generationJobMatch = path.match(/^\/generation-jobs\/([^/]+)$/);
  if (request.method === "GET" && generationJobMatch) {
    await handleGenerationJobStatus(config, runtime, request, response, decodeURIComponent(generationJobMatch[1]));
    return;
  }

  const generationJobCancelMatch = path.match(/^\/generation-jobs\/([^/]+)\/cancel$/);
  if (request.method === "POST" && generationJobCancelMatch) {
    await handleGenerationJobCancel(config, runtime, request, response, decodeURIComponent(generationJobCancelMatch[1]));
    return;
  }

  const generationJobRetryMatch = path.match(/^\/generation-jobs\/([^/]+)\/retry$/);
  if (request.method === "POST" && generationJobRetryMatch) {
    await handleGenerationJobRetry(config, runtime, request, response, decodeURIComponent(generationJobRetryMatch[1]));
    return;
  }

  if (request.method === "DELETE" && generationJobMatch) {
    await handleGenerationJobDelete(config, runtime, request, response, decodeURIComponent(generationJobMatch[1]));
    return;
  }

  const storyMatch = path.match(/^\/stories\/([^/]+)$/);
  if (request.method === "GET" && storyMatch) {
    await handleStoryGet(config, runtime, request, response, decodeURIComponent(storyMatch[1]));
    return;
  }

  if (request.method === "POST" && path === "/enrollment-codes") {
    await handleEnrollmentCodeCreate(config, runtime, request, response);
    return;
  }

  if (request.method === "POST" && path === "/device-enrollments") {
    await handleDeviceEnrollment(config, runtime, request, response);
    return;
  }

  sendApiError(response, 404, "not_found", "Route not found", false);
}

async function handleDemoStoryGet(
  runtime: AppRuntime,
  response: ServerResponse,
  storyId: string
): Promise<void> {
  if (storyId !== fullLengthAcceptanceStoryId) {
    sendApiError(response, 404, "story_not_found", "Story was not found.", false);
    return;
  }

  const story = await runtime.getDemoStory?.(storyId);
  if (!story) {
    sendApiError(response, 404, "story_not_found", "Story was not found.", false);
    return;
  }

  sendJson(response, 200, {
    story
  });
}

async function handleGenerationJobCreate(
  config: ServerConfig,
  runtime: AppRuntime,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (!authenticateOwner(config, runtime, request, response)) {
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON request body.";
    sendApiError(response, 400, "invalid_json", message, false);
    return;
  }

  try {
    const requestPayload = parseGenerationRequest(readGenerationRequestPayload(body));
    const contentReview = reviewGenerationRequest(requestPayload);
    if (contentReview.reviewStatus === "blocked") {
      sendApiError(response, 422, "content_policy_blocked", "Generation request was blocked by the content policy.", false, {
        promptPolicyDecision: contentReview.promptPolicyDecision,
        reasons: contentReview.promptPolicyReasons.join("; ")
      });
      return;
    }

    const guardrailDecision = evaluateGenerationGuardrails({
      request: requestPayload,
      budget: config.budget,
      providers: config.providers,
      providerKillSwitch: config.providerKillSwitch,
      usage: runtime.budgetUsage?.()
    });

    if (!guardrailDecision.ok) {
      sendApiError(
        response,
        guardrailDecision.statusCode,
        guardrailDecision.code,
        guardrailDecision.message,
        false,
        guardrailDecision.details
      );
      return;
    }

    runtime.recordAcceptedEstimate?.(guardrailDecision.estimate);
    const job = await runtime.createGenerationJob?.(requestPayload, guardrailDecision.estimate);

    sendJson(response, 202, {
      job: {
        id: job?.id,
        status: "accepted",
        generationStatus: job?.status,
        progress: job?.progress,
        estimate: guardrailDecision.estimate
      }
    });
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      sendApiError(response, 400, "invalid_generation_request", error.message, false);
      return;
    }

    throw error;
  }
}

async function handleGenerationJobStatus(
  config: ServerConfig,
  runtime: AppRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  jobId: string
): Promise<void> {
  if (!authenticateOwner(config, runtime, request, response)) {
    return;
  }

  const job = await runtime.getGenerationJob?.(jobId);
  if (!job) {
    sendApiError(response, 404, "job_not_found", "Generation job was not found.", false);
    return;
  }

  sendJson(response, 200, {
    job
  });
}

async function handleGenerationJobCancel(
  config: ServerConfig,
  runtime: AppRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  jobId: string
): Promise<void> {
  if (!authenticateOwner(config, runtime, request, response)) {
    return;
  }

  let job: GenerationJob | undefined;
  try {
    job = await runtime.cancelGenerationJob?.(jobId, "Canceled by owner");
    if (!job) {
      sendApiError(response, 404, "job_not_found", "Generation job was not found.", false);
      return;
    }
  } catch (error) {
    if (isJobNotFoundError(error)) {
      sendApiError(response, 404, "job_not_found", "Generation job was not found.", false);
      return;
    }
    if (isJobNotCancelableError(error)) {
      const message = error instanceof Error ? error.message : "Generation job cannot be canceled.";
      sendApiError(response, 409, "job_not_cancelable", message, false);
      return;
    }
    throw error;
  }

  sendJson(response, 200, {
    job
  });
}

async function handleGenerationJobRetry(
  config: ServerConfig,
  runtime: AppRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  jobId: string
): Promise<void> {
  if (!authenticateOwner(config, runtime, request, response)) {
    return;
  }

  try {
    const job = await runtime.retryGenerationJob?.(jobId);
    if (!job) {
      sendApiError(response, 404, "job_not_found", "Generation job was not found.", false);
      return;
    }

    sendJson(response, 200, {
      job
    });
  } catch (error) {
    if (isJobNotFoundError(error)) {
      sendApiError(response, 404, "job_not_found", "Generation job was not found.", false);
      return;
    }

    const message = error instanceof Error ? error.message : "Generation job cannot be retried.";
    sendApiError(response, 409, "job_not_retryable", message, false);
  }
}

async function handleGenerationJobDelete(
  config: ServerConfig,
  runtime: AppRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  jobId: string
): Promise<void> {
  if (!authenticateOwner(config, runtime, request, response)) {
    return;
  }

  const result = await runtime.deleteGenerationJob?.(jobId);
  if (!result) {
    sendApiError(response, 404, "job_not_found", "Generation job was not found.", false);
    return;
  }

  sendJson(response, 200, result);
}

async function handleStoryGet(
  config: ServerConfig,
  runtime: AppRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  storyId: string
): Promise<void> {
  if (!authenticateOwner(config, runtime, request, response)) {
    return;
  }

  const story = await runtime.getStory?.(storyId);
  if (!story) {
    sendApiError(response, 404, "story_not_found", "Story was not found.", false);
    return;
  }

  sendJson(response, 200, {
    story
  });
}

async function handleEnrollmentCodeCreate(
  config: ServerConfig,
  runtime: AppRuntime,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (!config.auth.deviceTokenHmacSecret || !runtime.createEnrollmentCode) {
    sendApiError(response, 503, "enrollment_not_configured", "Device enrollment is not configured.", false);
    return;
  }
  if (!canCreateEnrollmentCode(config, request)) {
    sendApiError(response, 401, "admin_auth_required", "Enrollment code creation requires local or admin access.", false);
    return;
  }

  const enrollmentCode = runtime.createEnrollmentCode(config.enrollment.codeTtlSeconds);
  sendJson(response, 201, {
    enrollment: enrollmentCode
  });
}

async function handleDeviceEnrollment(
  config: ServerConfig,
  runtime: AppRuntime,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (!config.auth.deviceTokenHmacSecret || !runtime.exchangeEnrollmentCode) {
    sendApiError(response, 503, "enrollment_not_configured", "Device enrollment is not configured.", false);
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON request body.";
    sendApiError(response, 400, "invalid_json", message, false);
    return;
  }

  const payload = readDeviceEnrollmentPayload(body);
  if (!payload) {
    sendApiError(response, 400, "invalid_device_enrollment", "Enrollment code and device label are required.", false);
    return;
  }

  const exchangeResult = runtime.exchangeEnrollmentCode(payload.code, payload.deviceLabel);
  if (!exchangeResult.ok) {
    sendApiError(response, 400, exchangeResult.code, exchangeResult.message, false);
    return;
  }

  sendJson(response, 201, {
    device: exchangeResult.enrollment
  });
}

export function createApp(config: ServerConfig = loadConfig(), runtime: AppRuntime = createInMemoryAppRuntime(config)): Server {
  return createServer((request, response) => {
    handleRequest(config, runtime, request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Internal server error";
      sendApiError(response, 500, "internal_error", message, true);
    });
  });
}

export function startServer(config: ServerConfig = loadConfig()): Server {
  const hostedRuntime = config.nodeEnv === "production" ? createHostedRuntime(config) : undefined;
  hostedRuntime?.worker.start();
  const server = createApp(config, hostedRuntime?.runtime ?? createInMemoryAppRuntime(config));
  server.listen(config.port, config.host, () => {
    process.stdout.write(`Sleepy History API listening on ${config.host}:${config.port}\n`);
  });
  return server;
}

export function createInMemoryBudgetRuntime(now: () => Date = () => new Date()): AppRuntime {
  let dailyCostUsd = 0;
  let dayKey = currentDayKey(now());

  function refreshDay(): void {
    const nextDayKey = currentDayKey(now());
    if (nextDayKey !== dayKey) {
      dayKey = nextDayKey;
      dailyCostUsd = 0;
    }
  }

  return {
    budgetUsage: () => {
      refreshDay();
      return {
        dailyCostUsd
      };
    },
    recordAcceptedEstimate: (estimate) => {
      refreshDay();
      dailyCostUsd = Math.round((dailyCostUsd + estimate.totalUsd) * 100) / 100;
    }
  };
}

export function createInMemoryGenerationRuntime(now: () => Date = () => new Date()): AppRuntime {
  const jobs = new Map<string, GenerationJob>();
  const stories = new Map<string, Story>();

  return {
    createGenerationJob: (request) => {
      const createdAt = now().toISOString();
      const id = `job_${randomUUID()}`;
      const job: GenerationJob = {
        id,
        status: "queued",
        request,
        progress: {
          stage: "queued",
          percent: 0,
          message: "Queued"
        },
        createdAt,
        updatedAt: createdAt
      };

      jobs.set(id, job);
      return job;
    },
    getGenerationJob: (jobId) => jobs.get(jobId),
    cancelGenerationJob: (jobId, reason = "Canceled") => {
      const job = jobs.get(jobId);
      if (!job) {
        return undefined;
      }
      if (job.status === "completed") {
        throw new Error(`Completed jobs cannot be canceled: ${jobId}`);
      }

      const updatedAt = now().toISOString();
      const canceledJob: GenerationJob = {
        ...job,
        status: "canceled",
        progress: {
          stage: "canceled",
          percent: 100,
          message: reason
        },
        updatedAt
      };
      jobs.set(jobId, canceledJob);
      return canceledJob;
    },
    retryGenerationJob: (jobId) => {
      const job = jobs.get(jobId);
      if (!job) {
        return undefined;
      }
      if (job.status !== "failed" && job.status !== "canceled") {
        throw new Error(`Only failed or canceled jobs can be retried: ${jobId}`);
      }

      const updatedAt = now().toISOString();
      const retriedJob: GenerationJob = {
        ...job,
        status: "queued",
        progress: {
          stage: "queued",
          percent: 0,
          message: "Queued for retry"
        },
        storyId: undefined,
        error: undefined,
        metadata: undefined,
        updatedAt
      };
      jobs.set(jobId, retriedJob);
      return retriedJob;
    },
    deleteGenerationJob: (jobId) => {
      const job = jobs.get(jobId);
      if (!job) {
        return undefined;
      }

      jobs.delete(jobId);
      if (job.storyId) {
        stories.delete(job.storyId);
      }

      return {
        deleted: true,
        jobId
      };
    },
    getStory: (storyId) => stories.get(storyId)
  };
}

export function createInMemoryAppRuntime(
  config: ServerConfig = loadConfig(),
  now: () => Date = () => new Date()
): AppRuntime {
  const budgetRuntime = createInMemoryBudgetRuntime(now);
  const generationRuntime = createInMemoryGenerationRuntime(now);
  const enrollmentRuntime = config.auth.deviceTokenHmacSecret
    ? new FileBackedEnrollmentRuntime(config.auth.deviceTokenHmacSecret, config.enrollment.storePath, now)
    : undefined;

  return {
    ...budgetRuntime,
    ...generationRuntime,
    createEnrollmentCode: enrollmentRuntime?.createEnrollmentCode.bind(enrollmentRuntime),
    exchangeEnrollmentCode: enrollmentRuntime?.exchangeEnrollmentCode.bind(enrollmentRuntime),
    deviceTokenHashes: enrollmentRuntime?.deviceTokenHashes.bind(enrollmentRuntime)
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

function readDeviceToken(request: IncomingMessage): string | undefined {
  const explicitToken = singleHeaderValue(request.headers["x-device-token"]);
  if (explicitToken) {
    return explicitToken;
  }

  const authorization = singleHeaderValue(request.headers.authorization);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function authenticateOwner(
  config: ServerConfig,
  runtime: AppRuntime,
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const authDecision = authenticateDeviceToken(readDeviceToken(request), {
    ...config.auth,
    allowedDeviceTokenHashes: [
      ...config.auth.allowedDeviceTokenHashes,
      ...(runtime.deviceTokenHashes?.() ?? [])
    ]
  });
  if (authDecision.ok) {
    return true;
  }

  const statusCode = authDecision.code === "device_auth_not_configured" ? 503 : 401;
  sendApiError(response, statusCode, authDecision.code, authDecision.message, false);
  return false;
}

function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxJsonBodyBytes) {
      throw new Error("Request body is too large.");
    }
  }

  if (body.trim().length === 0) {
    throw new Error("Request body is required.");
  }

  return JSON.parse(body) as unknown;
}

function readGenerationRequestPayload(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return body;
  }

  const record = body as Record<string, unknown>;
  return record.request ?? body;
}

function readDeviceEnrollmentPayload(body: unknown): { readonly code: string; readonly deviceLabel: string } | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }

  const record = body as Record<string, unknown>;
  if (typeof record.code !== "string") {
    return undefined;
  }

  return {
    code: record.code,
    deviceLabel: typeof record.deviceLabel === "string" ? record.deviceLabel : "Owner device"
  };
}

function canCreateEnrollmentCode(config: ServerConfig, request: IncomingMessage): boolean {
  const adminSecret = singleHeaderValue(request.headers["x-admin-secret"]);
  if (config.enrollment.adminSecret && adminSecret === config.enrollment.adminSecret) {
    return true;
  }

  return config.enrollment.localEnrollmentEnabled && isLoopbackAddress(request.socket.remoteAddress);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isJobNotFoundError(error: unknown): boolean {
  return error instanceof Error && /(?:Job|Queue item) not found:/.test(error.message);
}

function isJobNotCancelableError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Completed jobs cannot be canceled:");
}

function currentDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
