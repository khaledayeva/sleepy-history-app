# Cost and Latency Budget

Created: 2026-05-09

## Scope

This budget estimates one full-length Sleepy History story using the provider choices in `docs/provider-matrix.md`:

- Research dossier: Google Gemini API, `gemini-3.1-pro-preview`.
- Story writing: Anthropic Claude API, `claude-opus-4-6`.
- Narration: ElevenLabs TTS, starting with `eleven_multilingual_v2`.
- Cover art: OpenAI Images API, `gpt-image-2`.

All figures are planning estimates for budget approval and worker guardrails, not billing guarantees. Real jobs must log provider request IDs, model IDs, token counts, character counts, image settings, elapsed time, retry counts, and final provider-reported usage.

## Assumptions

- Story length target: 55 to 65 minutes, budgeted as a 60 minute nominal story and a 65 minute conservative upper bound.
- Narration pacing: approximately 115 to 125 spoken words per minute for a calm bedtime delivery.
- Story text size: approximately 7,500 words nominal, capped at 8,500 words before budget re-approval.
- TTS characters: approximately 45,000 characters nominal, capped at 52,000 characters including punctuation, headings, and any chunk boundary text.
- TTS chunking: `eleven_multilingual_v2` has a 10,000 character request limit, so a full story should be split into 6 chunks or fewer under the 52,000 character cap.
- Cover art: one generated cover image only, with cached thumbnail and blurred placeholder derived from that image.
- Search grounding: budget assumes no more than 10 Google Search grounding queries for a story. Google includes 5,000 prompts per month shared across Gemini 3 before paid search query charges begin.
- Audio encoding target: AAC or MP3 at 64 to 96 kbps mono or joint stereo. Uncompressed WAV should not be stored as the durable download asset.

## Provider Price Inputs

From `docs/provider-matrix.md`:

- Gemini 3.1 Pro Preview: $2.00 per 1M input tokens up to 200k tokens, $12.00 per 1M output tokens up to 200k tokens. Above 200k, input is $4.00 per 1M and output is $18.00 per 1M.
- Gemini Google Search grounding: 5,000 prompts per month included, then $14 per 1,000 search queries.
- Claude Opus 4.6: $5.00 per 1M base input tokens and $25.00 per 1M output tokens.
- ElevenLabs: TTS is metered primarily by characters or credits. Public docs list approximate model costs of about $0.12 per minute for Multilingual v2 and Eleven v3. The active account plan must be used for final character-level cost before real full-length generation.
- GPT Image 2: standard pricing is $5 text input, $8 image input, and $30 image output per 1M tokens. Per-image cost must be confirmed with the image generation calculator for the selected size and quality.

## Nominal Estimate

| Stage | Usage assumption | Cost estimate | Expected time |
| --- | ---: | ---: | ---: |
| Gemini research dossier | 60,000 input tokens, 12,000 output tokens, up to 6 grounding queries | $0.26 model usage; $0.00 grounding if within included monthly prompts | 2 to 6 minutes |
| Claude story writing and review | 100,000 input tokens, 16,000 output tokens across bible, chapters, and review pass | $0.90 | 8 to 18 minutes |
| ElevenLabs narration | 45,000 characters, about 60 minutes of audio, 5 to 6 chunks | About $7.20 using the $0.12/minute proxy; final cost must use active plan character credits | 15 to 35 minutes |
| OpenAI cover art | 1 text-to-image cover | Budget placeholder: $0.25 until calculator-confirmed | 1 to 4 minutes |
| Assembly and storage prep | Encode, normalize metadata, thumbnails, manifest | Infrastructure/storage cost not estimated here | 1 to 4 minutes |

Nominal provider cost target: about $8.61 per completed story, excluding storage, bandwidth, backend compute, and any paid search grounding beyond the included monthly allowance.

Nominal elapsed time target: about 30 to 60 minutes end to end. The worker UI should present this as a long-running job, not an interactive wait.

Nominal audio size:

- 60 minutes at 64 kbps: about 29 MB.
- 60 minutes at 96 kbps: about 43 MB.
- Budget placeholder with cover art, thumbnails, metadata, and manifest: 35 to 55 MB per story.

