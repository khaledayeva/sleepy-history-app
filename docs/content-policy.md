# Content Policy

Created: 2026-05-09

This policy defines the content and rights rules for Sleepy History generation. It is written for implementation, review, and QA, not as public legal copy.

## Scope

The policy applies to every generated story, research dossier, cover prompt, narration job, fixture story, and user-facing disclosure in the iOS app and backend. It covers both mock mode and real provider mode.

## Core Rules

### Prompt filtering

- Reject prompts that ask for erotic content, graphic violence, gore, horror framing, hate, harassment, extremist praise, self-harm instruction, illegal instruction, or content aimed at shocking the listener.
- Reject prompts that request plagiarism, copied podcast scripts, copied episode titles, copied narration style, or "make it sound exactly like" a named show, creator, or public figure.
- Reject prompts that ask the app to impersonate a real living person, public figure, creator, actor, narrator, or podcast host.
- Allow historical subjects, difficult periods, wars, disease, oppression, and death only when the requested treatment can remain factual, non-graphic, calm, and sleep-appropriate.
- Rewrite or constrain borderline prompts instead of silently generating risky content. The backend should preserve the original prompt, the normalized prompt, and the policy decision.
- Show a short, plain-language error when a prompt is blocked, with an invitation to try a calmer historical angle.

### Historical violence handling

- Historical violence may be described when it is necessary for accuracy, but the story must avoid graphic injury detail, cruelty as entertainment, jump scares, horror pacing, and battlefield spectacle.
- Prefer context, causes, aftermath, ordinary life, place, logistics, customs, and human resilience over blow-by-blow conflict.
- Use gentle transitions before difficult material and move through it briefly.
- Do not erase harm or sanitize history into false comfort. State uncertainty and contested interpretations clearly.
- Do not make perpetrators, empires, armies, or violent acts sound glamorous.
- For bedtime narration, avoid sensory detail that would be disturbing when heard in the dark.

### Source attribution

- Research output must include source records and claim-to-source mappings before story writing begins.
- Generated stories should not quote source prose unless the quote is short, necessary, attributed, and allowed by rights constraints.
- Daily-life fictional narrators must be disclosed as fictional composites grounded in historical sources.
- Story metadata should store source titles, URLs or bibliographic details, provider grounding metadata where available, and the research prompt version.
- UI may show concise source notes in a story details or "Sources" surface. The player should avoid dense academic notes in the main bedtime flow.
- If sourcing is thin or contested, the story should say so in calm language instead of presenting speculation as fact.

### AI disclosure

- The app must disclose that stories, narration, and cover art can be AI-generated or AI-assisted.
- Disclosure should be clear, calm, and non-alarming. It belongs in onboarding, Settings, story details, and generation review/confirmation surfaces.
- Suggested direction: "Sleepy History creates original AI-assisted stories from historical sources, then narrates them with approved synthetic voices."
- Do not imply that content is human-authored, professionally narrated, affiliated with any podcast, or endorsed by a historical institution unless that is true.
- Store generation metadata so a completed story can identify which parts were AI-generated, manually edited, fixture-based, or provider-generated.

### Provider keys and calls

- The iOS app must never contain provider API keys, provider secrets, or direct provider calls for Gemini, Anthropic, ElevenLabs, OpenAI, storage, or future generation providers.
- All real provider calls must originate from the backend or worker after per-device auth, budget checks, policy checks, and provider configuration checks.
- Secrets must be stored only as backend environment or secret-manager values.
- Mock mode and fixture stories must work without provider keys or network access.
- Client logs, crash reports, analytics, and local persistence must never include provider keys, raw auth headers, or full provider request payloads.

### Voice use

- MVP narration must use only approved voice IDs from a backend allowlist.
- Each approved voice must have stored rights metadata: `voice_id`, display name, provider, source type, permission status, allowed models, settings, preview URL if available, and approval date.
- Do not use voice cloning in MVP.
- Do not imitate or clone public figures, living people, creators, actors, narrators, podcast hosts, or the inspiration podcast's voice identity.
- Do not prompt ElevenLabs or any future voice provider for a public-figure soundalike, celebrity impression, named narrator imitation, or "in the voice of" delivery.
- Narration direction should use generic performance attributes only, such as calm, slow, warm, low-drama, clear, and sleep-friendly.
- Store `voice_id`, model ID, voice settings, chunk IDs, request IDs, and policy approval status per narration job.

### Originality and inspiration boundaries

