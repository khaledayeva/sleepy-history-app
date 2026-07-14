import { createHmac, timingSafeEqual } from "node:crypto";
import type { DeviceAuthConfig } from "./config.js";

export interface DevicePrincipal {
  readonly deviceId: "owner";
  readonly tokenHashPrefix: string;
}

export type DeviceAuthDecision =
  | {
      readonly ok: true;
      readonly principal: DevicePrincipal;
    }
  | {
      readonly ok: false;
      readonly code: "missing_device_token" | "malformed_device_token" | "device_auth_not_configured" | "unknown_device_token";
      readonly message: string;
    };

type DeviceAuthFailureCode = Exclude<DeviceAuthDecision, { ok: true }>["code"];

export function authenticateDeviceToken(token: string | undefined, config: DeviceAuthConfig): DeviceAuthDecision {
  const normalizedToken = token?.trim();
  if (!normalizedToken) {
    return reject("missing_device_token", "Device token is required.");
  }
  if (normalizedToken.length < 16 || /\s/.test(normalizedToken)) {
    return reject("malformed_device_token", "Device token is malformed.");
  }
  if (!config.deviceTokenHmacSecret || config.allowedDeviceTokenHashes.length === 0) {
    return reject("device_auth_not_configured", "Device authentication is not configured.");
  }

  const hash = hashDeviceToken(normalizedToken, config.deviceTokenHmacSecret);
  const allowed = config.allowedDeviceTokenHashes.some((allowedHash) => timingSafeHexEqual(hash, allowedHash));
  if (!allowed) {
    return reject("unknown_device_token", "Device token is not recognized.");
  }

  return {
    ok: true,
    principal: {
      deviceId: "owner",
      tokenHashPrefix: hash.slice(0, 12)
    }
  };
}

export function hashDeviceToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token, "utf8").digest("hex");
}

function reject(code: DeviceAuthFailureCode, message: string): DeviceAuthDecision {
  return {
    ok: false,
    code,
    message
  };
}

function timingSafeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(right)) {
    return false;
  }

  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