## Conservative Upper Bound

| Stage | Usage cap before re-approval | Cost estimate |
| --- | ---: | ---: |
| Gemini research dossier | 120,000 input tokens, 20,000 output tokens, up to 10 grounding queries | $0.48 model usage; up to $0.14 search grounding if outside included monthly prompts |
| Claude story writing and review | 180,000 input tokens, 24,000 output tokens | $1.50 |
| ElevenLabs narration | 52,000 characters, about 65 minutes of audio | About $7.80 using the $0.12/minute proxy; final cost must use active plan character credits |
| OpenAI cover art | 1 generated cover, no variants | Budget placeholder: $0.50 until calculator-confirmed |

Conservative completed-story provider budget: about $10.42 with paid search grounding included. Configure the first full-length acceptance story with a per-job approval cap of at least $12.00 to allow minor provider usage variance, but fail closed above that cap.

Conservative elapsed time target: 45 to 90 minutes. Anything still running after 120 minutes should surface a stalled-job warning and preserve resumable stage metadata.

Conservative audio size:

- 65 minutes at 64 kbps: about 31 MB.
- 65 minutes at 96 kbps: about 47 MB.
- Budget placeholder with cover art, thumbnails, metadata, and manifest: 40 to 65 MB per story.

## Worst-Case Retry Estimate

Worst-case paid retry budget assumes one charged failed attempt plus one successful attempt for each paid generation stage. This is intentionally stricter than a normal retry path and should be treated as the maximum allowed spend for one user-approved full story.

| Stage | Retry assumption | Worst-case cost |
| --- | --- | ---: |
| Gemini research | Conservative research usage charged twice | $0.96 model usage plus up to $0.28 paid search grounding |
| Claude writing | Conservative writing usage charged twice | $3.00 |
| ElevenLabs narration | 65 minutes charged twice | About $15.60 using the $0.12/minute proxy |
| OpenAI cover art | 1 failed charged image plus 1 successful image | Budget placeholder: $1.00 until calculator-confirmed |

Worst-case paid retry ceiling: about $20.84 per story. Set the hard per-story spend ceiling at $21.00 or lower until active plan pricing and image calculator values are confirmed. If any stage would exceed the remaining approved budget, the worker should stop before the provider call and request a new approval.

Retry limits should be stage-specific:

- Research: retry transient provider or grounding failures once; do not retry if the model is unavailable after model-list verification.
- Writing: retry a failed chapter once using the saved story bible and previous accepted chapters; do not restart the full story by default.
- TTS: retry only failed chunks; never regenerate completed chunks unless the voice, model, or text changed.
- Image: no automatic variants; retry once only for transient failure.
- Assembly: retry freely if the failure is local and does not call paid providers.

## Guardrail Recommendations

- Require explicit budget approval before any full 55 to 65 minute real-provider story.
- Store configured provider caps separately from display estimates so prices can be updated without code changes.
- Enforce preflight caps: 120,000 Gemini input tokens, 20,000 Gemini output tokens, 180,000 Claude input tokens, 24,000 Claude output tokens, 52,000 TTS characters, 10 grounding queries, and 1 cover image.
- Use resumable jobs with per-stage idempotency keys where providers support them, and record enough metadata to avoid paying again for completed chunks.
- Surface a pre-generation estimate in the app with separate lines for research/writing, narration, image, expected time, and download size.
- Require re-approval if estimated cost exceeds $12.00, retry exposure exceeds $21.00, story text exceeds 8,500 words, TTS characters exceed 52,000, or a second cover image is requested.
- Keep the owner daily cap at $40.00 for production unless the user explicitly approves a higher same-day spend; preserve the $12.00 per-job cap so one story cannot consume the whole daily budget.
- Disable provider calls in mock mode and short smoke mode unless the job is clearly labeled and separately capped.
- Replace the OpenAI image placeholder with calculator-confirmed per-image values before enabling full-length paid generation.
- Replace the ElevenLabs minute proxy with active-plan character or credit pricing before enabling full-length paid generation.
