# Sleepy History Operator Runbook

Created: 2026-05-24

Task: 8.8

## Current Operating Shape

- iOS app: native SwiftUI, bundle ID `com.khaledayeva.SleepyHistory`, installed directly to the target iPhone through Xcode automatic signing.
- Backend: Railway service `sleepy-history-api` in project `insightful-freedom`.
- Public backend URL: `https://sleepy-history-api-production.up.railway.app`.
- Storage: Cloudflare R2 bucket `sleepy-history-stories`.
- Durable backend state: Railway volume mounted at `/data`.
- Full-length acceptance story: `story_full_length_acceptance`, title `The Library at Alexandria`, audio key `stories/story_full_length_acceptance/audio.wav`.

## Daily Health Checks

Backend health:

```bash
curl -fsS https://sleepy-history-api-production.up.railway.app/health
```

Expected result:

- `ok` is `true`.
- `mode` is `production`.
- `providerKillSwitch` is `false` unless intentionally paused.
- `worker.ok` is `true`.

Hosted demo story:

```bash
curl -fsS https://sleepy-history-api-production.up.railway.app/demo-stories/story_full_length_acceptance
```

Expected result:

- Story title is `The Library at Alexandria`.
- Audio asset mime type is `audio/wav`.
- Duration is about 3,548 seconds.
- Asset URLs are signed, temporary URLs. Do not paste full signed URLs into public notes.

## Provider Key Rotation

Rotate provider keys in Railway variables, not in the iOS app or repository.

