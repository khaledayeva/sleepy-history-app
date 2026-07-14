# Provider Matrix

Verified: 2026-05-09

This matrix records the initial provider choices for Sleepy History and the implementation constraints needed to keep each provider swappable. All provider calls must originate from the backend or worker. The iOS app must never store provider API keys or call these APIs directly.

## Decisions

| Capability | Provider | Default model/config | Status | Backend SDK choice | Auth method |
| --- | --- | --- | --- | --- | --- |
| Research dossier | Google Gemini API | `gemini-3.1-pro-preview` | Use for MVP only after runtime model-list verification; treat as preview | `@google/genai` | `GEMINI_API_KEY` server env |
| Story writing | Anthropic Claude API | `claude-opus-4-6` | Use as requested; configurable | `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` server env |
| Narration | ElevenLabs TTS | Start with `eleven_multilingual_v2`; evaluate `eleven_v3` only after voice tests | Use for MVP | Official ElevenLabs Node SDK or REST API | `ELEVENLABS_API_KEY` server env |
| Cover art | OpenAI Images API | `gpt-image-2` | Use for MVP if account tier supports it | `openai` TypeScript SDK | `OPENAI_API_KEY` server env |

## Capability Notes

### Gemini research provider

- Model ID: `gemini-3.1-pro-preview`, listed by Google pricing docs on 2026-05-09. The adapter must also verify availability through the Gemini Models API before any real provider job is enabled.
- Preview caveat: Google marks Gemini 3.1 Pro as preview. Preview models can have stricter limits and may change before stable release, so the model ID must live in provider config and should fail closed if it is not returned for the account.
- Useful capabilities and limits: text, image, video, audio, and PDF input; text output; 1,048,576 input token limit; 65,536 output token limit; structured outputs; function calling; code execution; URL context; Google Search grounding; Maps grounding; context caching; batch, flex, and priority modes. Gemini 3.1 Pro Preview does not support audio generation, image generation, or the Live API.
- Pricing notes: standard paid tier is listed at $2.00 per 1M input tokens for prompts up to 200k tokens, $4.00 above 200k, $12.00 per 1M output tokens up to 200k, and $18.00 above 200k. Grounding with Google Search includes 5,000 prompts per month shared across Gemini 3, then $14 per 1,000 search queries.
- Implementation note: the research adapter must store grounding metadata and claim-to-source mappings. Do not rely on raw generated prose as the research source of truth.

### Claude story writer provider

- Model ID: `claude-opus-4-6`.
- Provider caveat: Anthropic currently recommends `claude-opus-4-7` for the most complex tasks, but the user explicitly chose Opus 4.6 for story writing. Keep `claude-opus-4-6` as the default until the user approves a model swap.
- Useful capabilities and limits: text and image input, text output, multilingual support, vision, 1M token context window, and 128k max output tokens through the synchronous Messages API. Anthropic also notes that Opus 4.6 supports up to 300k output tokens on the Message Batches API with the `output-300k-2026-03-24` beta header.
- Pricing notes: Anthropic's current pricing docs list Opus 4.6 at $5 per 1M base input tokens and $25 per 1M output tokens. Prompt caching pricing is $6.25 per 1M tokens for 5 minute cache writes, $10 per 1M tokens for 1 hour cache writes, and $0.50 per 1M tokens for cache hits and refreshes.
- Implementation note: use a story bible and chapter checkpoints rather than one giant prompt. Log model ID, prompt version, token counts, and request ID per chapter.

### ElevenLabs voice provider

- Model IDs to evaluate:
  - `eleven_multilingual_v2`: best first candidate for consistent long-form narration; 10,000 character request limit.
  - `eleven_flash_v2_5` or `eleven_turbo_v2_5`: lower latency and larger 40,000 character limits, but must be auditioned for bedtime tone.
  - `eleven_v3`: most expressive, but shorter request limits and more dramatic delivery may be less sleep-friendly.
- Voice source and rights metadata:
  - MVP must use only an approved allowlist of voice IDs from the account's library.
  - Store `voice_id`, display name, category, labels, available tiers, source type, permission status, preview URL, selected model ID, and voice settings in backend config.
  - Do not use voice cloning or public-figure imitation for MVP.
  - Community Voice Library voices may require a paid tier and should not be assumed available to free accounts.
- Pricing notes: ElevenLabs meters TTS primarily by characters/credits. Public docs list approximate model costs such as about $0.06 per minute for Flash/Turbo and about $0.12 per minute for Multilingual v2/Eleven v3, while plan pages expose monthly credit bundles. The cost budget task must compute character-level cost using the active plan before real full-length generation.
- Implementation note: chunk text below model limits and store per-chunk request metadata so audio generation can resume safely.

### OpenAI cover art provider

- Model ID: `gpt-image-2`; dated snapshot currently listed as `gpt-image-2-2026-04-21`.
- Useful capabilities: text-to-image generation, image editing, flexible image sizes, high-fidelity image inputs.
- Limits: rate limits vary by usage tier. The GPT Image 2 model page lists Tier 1 at 5 images per minute and higher tiers scaling upward.
- Pricing notes: OpenAI lists `gpt-image-2` standard pricing per 1M tokens at $5 text input, $8 image input, and $30 image output; batch pricing is lower. Use the image generation calculator for per-image estimates.
- Implementation note: prefer one cover image plus cached thumbnail and blurred placeholder. Do not generate multiple variants by default until budget caps are confirmed.

## Fallback Policy

- Provider adapters must be selected through a registry, not direct imports in business logic.
- Every adapter must have a fixture/mock implementation that passes contract tests without external keys.
- Model IDs, enabled flags, retry ceilings, and per-job cost caps must be environment/config values.
- Fallbacks are not automatic for full story jobs unless the user approves the fallback provider/model in config.
- If a provider model disappears, exceeds budget, or changes terms, jobs should fail with an actionable provider error rather than silently changing output quality.
- Short smoke tests may use cheaper or faster alternatives only when explicitly labeled as smoke mode.

## Sources

- Google Gemini models: https://ai.google.dev/gemini-api/docs/models
- Google Gemini 3.1 Pro Preview model page: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview
- Google Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- Google GenAI SDK: https://ai.google.dev/gemini-api/docs/libraries
- Anthropic Opus 4.6 announcement: https://www.anthropic.com/news/claude-opus-4-6
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic model IDs and models overview: https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions and https://platform.claude.com/docs/en/about-claude/models/overview
- ElevenLabs TTS API: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
- ElevenLabs voices and SDKs: https://elevenlabs.io/docs/capabilities/voices and https://elevenlabs.io/docs/eleven-api/resources/libraries
- OpenAI GPT Image 2 model page: https://developers.openai.com/api/docs/models/gpt-image-2
- OpenAI pricing: https://developers.openai.com/api/docs/pricing
- OpenAI JavaScript SDK setup: https://platform.openai.com/docs/libraries/javascript
