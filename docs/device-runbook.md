# Device Networking Runbook

Use this when connecting the iOS app to the local backend from Simulator, a physical iPhone, or a temporary HTTPS tunnel.

## Backend Setup

1. Copy `.env.example` to a local file outside commits, then fill only backend secrets there.
2. Keep `PORT=8787` unless you also update the app base URL.
3. For Simulator-only work, keep `HOST=127.0.0.1` and `PUBLIC_API_BASE_URL=http://localhost:8787`.
4. For physical iPhone work on the same Wi-Fi network, use `HOST=0.0.0.0` and `PUBLIC_API_BASE_URL=http://<mac-lan-ip>:8787`.
5. Start the backend with the same environment loaded, then verify from the Mac:

```bash
npm --prefix server test
curl http://127.0.0.1:8787/health
```

Provider API keys, enrollment admin secrets, token HMAC secrets, storage credentials, and provider enablement flags belong only in the backend or worker environment. The iOS app should contain only `SleepyHistoryAPIBaseURL` plus the Keychain-persisted enrollment token created at runtime.

## App Base URLs

- Simulator: use `http://127.0.0.1:8787`. In the iOS Simulator, loopback reaches the Mac host.
- Physical iPhone: use `http://<mac-lan-ip>:8787`, for example `http://192.168.1.24:8787`. Find the Mac address with `ipconfig getifaddr en0` on Wi-Fi.
- HTTPS tunnel: use the tunnel's `https://...` forwarding URL. Point `SleepyHistoryAPIBaseURL` at that URL and keep the backend listening locally on `127.0.0.1:8787`.
- Hosted Railway backend: use `https://sleepy-history-api-production.up.railway.app`.

The current app reads `SleepyHistoryAPIBaseURL` from `ios/SleepyHistory/Supporting/Info.plist`.

The current checked-in base URL points to the hosted Railway backend. For local-only simulator work, temporarily switch `SleepyHistoryAPIBaseURL` back to `http://127.0.0.1:8787`, then restore the hosted HTTPS URL before release/device acceptance checks.

## Physical iPhone Checklist

1. Put the Mac and iPhone on the same non-guest Wi-Fi network.
2. Start the backend with `HOST=0.0.0.0`.
3. Confirm the iPhone can reach `http://<mac-lan-ip>:8787/health` from Safari before testing the app.
4. If HTTP is blocked or the network is untrusted, use an HTTPS tunnel instead of widening ATS.
5. Enroll the device with a fresh one-time code; do not bundle tokens in source or plist files.

## HTTPS Tunnel Option

Use a tunnel when testing away from the local network, when carrier or guest Wi-Fi blocks LAN traffic, or when validating Release-like HTTPS behavior before hosting.

Practical flow:

1. Run the backend on `127.0.0.1:8787`.
2. Start a tunnel that forwards to `http://127.0.0.1:8787`.
3. Set `SleepyHistoryAPIBaseURL` to the tunnel's HTTPS URL.
4. Verify `/health`, enrollment, job creation, audio/artwork downloads, and signed asset URLs through the tunnel.

Do not put provider keys or enrollment secrets in tunnel configuration. Treat tunnel URLs as temporary and rotate enrollment codes after demos.

## Common Failure Fixes

- `Connection refused`: backend is not running, the port changed, or `HOST=127.0.0.1` is being used from a physical iPhone.
- `Could not connect to the server`: check that the iPhone and Mac are on the same Wi-Fi network and that macOS Firewall allows Node or terminal inbound connections.
- Simulator works but iPhone fails: replace `127.0.0.1` with the Mac LAN IP and restart the backend with `HOST=0.0.0.0`.
- App gets auth errors: re-run enrollment with a fresh code and confirm the backend uses the same `DEVICE_TOKEN_HMAC_SECRET` and enrollment store.
- Provider smoke is skipped: set provider keys and enablement flags in the backend environment only.
- Asset downloads fail through a tunnel: ensure `PUBLIC_API_BASE_URL` and signed asset URLs use the same reachable HTTPS host.

## Debug-Only Network Exceptions

Local HTTP is for Debug development only. Prefer Simulator loopback or an HTTPS tunnel. If a physical-device Debug build needs HTTP to a LAN IP, keep any ATS exception Debug-only and out of Release configuration.

Rules:

- Scope exceptions to the exact local host or development domain.
- Never use `NSAllowsArbitraryLoads`.
- Never ship `NSExceptionAllowsInsecureHTTPLoads` in Release.
- Never add provider key names, static bearer tokens, or enrollment tokens to iOS source, plist, or project files.

## Release HTTPS And ATS Validation

Release builds must use an HTTPS backend URL with a valid certificate. Hosted storage and signed asset URLs must also be HTTPS.

Before release or device acceptance, run:

```bash
node scripts/validate-release.mjs
bash scripts/full-validation.sh
```

`validate-release.mjs` fails if iOS sources contain provider key names, likely bundled static auth tokens, `NSAllowsArbitraryLoads`, or insecure HTTP ATS exceptions. Treat any failure as a release blocker; fix the app configuration or move the value back to backend runtime secrets.