- Sleepy History may use the general bedtime-history format: calm long-form pacing, low-drama factual storytelling, chapters, ambience, and gentle historical subjects.
- Do not copy scripts, phrasing, episode titles, branding, show identity, thumbnails, logos, descriptions, voice identity, or exact narrative formulas from the inspiration podcast or any other show.
- Do not claim affiliation with, endorsement by, or derivation from the inspiration podcast.
- Prompt templates must frame the product as an original generator, not as a clone or replacement for a named podcast.
- Cover art should be original historical imagery and must not mimic another show's thumbnail layout or packaging.

## UI Disclosure Copy Direction

Use short, steady copy that fits the nighttime tone.

- Onboarding or Settings: "Sleepy History uses AI tools to create original bedtime history stories from historical sources. Voices are approved synthetic voices, not imitations of public figures or podcast hosts."
- Generation confirmation: "Your story will be AI-assisted, source-grounded, and narrated with an approved synthetic voice."
- Story details: show generation mode, voice display name, provider mode, source list, and whether the narrator or point-of-view character is fictional.
- Blocked prompt message: "That request is too intense or imitation-based for Sleepy History. Try a calmer historical angle, everyday-life setting, or broader era."
- Thin-source note: "Some details are uncertain in the historical record, so this story keeps those moments cautious."

Avoid copy that says or implies:

- "Real narrator," "official podcast style," "celebrity voice," or "sounds like [person/show]."
- "Fully factual" when the story includes fictional composites or uncertain records.
- "Private provider keys are stored on your phone."

## Backend Enforcement Points

1. `createStory` request validation
   - Authenticate device.
   - Run prompt policy classification.
   - Normalize safe prompts and block disallowed prompts.
   - Estimate budget before accepting real provider work.

2. Research job
   - Require source records and claim-to-source mappings.
   - Store provider model ID, grounding metadata, prompt version, request ID, and retrieval date.
   - Fail closed if research provider config is unavailable.

3. Story writing job
   - Pass policy constraints into the story bible and chapter prompts.
   - Require non-graphic historical violence handling.
   - Require disclosure markers for fictional narrators and uncertain claims.
   - Log model ID, prompt version, token counts, request ID, and chapter review status.

4. Content review pass
   - Check for graphic violence, sensationalism, public-figure voice imitation requests, source overclaiming, copied source text, and inspiration-podcast mimicry.
   - Mark failed chapters for rewrite instead of voicing them.

5. Voice job
   - Require approved backend voice allowlist lookup before TTS.
   - Reject cloned, unapproved, public-figure, creator, or podcast-imitation voices.
   - Chunk below provider limits and store per-chunk request metadata.

6. Cover art job
   - Reject prompts that mimic another show's artwork, logo, thumbnail style, or branding.
   - Prefer one original cover image by default until budget caps are confirmed.
   - Store image prompt version, provider model ID, request ID, and review status.

7. Client delivery
   - Return only safe story metadata and playback URLs.
   - Never return provider secrets, raw provider auth headers, or internal provider payloads to the iOS app.
   - Include disclosure metadata for Settings, story details, and source surfaces.

## Review Metadata

Each generated story should carry policy metadata that is available to backend review tools and safe to summarize in the app.

Required backend fields:

- `content_policy_version`
- `original_user_prompt`
- `normalized_prompt`
- `prompt_policy_decision`
- `prompt_policy_reasons`
- `historical_violence_level`
- `fictionalized_pov`
- `source_count`
- `source_records`
- `claim_source_map_id`
- `ai_disclosure_required`
- `research_provider`
- `research_model_id`
- `writing_provider`
- `writing_model_id`
- `image_provider`
- `image_model_id`
- `voice_provider`
- `voice_model_id`
- `voice_id`
- `voice_permission_status`
- `public_figure_voice_check`
- `inspiration_mimicry_check`
- `provider_key_exposure_check`
- `review_status`
- `reviewer`
- `reviewed_at`

Suggested enum values:

- `prompt_policy_decision`: `allow`, `allow_with_constraints`, `block`
- `historical_violence_level`: `none`, `contextual`, `moderate_non_graphic`, `blocked_graphic`
- `fictionalized_pov`: `none`, `fictional_composite`, `documented_person`
- `voice_permission_status`: `approved`, `blocked`, `unknown`
- `review_status`: `pending`, `passed`, `rewrite_required`, `blocked`

## Acceptance Checklist

- Prompts are filtered before provider calls.
- Historical violence is factual, brief, non-graphic, and sleep-appropriate.
- Sources and claim mappings are stored before story writing.
- AI-generated or AI-assisted content is disclosed in app surfaces.
- Provider keys never ship in the iOS app and are never exposed to client logs.
- Narration uses only approved backend voice IDs.
- Public-figure, creator, or podcast-host voice imitation is blocked.
- The inspiration podcast's scripts, phrasing, voice identity, packaging, and exact narrative formula are not copied.
- Review metadata is stored for each generated story and narration job.
