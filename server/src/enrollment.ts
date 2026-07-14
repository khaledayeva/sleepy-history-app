import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashDeviceToken } from "./auth.js";

export interface EnrollmentCode {
  readonly code: string;
  readonly expiresAt: string;
}

export interface DeviceEnrollment {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly token: string;
  readonly tokenHashPrefix: string;
}

export type EnrollmentExchangeResult =
  | {
      readonly ok: true;
      readonly enrollment: DeviceEnrollment;
    }
  | {
      readonly ok: false;
      readonly code: "invalid_enrollment_code" | "expired_enrollment_code" | "used_enrollment_code";
      readonly message: string;
    };

interface StoredEnrollmentCode {
  readonly codeHash: string;
  readonly expiresAtMs: number;
  usedAtMs?: number;
}

interface StoredDevice {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly tokenHash: string;
  readonly createdAt: string;
}

interface EnrollmentRegistry {
  readonly schemaVersion: 1;
  readonly codes: StoredEnrollmentCode[];
  readonly devices: StoredDevice[];
}

export class FileBackedEnrollmentRuntime {
  private registry: EnrollmentRegistry;

  constructor(
    private readonly hmacSecret: string,
    private readonly storePath: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.registry = readRegistry(storePath);
  }

  createEnrollmentCode(ttlSeconds: number): EnrollmentCode {
    const code = randomToken(16);
    const expiresAtMs = this.now().getTime() + ttlSeconds * 1_000;
    const codeHash = hashDeviceToken(code, this.hmacSecret);

    this.registry = {
      ...this.registry,
      codes: [
        ...this.activeCodes(),
        {
          codeHash,
          expiresAtMs
        }
      ]
    };
    writeRegistry(this.storePath, this.registry);

    return {
      code,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  exchangeEnrollmentCode(code: string, deviceLabel: string): EnrollmentExchangeResult {
    const normalizedCode = code.trim();
    if (!normalizedCode) {
      return reject("invalid_enrollment_code", "Enrollment code is invalid.");
    }

    const codeHash = hashDeviceToken(normalizedCode, this.hmacSecret);
    const codeIndex = this.registry.codes.findIndex((candidate) => candidate.codeHash === codeHash);
    const storedCode = this.registry.codes[codeIndex];
    if (!storedCode) {
      return reject("invalid_enrollment_code", "Enrollment code is invalid.");
    }
    if (storedCode.usedAtMs !== undefined) {
      return reject("used_enrollment_code", "Enrollment code has already been used.");
    }
    if (storedCode.expiresAtMs < this.now().getTime()) {
      return reject("expired_enrollment_code", "Enrollment code has expired.");
    }

    const token = randomToken(32);
    const tokenHash = hashDeviceToken(token, this.hmacSecret);
    const deviceId = `owner-${tokenHash.slice(0, 12)}`;
    const safeLabel = normalizeDeviceLabel(deviceLabel);
    const usedAtMs = this.now().getTime();
    const createdAt = this.now().toISOString();

    const updatedCode: StoredEnrollmentCode = {
      ...storedCode,
      usedAtMs
    };
    const storedDevice: StoredDevice = {
      deviceId,
      deviceLabel: safeLabel,
      tokenHash,
      createdAt
    };

    this.registry = {
      ...this.registry,
      codes: this.registry.codes.map((candidate, index) => index === codeIndex ? updatedCode : candidate),
      devices: [
        ...this.registry.devices.filter((candidate) => candidate.tokenHash !== tokenHash),
        storedDevice
      ]
    };
    writeRegistry(this.storePath, this.registry);

    return {
      ok: true,
      enrollment: {
        deviceId,
        deviceLabel: safeLabel,
        token,
        tokenHashPrefix: tokenHash.slice(0, 12)
      }
    };
  }

  deviceTokenHashes(): readonly string[] {
    return this.registry.devices.map((device) => device.tokenHash);
  }

  private activeCodes(): StoredEnrollmentCode[] {
    const nowMs = this.now().getTime();
    return this.registry.codes.filter((code) => code.usedAtMs !== undefined || code.expiresAtMs >= nowMs);
  }
}

function reject(
  code: Exclude<EnrollmentExchangeResult, { ok: true }>["code"],
  message: string
): EnrollmentExchangeResult {
  return {
    ok: false,
    code,
    message
  };
}

function randomToken(byteCount: number): string {
  return randomBytes(byteCount).toString("base64url");
}

function normalizeDeviceLabel(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "Owner device";
  }

  return normalized.slice(0, 80);
}

function readRegistry(storePath: string): EnrollmentRegistry {
  if (!existsSync(storePath)) {
    return emptyRegistry();
  }

  const parsed = JSON.parse(readFileSync(storePath, "utf8")) as unknown;
  if (!isEnrollmentRegistry(parsed)) {
    throw new Error(`Invalid enrollment registry at ${storePath}`);
  }

  return parsed;
}

function writeRegistry(storePath: string, registry: EnrollmentRegistry): void {
  mkdirSync(dirname(storePath), {
    recursive: true
  });

  const temporaryPath = `${storePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, {
    mode: 0o600
  });
  renameSync(temporaryPath, storePath);
}

function emptyRegistry(): EnrollmentRegistry {
  return {
    schemaVersion: 1,
    codes: [],
    devices: []
  };
}

function isEnrollmentRegistry(value: unknown): value is EnrollmentRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && Array.isArray(record.codes)
    && record.codes.every(isStoredEnrollmentCode)
    && Array.isArray(record.devices)
    && record.devices.every(isStoredDevice);
}

function isStoredEnrollmentCode(value: unknown): value is StoredEnrollmentCode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.codeHash === "string"
    && typeof record.expiresAtMs === "number"
    && (record.usedAtMs === undefined || typeof record.usedAtMs === "number");
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.deviceId === "string"
    && typeof record.deviceLabel === "string"
    && typeof record.tokenHash === "string"
    && typeof record.createdAt === "string";
}
