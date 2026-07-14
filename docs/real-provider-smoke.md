# Real-Provider Smoke Workflow

Date: 2026-05-10

Purpose:
- Verify the complete paid-provider path on a short five-minute story before attempting full-length generation.
- Keep provider keys on the backend side only.
- Produce local evidence that research, writing, narration, cover art, storage, download, and playback-compatible audio all completed.

Command:

```bash
npm --prefix server run smoke:real-providers
```

When running from this repo with the local secret file kept outside the project for security scans:

```bash
node --env-file=../sleepy-history-app.local.env server/dist/src/realProviderSmoke.js
```

Required environment:
- `GEMINI_API_KEY`
- `ANTHROPIC_API_KEY`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `OPENAI_API_KEY`

Optional environment:
- `GEMINI_RESEARCH_MODEL`, default `gemini-3.1-pro-preview`
- `ANTHROPIC_WRITER_MODEL`, default `claude-opus-4-6`
- `ELEVENLABS_TTS_MODEL`, default `eleven_multilingual_v2`
- `ELEVENLABS_OUTPUT_FORMAT`, default `pcm_24000`
- `OPENAI_IMAGE_MODEL`, default `gpt-image-2`
- `REAL_PROVIDER_SMOKE_OUTPUT_DIR`, writes smoke artifacts to a predictable local folder when set
- `STORAGE_SIGNING_SECRET`, used for local signed storage URLs during the smoke

Behavior:
- If any required environment value is missing, the workflow exits successfully with a skipped result and lists the missing keys.
- If all required values are present, the workflow creates a five-minute daily-life request about a scribe closing the Library at Alexandria.
- Gemini builds the research dossier, Opus 4.6 writes the script, ElevenLabs narrates each chapter, GPT-Image 2 creates cover art, and local signed storage stores the assembled assets.
- The workflow downloads the signed audio URL back from storage and verifies the result as playable WAV audio.

Evidence written:
- `jobs.json`
- `queue.json`
- `audio.wav`
- `summary.json`

## Full-Length Acceptance Workflow

Purpose:
- Run the one paid 55 to 65 minute acceptance story only after explicit budget approval.
- Exercise the same real provider path as the short smoke, but with durable R2-compatible storage and restart-backed queue persistence evidence.
- Fail closed before provider calls if the estimated cost exceeds the approved budget cap.

Command:

```bash
npm --prefix server run acceptance:full-length
```

When running from this repo with the local secret file kept outside the project:

```bash
node --env-file=../sleepy-history-app.local.env server/dist/src/fullLengthAcceptance.js --budget-cap-usd 25 --target-minutes 60
```

Additional required environment:
- `STORAGE_PROVIDER=s3`
- `STORAGE_ENDPOINT`
- `STORAGE_BUCKET`
- `STORAGE_ACCESS_KEY_ID`
- `STORAGE_SECRET_ACCESS_KEY`

Optional environment:
- `FULL_LENGTH_ACCEPTANCE_OUTPUT_DIR`, writes acceptance artifacts to a predictable local folder when set
- `FULL_LENGTH_ACCEPTANCE_BUDGET_CAP_USD`, default `25`
- `FULL_LENGTH_ACCEPTANCE_TARGET_MINUTES`, default `60`

Acceptance evidence written:
- `jobs.json` and `queue.json`, including the queued-before-restart and processed-after-restart record
- `audio.wav`, downloaded from the signed storage URL and verified as playable WAV audio
- `summary.json`, including approved budget cap, estimated cost, retry exposure, final duration, chunk count, stage checkpoint count, queue attempts, retry count, and asset links
- `failure-summary.json` when the job fails, including a pointer to `draft-script-diagnostics.json` if the failure came from writer duration validation
- `draft-script-diagnostics.json` for writer duration failures, with sanitized title, target duration, estimated duration, chapter target words, actual words, deltas, and validation issues; full transcript text is intentionally omitted

Writer hardening before the next paid attempt:
- Opus planning now asks for 10 to 12 chapters, preferring 12 for 60 minutes or longer, so each chapter target is smaller and easier to satisfy.
- The backend normalizes plan word targets against the requested duration before chapter prompts are sent.
- Each undersized or oversized chapter transcript gets one deterministic repair prompt before the full script is rejected.
- The worker records granular writing checkpoints for plan, each chapter, each repair, and completion while keeping the public job status as `writing`.
- No further paid full-length attempt should run until these dry-run checks pass locally and the operator explicitly approves the additional spend.

Latest local paid-provider result:
- Date: 2026-05-10.
- Status: completed.
- Story ID: `story_real_provider_smoke`.
- Output directory: a temporary local smoke-test folder that was not committed.
- Audio: playable WAV, 463.052 seconds, 16 kHz mono, 14,817,718 bytes.
- Assets produced: audio, full cover, thumbnail, placeholder, chapter markers, transcript, sources, and script.
- Note: signed local URLs are intentionally omitted from this document.

Current storage note:
- The short smoke intentionally uses signed local storage to keep it fast and cheap.
- The full-length acceptance command requires the S3-compatible storage adapter so the generated story assets prove the R2 path used by the hosted backend.