1. Create the new provider key in the provider dashboard.
2. In Railway, open the `sleepy-history-api` service.
3. Go to Variables.
4. Replace only the target secret:
   - `GEMINI_API_KEY`
   - `ANTHROPIC_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `OPENAI_API_KEY`
   - `STORAGE_ACCESS_KEY_ID`
   - `STORAGE_SECRET_ACCESS_KEY`
   - `STORAGE_SIGNING_SECRET`
   - `DEVICE_TOKEN_HMAC_SECRET`
   - `ENROLLMENT_ADMIN_SECRET`
5. Let Railway redeploy or manually redeploy the service.
6. Run `/health`.
7. Run a cheap mock or short smoke before any paid full-length run.
8. Revoke the old key only after the new key is verified.

Special care:

- Rotating `DEVICE_TOKEN_HMAC_SECRET` invalidates existing device token hashes unless a migration is implemented.
- Rotating R2 storage keys should not change existing object keys, but it can break signing until Railway has the new values.
- Never put provider keys in iOS source, Info.plist, screenshots, App Review notes, or chat messages.

## Model Swaps

Models are environment-configurable so the provider adapters can stay stable.

Current defaults:

- Research: `GEMINI_RESEARCH_MODEL=gemini-3.1-pro-preview`
- Writing: `ANTHROPIC_WRITER_MODEL=claude-opus-4-6`
- Narration: `ELEVENLABS_TTS_MODEL=eleven_multilingual_v2`
- Cover art: `OPENAI_IMAGE_MODEL=gpt-image-2`
- Audio output: `ELEVENLABS_OUTPUT_FORMAT=pcm_24000`

For higher raw PCM quality, `ELEVENLABS_OUTPUT_FORMAT=pcm_44100` can be tested on an ElevenLabs Pro-or-higher account. Keep `pcm_24000` as the default compatibility setting because 44.1 kHz PCM/WAV is plan-gated by ElevenLabs.

Swap process:

1. Update the model variable in Railway.
2. Keep the old value in a private note for rollback.
3. Run backend tests locally when the code changes:

```bash
npm --prefix server test
npm --prefix server run lint
```

4. Run the real-provider smoke before full-length acceptance:

```bash
npm --prefix server run smoke:real-providers
```

5. For any full-length paid run, get an explicit budget cap first.

Rollback:

1. Restore the previous model variable.
2. Redeploy Railway.
3. Re-run `/health`.
4. Retry only failed jobs that are safe and within budget.

## Cost Checks

Primary budget variables:

- `MAX_JOB_COST_USD`
- `MAX_DAILY_COST_USD`
- `MAX_RETRY_COST_USD`
- `MAX_PAID_RETRIES_PER_JOB`
- `MAX_PAID_PROVIDER_ATTEMPTS_PER_STAGE`
- `FULL_LENGTH_ACCEPTANCE_BUDGET_CAP_USD`
- `PROVIDER_KILL_SWITCH`

Before a paid run:

1. Confirm `PROVIDER_KILL_SWITCH=false`.
2. Confirm daily and per-job caps match the approved spend.
3. Confirm the target story length is expected.
4. Run a short smoke if models or keys changed.
5. Start full-length acceptance only after explicit approval.

Emergency stop:

1. Set `PROVIDER_KILL_SWITCH=true` in Railway.
2. Redeploy or restart the service.
3. Confirm `/health` reports `providerKillSwitch: true`.
4. Inspect queue/job state before re-enabling.

## Failed Job Recovery

First identify the failure class:

- Auth or enrollment: check device token/enrollment state.
- Budget: check budget variables and job cost estimate.
- Provider: check the relevant provider key, model ID, quota, and response shape.
- Storage: check R2 credentials, bucket name, endpoint, and object permissions.
- Worker/restart: check Railway logs and persisted `/data` queue/job files.

Safe recovery order:

1. Preserve current logs and job metadata.
2. Do not delete generated assets until you know whether they are referenced by a completed story.
3. Fix configuration first, then retry through the app or backend lifecycle path.
4. If a provider call may create new paid work, confirm the retry fits the approved budget.
5. If a job is corrupt or obsolete, delete it through the app/backend deletion path so local and remote state stay aligned.

The full-length acceptance command records failure summaries under `.codex-harness/evidence/...` when run locally. Use those artifacts for diagnosis instead of guessing from partial console output.

## Backend Deploy

Deploy path:

```bash
railway up --detach
```

After deploy:

```bash
curl -fsS https://sleepy-history-api-production.up.railway.app/health
```

Verify:

- Production mode is active.
- Worker health is OK.
- Provider kill switch is in the intended state.
- `/demo-stories/story_full_length_acceptance` returns the hosted story.

If Railway is temporarily unavailable:

- Do not change app code to work around the outage.
- Wait for Railway health to recover.
- Retry `/health`, then retry the app path.

## iPhone Install

Target device:

- Khaled's iPhone, iPhone 14 Pro Max, identifier `BA7F46B3-E8D0-56F0-88FD-0C3179B568DC`.

Build:

```bash
xcodebuild -project ios/SleepyHistory.xcodeproj -scheme SleepyHistory -configuration Debug -destination id=BA7F46B3-E8D0-56F0-88FD-0C3179B568DC -derivedDataPath /private/tmp/sleepy-history-device-derived -allowProvisioningUpdates build
```

Install:

```bash
xcrun devicectl device install app --device BA7F46B3-E8D0-56F0-88FD-0C3179B568DC /private/tmp/sleepy-history-device-derived/Build/Products/Debug-iphoneos/SleepyHistory.app
```

Launch:

```bash
xcrun devicectl device process launch --device BA7F46B3-E8D0-56F0-88FD-0C3179B568DC --terminate-existing com.khaledayeva.SleepyHistory
```

Notes:

- The phone generally needs to be unlocked for install/launch reliability.
- The signing prompt should stay quiet after choosing Always Allow for the development certificate keychain item.
- If iOS reports the developer profile is untrusted, trust it on the phone and retry.

## TestFlight Or App Store

Use `docs/testflight-app-store-checklist.md` when we decide to leave direct installs.

Archive command:

```bash
xcodebuild -project ios/SleepyHistory.xcodeproj -scheme SleepyHistory -configuration Release -destination 'generic/platform=iOS' archive -archivePath /private/tmp/SleepyHistory.xcarchive -allowProvisioningUpdates
```

Current status:

- Release archive has succeeded.
- Actual upload still needs App Store Connect distribution setup.

## Troubleshooting

App opens but audio does not play:

- Confirm backend `/health`.
- Confirm `/demo-stories/story_full_length_acceptance` returns the story.
- Confirm the app uses the hosted base URL in Info.plist.
- Check that the audio asset URL has not expired before playback preparation.
- Relaunch the app and press play again.

No lock-screen controls:

- Confirm audio has actually started.
- Confirm `UIBackgroundModes = audio`.
- Keep the app playing, then lock the phone.
- If controls still do not appear, reinstall and launch a fresh build.

Signing asks for a password:

- Choose Always Allow when macOS prompts for the Apple Development certificate key.
- Re-run a device build to confirm the prompt is gone.

Install fails:

- Unlock the phone.
- Confirm Developer Mode and trust state.
- Re-run `xcrun devicectl list devices`.
- Use a fresh derived-data path under `/private/tmp`.

Railway endpoint fails:

- Check Railway service status.
- Check variables and deploy logs.
- Retry after Railway recovers before changing app code.

R2 asset fetch fails:

- Confirm storage variables in Railway.
- Confirm bucket `sleepy-history-stories` still exists.
- Confirm signed URL expiry is not too short for the app flow.
- Avoid making objects permanently public unless the product decision explicitly changes.

Large storage or bandwidth:

- The current full-length WAV is about 108 MB.
- Keep WAV for first private validation.
- Prioritize AAC/M4A output or transcoding before broader tester or App Store distribution.

## Standard Verification Set

Use the narrowest useful check while iterating:

```bash
xcodebuild -project ios/SleepyHistory.xcodeproj -scheme SleepyHistory -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' build
xcodebuild -project ios/SleepyHistory.xcodeproj -scheme SleepyHistory -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' -only-testing:SleepyHistoryTests/PlaybackServiceTests -only-testing:SleepyHistoryTests/DownloadServiceTests test
npm --prefix server test
npm --prefix server run lint
.codex-harness/bin/codex-harness validate-plan --file Plans.md
.codex-harness/bin/codex-harness quality-gate --base HEAD --strict
```

Use full validation before larger releases:

```bash
bash scripts/full-validation.sh
node scripts/validate-release.mjs
```
