# Deployment Decision

Created: 2026-05-09

## Decision

Sleepy History should use direct Xcode installation for the MVP, with automatic signing to install the app on the target iPhone 14 Pro Max running iOS 26. TestFlight should wait until the app is stable enough for repeatable external testing. App Store submission is out of scope for the MVP.

The backend strategy should be local development first, then a hosted durable backend for any real provider generation. The iOS app must never contain provider keys. Real research, writing, narration, image, storage, and worker jobs should run through the backend with per-device auth, cost controls, retry limits, and observable job state.

## Deployment Path

Choose direct Xcode install for the first working build.

Why:

- It is the shortest path to seeing the native SwiftUI app on the real target device.
- It avoids App Store Connect, review, metadata, privacy nutrition labels, screenshots, and release management before the product is ready.
- It supports rapid iteration on iOS 26 device behavior, background audio, lock-screen playback, local persistence, and large-screen ergonomics.
- It keeps distribution private while the app is still owner-operated and provider costs are being tuned.

Use TestFlight later when:

- Mock mode and real-provider smoke generation are reliable.
- The backend has durable hosted state, auth, budgets, logs, and failure handling.
- There is a small tester group that needs over-the-air installs.
- Build settings, bundle ID, signing, and minimum supported OS are stable.

Do not use App Store distribution for the MVP.

Why:

- The current goal is a private, practical first install, not public commercialization.
- App review, policy copy, subscriptions, account flows, public support, and release operations would add complexity before the core app is proven.
- Provider-backed generation needs stronger operational confidence before any public audience can create open-ended cost or quality pressure.

## Backend Strategy

Use a local development backend first.

Local backend responsibilities:

- Run the TypeScript API and worker locally during early development.
- Serve fixture/mock jobs so the app can browse, create, and play stories without provider keys.
- Exercise the job lifecycle: create, queued, researching, outlining, writing, voicing, imaging, assembling, complete, failed.
- Validate device auth shape, request/response contracts, error states, and progress polling before paid provider calls are enabled.

Use a hosted durable backend for real provider generation.

Hosted backend responsibilities:

- Keep provider keys off-device.
- Run long-lived generation jobs outside the iOS app process.
- Store job records, generated text, audio, cover art, logs, and retry metadata durably.
- Enforce per-device auth, cost caps, rate limits, and explicit budget approval for long-form stories.
- Provide stable download URLs or authenticated asset delivery for the iOS app.
- Capture enough observability to diagnose provider failures, partial jobs, and unexpectedly high costs.

This split keeps local development fast while reserving real provider work for an environment that can protect secrets, survive app termination, and control spend.

## Hosted MVP Backend

The first hosted backend target is Railway with Cloudflare R2 for generated story assets.

- Railway project: `insightful-freedom`.
- Railway service: `sleepy-history-api`.
- Public base URL: `https://sleepy-history-api-production.up.railway.app`.
- Storage bucket: Cloudflare R2 bucket `sleepy-history-stories`.
- Persistent state: Railway volume mounted at `/data` for enrollment, job, and queue JSON files.
- Deploy config: root `railway.json` plus root `package.json` delegate build/start commands to `server/`.
- Required Railway secrets: provider API keys, ElevenLabs voice ID, storage endpoint/access key/secret, storage signing secret, device token HMAC secret, and enrollment admin secret.
- Required Railway flags: `NODE_ENV=production`, `HOST=0.0.0.0`, `STORAGE_PROVIDER=s3`, `DATA_DIR=/data`, `JOB_STORE_PATH=/data/jobs.json`, `QUEUE_STORE_PATH=/data/queue.json`, `ENROLLMENT_STORE_PATH=/data/enrollment.json`, provider enablement flags set to `true`, and `ENABLE_LOCAL_ENROLLMENT=false`.

Current hosted smoke evidence: `/health` returns HTTP 200 with production mode and worker health, and an R2 storage smoke using Railway environment variables can put, sign, and delete a harmless object without printing secrets.

## Assumptions

- The first target device is an iPhone 14 Pro Max running iOS 26.
- The iOS app is native SwiftUI.
- The backend and worker are small TypeScript services.
- Provider keys must remain off-device.
- MVP distribution is private and owner-operated.
- Mock mode is required before real provider calls.
- The app can use automatic signing for direct Xcode installation.

## Risks

- Direct Xcode install is excellent for one device but does not solve distribution for testers.
- Automatic signing can still require Apple developer account setup, a stable bundle identifier, and trusted device pairing.
- Local backend success does not prove hosted job durability, storage permissions, or provider reliability.
- Real long-form generation can be slow and expensive without strict budget checks and cancellation behavior.
- Background audio and lock-screen playback must be validated on the physical device, not only in Simulator.
- Hosted provider generation introduces operational needs: secrets management, logs, retention, rate limits, and failure recovery.

## Validation Steps

1. Install the SwiftUI app on the iPhone 14 Pro Max from Xcode using automatic signing.
2. Confirm the app launches, navigates, persists local state, and plays fixture audio in mock mode.
3. Run the local TypeScript backend and worker with provider calls disabled.
4. Create a mock story job from the device and verify progress states, completion, download, playback, retry, and failed-job UI.
5. Deploy the hosted backend with real secrets stored server-side only.
6. Run a short real-provider smoke story through research, writing, narration, image generation, storage, download, and playback.
7. Confirm provider budget limits, auth checks, logs, retry behavior, and failure messages before attempting a full 55 to 65 minute acceptance story.
8. Revisit TestFlight only after the hosted smoke path is repeatable and build settings are stable.
