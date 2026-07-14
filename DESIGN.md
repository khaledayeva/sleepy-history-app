# Design

## Theme

Sleepy History is used at night on an iPhone 14 Pro Max, often one-handed while the user is lying down and preparing to sleep. The interface should be dark by default, soft but crisp, with native iOS hierarchy and no decorative noise.

## Color

- Background: near-black blue-green, not pure black.
- Surface: lifted charcoal green with subtle contrast from the background.
- Primary accent: warm amber for selected controls, progress, and primary actions.
- Text: warm off-white for primary labels, muted stone for supporting copy.
- Semantic states: amber for warning/retry, soft green for ready/downloaded, muted gray for inactive.

## Typography

Use SF/system typography. Large screen titles should use `.largeTitle` or `.title` weight-heavy system text, not decorative display text. Story titles may use a restrained serif only where it improves bedtime character, but labels, buttons, settings, and metadata must remain system sans.

## Layout

- Use an Apple Podcasts-inspired tab structure: Home, Create, Library, Bookmarks, Profile.
- Keep a compact mini player above the tab bar whenever there is a current or recent story.
- Use horizontal shelves for recent/generated stories and dense list rows for the library.
- Avoid nested cards. Use cards only for story covers, list rows, tool tiles, and modal panels.
- Keep content within readable margins and stable fixed-format artwork ratios.

## Components

- Story artwork: square or near-square rounded rectangles, driven by generated cover art when available.
- Story row: artwork, title, metadata, progress, primary play button, overflow/bookmark actions.
- Mini player: artwork thumbnail, title, progress tint, play/pause, and tap-to-open behavior.
- Player: large artwork, title, chapter/subtitle, scrubber, skip/play controls, speed, timer, bookmark, transcript/source actions.
- Create flow: compact native form sections with clear cost/time estimate and generation disclosure.
- Settings: grouped rows, visible enrollment/backend/provider status, playback defaults, local data actions.

## Motion

Use short native transitions and sheet presentations. Motion should only communicate state: opening player, changing tabs, loading generation, refreshing status, and pressing controls. Respect reduced motion.

## Reference Direction

Borrow from Apple Podcasts: strong page titles, native tab navigation, translucent mini player, clean library rows, full-screen player hierarchy, simple empty states, and direct media controls. Do not copy Apple branding, purple identity, subscription flows, show marketplace surfaces, or promotional upsells.
