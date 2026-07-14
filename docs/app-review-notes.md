# App Review Notes

Created: 2026-05-10

These notes summarize the privacy, consent, AI disclosure, and review posture for Sleepy History's MVP submission.

## App Purpose

Sleepy History is a native iOS app for generating and playing calm, long-form bedtime history stories. The MVP supports an owner-operated device enrollment flow, mock/offline fixtures, and a backend-backed generation path.

## AI and Provider Disclosure

- Before the first story generation, the iOS app presents an AI/provider disclosure and requires the user to continue before any generation submit is performed.
- The disclosure is persisted locally with `sleepy-history.ai-provider-disclosure-accepted` so it is not repeatedly shown after consent.
- The create-story screen also shows a short "Before generation" privacy summary near the generation estimate.
- User-facing copy discloses that stories, narration, and cover art may be AI-generated or AI-assisted.

## Data Sent for Generation

When a user starts generation, the iOS app sends the story request to the Sleepy History backend. The request can include:

- Story subject.
- Era.
- Location.
- Perspective.
- Target length.
- Selected approved voice.

The backend may then send generation prompts, source-grounded story text, narration text, and cover-art prompts to configured providers:

- Gemini for research.
- Claude for writing.
- ElevenLabs for narration.
- OpenAI for cover art.

The app copy tells users not to include private personal information in story prompts.

## Privacy and Security Boundary

- Provider API keys are never stored in the iOS app and are never sent to the device.
- Real provider calls originate from the backend or worker after auth, policy, budget, and provider configuration checks.
- The iOS app stores only local UI preferences, generated-story playback state, downloaded assets, and a Keychain device enrollment token when enrolled.
- Device enrollment uses server-issued tokens; raw provider secrets and raw provider auth headers are not logged by the client.
- Sleepy History does not sell data, track users across apps or websites, or use third-party advertising SDKs in the MVP.

## Content Safety

- Generation policy blocks erotic content, graphic violence, gore, hate, harassment, extremist praise, self-harm instruction, illegal instruction, public-figure voice imitation, and requests to copy another podcast or creator.
- Historical violence may be included only when factual, brief, non-graphic, and sleep-appropriate.
- Daily-life fictional narrators are treated as fictional composites grounded in historical sources.
- Narration uses approved synthetic voices only; voice cloning and public-figure imitation are out of scope for MVP.

## Reviewer Notes

- The app has a mock mode path that works without external provider keys or network-backed provider calls.
- Full generation requires an enrolled owner device and a configured backend.
- If reviewer access to real generation is needed, provide a fresh enrollment code and backend URL through App Review notes outside the repository.
- No App Tracking Transparency prompt is expected because the MVP does not track users across apps or websites.
- No HealthKit, Contacts, Photos, precise location, microphone, camera, or advertising identifier access is required for the MVP.

## Related Internal Docs

- `docs/content-policy.md`
- `docs/provider-matrix.md`
- `docs/security-budget-controls.md`
- `docs/cost-latency-budget.md`
