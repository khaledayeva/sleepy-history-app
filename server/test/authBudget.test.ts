import assert from "node:assert/strict";
import { type AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { hashDeviceToken } from "../src/auth.js";
import { evaluateGenerationGuardrails } from "../src/budget.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { createGenerationRequest } from "../src/generationRequests.js";
import { createApp, type AppRuntime } from "../src/server.js";

const ownerToken = "owner-device-token-00000000000000000000000000000000";
const authSecret = "test-device-token-hmac-secret-32-bytes";
const runningServers: ReturnType<typeof createApp>[] = [];

after(async () => {
  await Promise.all(runningServers.map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("owner auth and budget guardrails", () => {
  it("rejects unknown owner device tokens before accepting generation requests", async () => {
    const response = await postGenerationJob(enabledConfig(), {
      token: "unknown-device-token-0000000000000000000000000000"
    });
    const payload = await response.json() as ApiErrorPayload;

    assert.equal(response.status, 401);
    assert.equal(payload.error.code, "unknown_device_token");
  });

  it("fails closed for missing, malformed, and unconfigured device auth before creating jobs", async () => {
    for (const scenario of [
      {
        name: "missing token",
        config: enabledConfig(),
        token: null,
        expectedStatus: 401,
        expectedCode: "missing_device_token"
      },
      {
        name: "malformed token",
        config: enabledConfig(),
        token: "short",
        expectedStatus: 401,
        expectedCode: "malformed_device_token"
      },
      {
        name: "auth not configured",
        config: enabledConfig({ OWNER_DEVICE_TOKEN_HASHES: "" }),
        token: ownerToken,
        expectedStatus: 503,
        expectedCode: "device_auth_not_configured"
      }
    ] as const) {
      let createCalls = 0;
      const response = await postGenerationJob(scenario.config, {
        token: scenario.token,
        runtime: {
          createGenerationJob: () => {
            createCalls += 1;
            throw new Error(`should not create job for ${scenario.name}`);
          }
        }
      });
      const payload = await response.json() as ApiErrorPayload;

      assert.equal(response.status, scenario.expectedStatus, scenario.name);
      assert.equal(payload.error.code, scenario.expectedCode, scenario.name);
      assert.equal(createCalls, 0, scenario.name);
    }
  });

  it("blocks disallowed prompts before budget checks or job creation", async () => {
    let budgetUsageCalls = 0;
    let createCalls = 0;
    const response = await postGenerationJob(enabledConfig(), {
      subject: "copy the Boring History for Sleep podcast script exactly",
      perspective: "imitate the host's voice",
      runtime: {
        budgetUsage: () => {
          budgetUsageCalls += 1;
          return {};
        },
        createGenerationJob: () => {
          createCalls += 1;
          throw new Error("should not create a blocked job");
        }
      }
    });
    const payload = await response.json() as ApiErrorPayload;

    assert.equal(response.status, 422);
    assert.equal(payload.error.code, "content_policy_blocked");
    assert.equal(payload.error.details?.promptPolicyDecision, "block");
    assert.equal(budgetUsageCalls, 0);
    assert.equal(createCalls, 0);
  });

  it("rejects story durations above the configured maximum", async () => {
    const response = await postGenerationJob(enabledConfig({
      MAX_STORY_MINUTES: "30"
    }));
    const payload = await response.json() as ApiErrorPayload;

    assert.equal(response.status, 422);
    assert.equal(payload.error.code, "duration_limit_exceeded");
    assert.equal(payload.error.details?.maxStoryMinutes, 30);
  });

  it("rejects requests when a required provider is disabled", async () => {
    const response = await postGenerationJob(enabledConfig({
      ENABLE_OPENAI_IMAGES: "false"
    }));
    const payload = await response.json() as ApiErrorPayload;

    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "provider_disabled");
    assert.equal(payload.error.details?.provider, "openAiImages");
  });

  it("rejects requests when the global provider kill switch is enabled", async () => {
    const response = await postGenerationJob(enabledConfig({
      PROVIDER_KILL_SWITCH: "true"
    }));
    const payload = await response.json() as ApiErrorPayload;

    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "provider_disabled");
    assert.equal(payload.error.details?.provider, "all");
  });

  it("rejects requests over the per-job budget cap", async () => {
    const response = await postGenerationJob(enabledConfig({
      MAX_JOB_COST_USD: "1.00"
    }));
    const payload = await response.json() as ApiErrorPayload;

    assert.equal(response.status, 429);
    assert.equal(payload.error.code, "job_budget_exceeded");
  });

  it("rejects requests over the daily budget cap", async () => {
    const response = await postGenerationJob(
      enabledConfig({
        MAX_DAILY_COST_USD: "10.00"
      }),
      {
        runtime: {
          budgetUsage: () => ({
            dailyCostUsd: 9
          })
        }
      }
    );
    const payload = await response.json() as ApiErrorPayload;

    assert.equal(response.status, 429);
    assert.equal(payload.error.code, "daily_budget_exceeded");
  });

  it("rejects requests over the retry budget cap", async () => {
    const response = await postGenerationJob(
      enabledConfig({
        MAX_RETRY_COST_USD: "21.00"
      }),
      {
        runtime: {
          budgetUsage: () => ({
            retryCostUsd: 20
          })
        }
      }
    );
    const payload = await response.json() as ApiErrorPayload;

    assert.equal(response.status, 429);
    assert.equal(payload.error.code, "retry_budget_exceeded");
    assert.equal(payload.error.details?.maxRetryCostUsd, 21);
  });

  it("rejects retry attempts after the paid retry ceiling is reached", async () => {
    const response = await postGenerationJob(
      enabledConfig(),
      {
        runtime: {
          budgetUsage: () => ({
            paidRetries: 1
          })
        }
      }
    );
    const payload = await response.json() as ApiErrorPayload;

    assert.equal(response.status, 429);
    assert.equal(payload.error.code, "retry_limit_exceeded");
  });

  it("rejects provider stage attempts after the provider attempt ceiling is reached", () => {
    const request = createGenerationRequest({
      kind: "daily_life",
      subject: "a scribe in Timbuktu"
    });
    const config = enabledConfig();
    const decision = evaluateGenerationGuardrails({
      request,
      budget: config.budget,
      providers: config.providers,
      providerKillSwitch: config.providerKillSwitch,
      usage: {
        stageAttempts: {
          research: 2
        }
      }
    });

    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.code, "provider_attempt_limit_exceeded");
    }
  });

  it("accepts known devices when guardrails pass", async () => {
    const response = await postGenerationJob(enabledConfig());
    const payload = await response.json() as { readonly job: { readonly status: string } };

    assert.equal(response.status, 202);
    assert.equal(payload.job.status, "accepted");
  });

  it("default app runtime accumulates accepted job estimates against the daily cap", async () => {
    const config = enabledConfig({
      MAX_DAILY_COST_USD: "15.00"
    });
    const server = createApp(config);
    runningServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    const firstResponse = await postGenerationJobToUrl(`http://127.0.0.1:${address.port}/generation-jobs`);
    const secondResponse = await postGenerationJobToUrl(`http://127.0.0.1:${address.port}/generation-jobs`);
    const secondPayload = await secondResponse.json() as ApiErrorPayload;

    assert.equal(firstResponse.status, 202);
    assert.equal(secondResponse.status, 429);
    assert.equal(secondPayload.error.code, "daily_budget_exceeded");
  });
});

