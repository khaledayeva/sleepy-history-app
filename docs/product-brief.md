# Sleepy History Product Brief

Created: 2026-05-09

## Product Intent

Sleepy History is a personal iOS bedtime audio app for generating original, calm, long-form history stories that are easy to listen to while falling asleep. The app should feel like a quiet nighttime library: warm, polished, reliable, and low friction. The first build is optimized for one owner on an iPhone 14 Pro Max running iOS 26, with direct Xcode installation and a small backend that keeps provider secrets off-device.

The core promise is simple: choose a historical figure or everyday-life setting, generate a factual but gentle hour-long story, receive calm narration and cover art, then listen with sleep-friendly playback controls.

## Target User

The initial target user is a history-curious listener who wants bedtime audio that is soothing, lightly educational, and long enough to avoid repeated interaction after lying down. They want the app to feel elegant and dependable, but they do not want a complicated production studio, social platform, or publishing workflow.

Primary jobs:

- Generate a new sleep story from a historical figure, era, place, or ordinary-person perspective.
- Continue listening to a story from the previous night.
- Save, favorite, download, and replay stories without fighting app state.
- Fall asleep without bright, busy, or demanding interactions.

## Inspiration Analysis

The product takes format inspiration from Boring History For Sleep by HistoryAndSleepOfficial: long calm historical episodes, gentle pacing, soft narration, ambient sound options, chapter-like progression, and low-drama factual storytelling. Observed topic patterns include historical figures, daily life, travel, objects, places, and broad eras, often framed for sleep rather than high-energy education.

What to borrow:

- Slow, steady story structure that remains interesting without demanding attention.
- Long runtime suitable for sleep, with chapters that can be resumed later.
- Calm historical framing around people, places, routines, food, homes, work, travel, and social customs.
- Optional ambience and soft cover imagery that support bedtime use.

What not to copy:

- Scripts, phrasing, episode titles, branding, show identity, voice identity, or exact narrative formulas.
- Any claim that Sleepy History is affiliated with or derived from the podcast.
- Public-figure or creator voice imitation.
- Overly similar thumbnails, logos, descriptions, or show packaging.

Sleepy History should be an original generator with a similar use case, not a clone.

## Core Story Types

Historical figure stories:

- Focus on a named figure through a calm biographical lens.
- Prefer everyday details, setting, routines, influences, and reflective context over dramatic conflict.
- Keep difficult history factual but softened, non-graphic, and sleep-appropriate.

Daily-life perspective stories:

- Follow a fictional ordinary person in a real historical context.
- Ground details in sourced facts about food, work, family life, clothing, weather, architecture, religion, tools, trade, and social customs.
- Avoid pretending the invented person is a documented historical source.

Place, object, and era stories:

- Explore a city, household, ship, market, monastery, farm, workshop, route, or object through calm narrative.
- Useful for generating variety without always centering famous people.

## Core Flows

Generate a story:

1. Choose story mode: historical figure or daily-life perspective.
2. Enter subject details such as figure, era, place, occupation, mood, and preferred perspective.
3. Choose voice, target length, and optional ambience preference.
4. Review estimated cost/time before submission.
5. Watch a simple progress state: researching, outlining, writing, voicing, imaging, assembling.
6. Open the completed story in the player.

Listen:

1. Resume from Home or Library.
2. Play, pause, skip 15 seconds, change speed, set a sleep timer, and bookmark.
3. Lock the phone and continue playback with Control Center metadata.
4. Return later with position, favorite, download, and bookmark state preserved.

Manage library:

1. Browse all, downloaded, completed, in-progress, and failed stories.
2. Search stories by title, figure, era, place, or category.
3. Download or delete local assets.
4. Retry failed jobs with clear error messaging.

## MVP Scope

The MVP should include:

- Native SwiftUI iOS app with Home, Create, Library, Favorites, Player, Profile, and Settings surfaces.
- Fixture/mock mode that works without external provider keys or network access.
- Backend job API with per-device auth and provider budget controls before real provider use.
- Modular provider adapters for research, writing, voice, image, and storage.
- Long-form generation pipeline with research dossier, story bible, chapters, duration estimate, review pass, TTS chunking, and cover art.
- Background audio, sleep timer, bookmarks, favorites, local persistence, and offline downloads.
- Direct Xcode install path for the target iPhone.

## Non-Goals

The initial build should not include:

- Social feeds, public sharing, creator marketplace, comments, or ratings.
- Multi-user accounts, subscriptions, payments, or App Store commercialization.
- Sync across devices.
- A podcast publishing pipeline.
- Public-figure voice cloning or imitation of the inspiration podcast's narration style.
- Real provider calls from the iOS app.
- Unbounded story generation without auth, cost caps, or retry limits.

## UI Direction

The supplied UI reference establishes the direction: dark evening palette, warm gold accents, serif display titles, compact cards, cinematic historical artwork, and a tab-driven app structure. Keep the design clean and Apple-native rather than ornamental for its own sake.

Required surfaces:

- Home: greeting, continue listening, recent stories, categories, and create-story entry.
- Player sheet: large artwork, title, subtitle, chapter, progress, skip, play/pause, speed, timer, bookmark, more menu, story tabs.
- Library: segmented filters, search, progress, downloaded/completed indicators.
- Favorites: simple saved-story list.
- Profile/settings: stats, downloads, history, bookmarks, provider status, privacy, and support.

Design constraints:

- Preserve the calm dark-and-gold direction while keeping contrast readable.
- Use native SwiftUI controls and iOS 26 conventions where they improve clarity.
- Prefer snappy transitions, stable layouts, Dynamic Type support, VoiceOver labels, and reduced-motion compatibility.
- Keep bedtime interactions low brightness, low cognitive load, and reachable on a large iPhone.
- Do not add marketing-style landing screens inside the app.

## Content Principles

Stories should be:

- Original, sourced, and historically grounded.
- Calm, low-stakes, and non-graphic.
- Accurate about uncertainty, especially where records are incomplete.
- Structured into chapters with gentle continuity.
- Written for listening first, not reading first.
- Clear when a daily-life narrator is fictional but context is factual.

Stories should avoid:

- Sensationalism, intense violence, horror framing, or disturbing bedtime imagery.
- Presenting speculation as fact.
- Copying source text or podcast language.
- Anachronistic details that break trust.
- Overly dense academic exposition.

## Success Criteria

The first end-to-end success state is:

- The app installs on the target iPhone through Xcode.
- Mock mode can browse, create, and play a fixture story without network/provider keys.
- A short real-provider smoke story completes through research, writing, narration, art, storage, download, and playback.
- A full-length 55 to 65 minute acceptance story can complete with budget approval.
- Playback remains reliable when the phone is locked.
- Provider choices remain configurable and swappable.
- The app contains no provider secrets and enforces per-device auth before hosted generation.

## Open Product Choices

- Default narration voice and ElevenLabs voice rights source.
- Whether ambience ships in MVP or waits until the core voice experience is stable.
- The exact first-run wording for AI/provider disclosure.
- Whether the first public distribution path after local install should be TestFlight or a private App Store path.
