# Security and Budget Controls

Created: 2026-05-09

## Scope

Sleepy History is owner-operated for the MVP, but hosted generation still needs real controls before provider keys are enabled. This document defines the simplest useful security boundary: one enrolled owner device, server-side provider keys, allowlisted generation, hard spend caps, retry ceilings, audit logging, and an emergency provider kill switch.

## Principles

- The iOS app is not trusted with provider secrets.
- Every real generation request must be authenticated before policy checks or provider calls.
- Cost should be estimated before accepting a job and measured during every provider stage.
- The backend should fail closed if auth, provider config, budget config, or runtime model verification is missing.
- Mock mode must remain available without provider keys.

## One-Time Enrollment Codes

Use single-use enrollment codes for the MVP instead of accounts.

Flow:

1. Backend admin or local mode creates a random enrollment code.
2. Code is displayed once in the backend console or admin-only response.
3. User enters the code in the iOS app.
4. Backend exchanges the code for a random device token.
5. iOS stores the token in Keychain.
6. Backend stores only a hash of the token, plus device label, creation time, last-seen time, and revoked status.
7. Enrollment code is immediately consumed and cannot be reused.

Rules:

- Enrollment codes expire after 15 minutes.
- Enrollment codes are single use.
- Device tokens should be at least 256 bits of entropy.
- Store token hashes using a slow hash or HMAC with a backend-only secret.
- Allow a small device limit for MVP, defaulting to one active device.
- Release validation must fail if a static bearer token or provider key is bundled in iOS sources.

## Per-Device Auth

Every non-public API endpoint must require a device token, except health and local-only enrollment creation.

Authenticated endpoints:

- Create story job.
- Get job status.
- Cancel job.
- Retry job.
- Delete job and assets.
- Fetch story metadata.
- Fetch signed or token-protected asset URLs.
- List approved voices and provider status.

Server behavior:

- Reject missing, malformed, unknown, expired, or revoked tokens.
- Bind audit records to device ID and token hash prefix, not raw token.
- Rotate a device token by enrolling a new code and revoking the old token.

## Allowlisting

MVP should allow only configured request shapes:

- Story modes: `historical_figure`, `daily_life`, `place_object_era`.
- Target duration: 5 minutes for smoke tests, 55 to 65 minutes for approved full stories.
- Voice IDs: backend allowlist only.
- Providers: enabled provider registry entries only.
- Models: configured model IDs that pass runtime availability checks where supported.

Reject:

- Arbitrary provider/model IDs from the client.
- Client-supplied provider prompts.
- Client-supplied voice IDs not present in the backend allowlist.
- Story duration above 65 minutes.
- Cover art variants unless explicitly enabled.

## Max Story Duration

Defaults:

- Smoke story: 5 minutes.
- Full story target: 60 minutes.
- Full story hard cap: 65 minutes.
- Script cap before re-approval: 8,500 words.
- TTS cap before re-approval: 52,000 characters.

The backend should enforce duration and character caps before paid writing, TTS, and image stages. If estimates exceed caps, the job should stop before calling a paid provider.

## Daily and Job Cost Caps

Initial caps from `docs/cost-latency-budget.md`:

- Full-story pre-approval cap: $12.00.
- Worst-case retry exposure cap: $21.00.
- Daily owner cap: $40.00 after initial real-provider usage measurement, while keeping the per-job cap at $12.00.
- Smoke job cap: $2.00.
- Cover art cap: one image per story by default.

Cost enforcement:

- Estimate cost before creating a real-provider job.
- Record expected cost and approved cap on the job.
- Before every provider call, compare estimated remaining stage cost with remaining approved budget.
- After every provider call, record provider-reported usage when available.
- Stop the job with `budget_exceeded` before any call that would exceed the approved cap. A 65-minute story is currently estimated around $10.42, so the $40.00 daily owner cap allows several same-day attempts without weakening the $12.00 per-story ceiling.

## Retry Ceilings

Retries should reduce wasted spend, not multiply it.

- Research: one retry for transient failures; no retry for unavailable model or failed runtime model verification.
- Writing: one retry per failed chapter or review rewrite; do not restart accepted chapters.
- TTS: one retry per failed chunk; never regenerate successful chunks unless text, voice, or model changed.
- Image: one retry for transient image failure; no automatic variants.
- Assembly/storage: retry local non-provider work freely within a short time budget.

Global ceilings:

- Max paid provider attempts per job stage: 2.
- Max total paid retries per full story: 1 equivalent full failed attempt.
- Max elapsed time before stalled warning: 120 minutes.

## Audit Logging

Audit logs should be sufficient for debugging and spend review without exposing secrets.

Record:

- Device ID.
- Job ID.
- Action.
- Request timestamp.
- Provider name and model ID.
- Stage.
- Estimated cost.
- Actual usage when available.
- Retry count.
- Failure reason.
- Policy decision IDs.
- Budget decision.
- Kill-switch state.

Never log:

- Provider API keys.
- Raw device tokens.
- Full provider auth headers.
- Full raw provider payloads containing long user text unless explicitly stored as secured job metadata.

## Provider Kill Switch

Each provider must have an enabled flag in backend config.

Flags:

- `ENABLE_GEMINI_RESEARCH`
- `ENABLE_ANTHROPIC_WRITING`
- `ENABLE_ELEVENLABS_TTS`
- `ENABLE_OPENAI_IMAGES`
- `PROVIDER_KILL_SWITCH`

Behavior:

- Global kill switch disables all paid provider calls.
- Provider-specific kill switch disables only that provider.
- Mock mode remains available when kill switches are active.
- Jobs already in progress should finish local assembly work but stop before any disabled provider stage.
- API should return a typed `provider_disabled` error with a safe user-facing message.

## Implementation Checklist

- Add enrollment-code table or file-backed store for MVP.
- Hash device tokens server-side.
- Gate all job endpoints behind device auth.
- Keep provider keys in backend environment only.
- Add provider registry enabled flags and model IDs.
- Add budget estimator before real job creation.
- Add per-stage budget checks before provider calls.
- Add retry counters and idempotency keys where providers support them.
- Add audit log records for auth, budget, provider, policy, and kill-switch decisions.
- Add tests for unknown device, revoked device, over-duration request, over-budget request, disabled provider, and retry ceiling exceeded.