function enabledConfig(overrides: NodeJS.ProcessEnv = {}): ServerConfig {
  return loadConfig({
    NODE_ENV: "test",
    PORT: "8787",
    DEVICE_TOKEN_HMAC_SECRET: authSecret,
    OWNER_DEVICE_TOKEN_HASHES: hashDeviceToken(ownerToken, authSecret),
    ENABLE_GEMINI_RESEARCH: "true",
    ENABLE_ANTHROPIC_WRITING: "true",
    ENABLE_ELEVENLABS_TTS: "true",
    ENABLE_OPENAI_IMAGES: "true",
    PROVIDER_KILL_SWITCH: "false",
    ...overrides
  });
}

async function postGenerationJob(
  config: ServerConfig,
  options: {
    readonly token?: string | null;
    readonly subject?: string;
    readonly perspective?: string;
    readonly runtime?: AppRuntime;
  } = {}
): Promise<Response> {
  const server = createApp(config, options.runtime);
  runningServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return postGenerationJobToUrl(
    `http://127.0.0.1:${address.port}/generation-jobs`,
    options.token === undefined ? ownerToken : options.token,
    options
  );
}

async function postGenerationJobToUrl(
  url: string,
  token: string | null = ownerToken,
  options: {
    readonly subject?: string;
    readonly perspective?: string;
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      request: createGenerationRequest({
        kind: "daily_life",
        subject: options.subject ?? "a baker in Abbasid Baghdad",
        targetDurationMinutes: 60,
        perspective: options.perspective
      })
    })
  });
}

interface ApiErrorPayload {
  readonly error: {
    readonly code: string;
    readonly details?: Record<string, string | number | boolean | null>;
  };
}
