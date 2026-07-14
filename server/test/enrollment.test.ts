import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { hashDeviceToken } from "../src/auth.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { createGenerationRequest } from "../src/generationRequests.js";
import { createApp, type AppRuntime } from "../src/server.js";

const authSecret = "test-device-token-hmac-secret-32-bytes";
const adminSecret = "local-admin-secret";
const runningServers: ReturnType<typeof createApp>[] = [];
let nextEnrollmentStoreId = 0;

after(async () => {
  await Promise.all(runningServers.map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("one-time device enrollment", () => {
  it("creates a single-use enrollment code and accepts the exchanged device token", async () => {
    const app = await startTestApp(enabledConfig());

    const codeResponse = await fetch(`${app.baseURL}/enrollment-codes`, {
      method: "POST",
      headers: {
        "x-admin-secret": adminSecret
      }
    });
    const codePayload = await codeResponse.json() as EnrollmentCodePayload;

    assert.equal(codeResponse.status, 201);
    assert.match(codePayload.enrollment.code, /^[A-Za-z0-9_-]{16,}$/);

    const enrollmentResponse = await exchangeDeviceCode(app.baseURL, codePayload.enrollment.code);
    const enrollmentPayload = await enrollmentResponse.json() as DeviceEnrollmentPayload;

    assert.equal(enrollmentResponse.status, 201);
    assert.match(enrollmentPayload.device.token, /^[A-Za-z0-9_-]{32,}$/);
    assert.equal(enrollmentPayload.device.deviceLabel, "Khaled's iPhone 14 Pro Max");

    const replayResponse = await exchangeDeviceCode(app.baseURL, codePayload.enrollment.code);
    const replayPayload = await replayResponse.json() as ApiErrorPayload;

    assert.equal(replayResponse.status, 400);
    assert.equal(replayPayload.error.code, "used_enrollment_code");

    const jobResponse = await postGenerationJob(app.baseURL, enrollmentPayload.device.token);
    assert.equal(jobResponse.status, 202);
  });

  it("stores only token hashes in the backend enrollment registry", async () => {
    const recordedHashes: string[][] = [];
    const runtime = createRecordingRuntime(recordedHashes);
    const app = await startTestApp(enabledConfig(), runtime);

    const codeResponse = await fetch(`${app.baseURL}/enrollment-codes`, {
      method: "POST",
      headers: {
        "x-admin-secret": adminSecret
      }
    });
    const codePayload = await codeResponse.json() as EnrollmentCodePayload;
    const enrollmentResponse = await exchangeDeviceCode(app.baseURL, codePayload.enrollment.code);
    const enrollmentPayload = await enrollmentResponse.json() as DeviceEnrollmentPayload;

    assert.equal(enrollmentResponse.status, 201);
    assert.notEqual(recordedHashes.at(-1)?.[0], enrollmentPayload.device.token);
    assert.equal(recordedHashes.at(-1)?.[0], hashDeviceToken(enrollmentPayload.device.token, authSecret));
  });

  it("persists enrolled device hashes across backend runtime restarts", async () => {
    const config = enabledConfig();
    const firstApp = await startTestApp(config);

    const codeResponse = await fetch(`${firstApp.baseURL}/enrollment-codes`, {
      method: "POST",
      headers: {
        "x-admin-secret": adminSecret
      }
    });
    const codePayload = await codeResponse.json() as EnrollmentCodePayload;
    const enrollmentResponse = await exchangeDeviceCode(firstApp.baseURL, codePayload.enrollment.code);
    const enrollmentPayload = await enrollmentResponse.json() as DeviceEnrollmentPayload;

    assert.equal(enrollmentResponse.status, 201);

    const restartedApp = await startTestApp(config);
    const jobResponse = await postGenerationJob(restartedApp.baseURL, enrollmentPayload.device.token);

    assert.equal(jobResponse.status, 202);

    const registryText = await readFile(config.enrollment.storePath, "utf8");
    assert.equal(registryText.includes(enrollmentPayload.device.token), false);
    assert.equal(registryText.includes(codePayload.enrollment.code), false);
    assert.match(registryText, new RegExp(hashDeviceToken(enrollmentPayload.device.token, authSecret)));
  });

  it("rejects enrollment code creation without local or admin access", async () => {
    const app = await startTestApp(enabledConfig({
      ENABLE_LOCAL_ENROLLMENT: "false"
    }));

    const response = await fetch(`${app.baseURL}/enrollment-codes`, {
      method: "POST"
    });
    const payload = await response.json() as ApiErrorPayload;

    assert.equal(response.status, 401);
    assert.equal(payload.error.code, "admin_auth_required");
  });
});

function enabledConfig(overrides: NodeJS.ProcessEnv = {}): ServerConfig {
  return loadConfig({
    NODE_ENV: "test",
    PORT: "8787",
    DEVICE_TOKEN_HMAC_SECRET: authSecret,
    OWNER_DEVICE_TOKEN_HASHES: "",
    ENROLLMENT_ADMIN_SECRET: adminSecret,
    ENABLE_LOCAL_ENROLLMENT: "false",
    ENROLLMENT_STORE_PATH: join(
      tmpdir(),
      `sleepy-history-enrollment-${process.pid}-${nextEnrollmentStoreId += 1}.json`
    ),
    ENABLE_GEMINI_RESEARCH: "true",
    ENABLE_ANTHROPIC_WRITING: "true",
    ENABLE_ELEVENLABS_TTS: "true",
    ENABLE_OPENAI_IMAGES: "true",
    PROVIDER_KILL_SWITCH: "false",
    ...overrides
  });
}

async function startTestApp(
  config: ServerConfig,
  runtime?: AppRuntime
): Promise<{ readonly baseURL: string }> {
  const server = createApp(config, runtime);
  runningServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${address.port}`
  };
}

async function exchangeDeviceCode(baseURL: string, code: string): Promise<Response> {
  return fetch(`${baseURL}/device-enrollments`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      code,
      deviceLabel: "Khaled's iPhone 14 Pro Max"
    })
  });
}

async function postGenerationJob(baseURL: string, token: string): Promise<Response> {
  return fetch(`${baseURL}/generation-jobs`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      request: createGenerationRequest({
        kind: "daily_life",
        subject: "a bookbinder in Safavid Isfahan",
        targetDurationMinutes: 60
      })
    })
  });
}

function createRecordingRuntime(recordedHashes: string[][]): AppRuntime {
  const codes = new Map<string, boolean>();
  const tokenHashes: string[] = [];

  return {
    createEnrollmentCode: () => {
      const code = "recording-enrollment-code";
      codes.set(code, false);
      return {
        code,
        expiresAt: new Date(Date.now() + 600_000).toISOString()
      };
    },
    exchangeEnrollmentCode: (code, deviceLabel) => {
      if (!codes.has(code)) {
        return {
          ok: false,
          code: "invalid_enrollment_code",
          message: "Enrollment code is invalid."
        };
      }
      if (codes.get(code)) {
        return {
          ok: false,
          code: "used_enrollment_code",
          message: "Enrollment code has already been used."
        };
      }

      codes.set(code, true);
      const token = "recording-device-token-000000000000000000";
      const tokenHash = hashDeviceToken(token, authSecret);
      tokenHashes.push(tokenHash);
      recordedHashes.push([...tokenHashes]);

      return {
        ok: true,
        enrollment: {
          deviceId: "owner-recording",
          deviceLabel,
          token,
          tokenHashPrefix: tokenHash.slice(0, 12)
        }
      };
    },
    deviceTokenHashes: () => tokenHashes
  };
}

interface EnrollmentCodePayload {
  readonly enrollment: {
    readonly code: string;
    readonly expiresAt: string;
  };
}

interface DeviceEnrollmentPayload {
  readonly device: {
    readonly deviceId: string;
    readonly deviceLabel: string;
    readonly token: string;
    readonly tokenHashPrefix: string;
  };
}

interface ApiErrorPayload {
  readonly error: {
    readonly code: string;
  };
}
