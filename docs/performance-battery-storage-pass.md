# Performance, Battery, And Storage Pass

Date: 2026-05-19, updated 2026-05-24

Task: 8.3

## Scope

This pass records the current app behavior before the final physical-iPhone deployment task. The app now loads the full-length acceptance story through the hosted backend demo-story route and streams the generated R2 audio through the native playback service.

## Devices And Builds

- Target physical device detected: Khaled's iPhone, iPhone 14 Pro Max, iPhone15,3, paired and available through CoreDevice as `BA7F46B3-E8D0-56F0-88FD-0C3179B568DC`.
- Simulator used for live QA: iPhone 17 Pro Max, iOS 26.4, `6727A5DD-35DF-4180-97FD-4FB7A871F814`.
- App bundle ID: `com.khaledayeva.SleepyHistory`.
- API base URL in app Info.plist: `https://sleepy-history-api-production.up.railway.app`.
- Background audio mode is present in Info.plist: `UIBackgroundModes = audio`.
- Simulator Debug app size: 25 MB.
- Fresh physical-device Debug build succeeded after retrying in a clean derived-data folder.
- Fresh physical-device Debug app size: 9.5 MB.
- Fresh physical-device install succeeded.
- Fresh physical-device launch succeeded after trusting the developer profile.
- After choosing Always Allow for the signing keychain prompt, a repeat physical-device build, install, and launch completed without another password interruption.

## Launch And Responsiveness

- XcodeBuildMCP simulator build, install, and launch succeeded in 18.671 seconds on the already-booted iPhone 17 Pro Max simulator.
- A direct simulator app relaunch through `xcrun simctl launch` completed in 0.22 seconds.
- A physical iPhone app launch through `xcrun devicectl device process launch --terminate-existing` completed in 1.61 seconds after profile trust was allowed.
- A later physical iPhone app launch after the hosted-story playback wiring completed in 5.06 seconds through `xcrun devicectl device process launch --terminate-existing`.
- A simulator Home-screen scroll gesture completed successfully through XcodeBuildMCP, with screenshot capture succeeding immediately afterward.
- Real-device player QA found the original progress slider could lag behind the user's finger because every drag update issued an `AVPlayer.seek`.
- The player now updates a local scrub position while dragging and commits one seek when the user releases the slider. User validation confirmed the updated scrubber behavior is looking good on the phone.
- Running simulator app resident set sample after relaunch: 213,792 KB, about 209 MB RSS.
- No app crash, memory warning, or app-specific error logs were observed in the simulator launch result or physical-device build/install/launch checks.

## Playback And Download Storage

- Focused simulator tests passed: 19 passed, 0 failed.
- Covered suites:
  - `SleepyHistoryTests/DownloadServiceTests`
  - `SleepyHistoryTests/PlaybackServiceTests`
- These tests verify local/remote playback resolution, background audio metadata setup, remote command handling, sleep timer, speed changes, bookmark persistence, download write/delete behavior, local storage usage updates, and generated asset backup exclusion.
- Simulator data container size after the live run: 13 MB.
- Download storage implementation writes generated assets under Application Support `SleepyHistory/Downloads` and marks both the download directory and written files as excluded from iCloud backup.
- Cleanup behavior remains covered by `DownloadServiceTests`, which verify local audio, artwork, transcript, and source deletion and storage usage recalculation after removal.

## Full-Length Story Storage

- Paid full-length acceptance audio: 113,545,248 bytes, about 108 MB on disk.
- Duration: 3,548.287625 seconds, about 59.14 minutes.
- Audio format: WAV, 16 kHz, mono.
- R2 object key: `stories/story_full_length_acceptance/audio.wav`.
- Related generated assets in R2 include cover full, cover thumbnail, cover placeholder, chapter markers, transcript, sources, and script.
- The current storage size is acceptable for a first private build, but an encoded audio format such as AAC/M4A should be prioritized before broader distribution to reduce a one-hour story from roughly 108 MB to a much smaller download.

## Physical iPhone Notes

- Physical iPhone availability passed: the target phone is visible, paired, and reachable by `xcrun devicectl list devices`.
- Previous physical-device smoke evidence from 2026-05-10 confirmed the app opened on the iPhone 14 Pro Max, in-app playback worked, and lock-screen media controls appeared for `The Library at Alexandria`.
- The current hosted-story build also plays the generated full-length `The Library at Alexandria` audio on the phone, and the lock screen shows the story title, progress, pause, skip, and AirPlay controls.
- A fresh physical-device build succeeded with the correct Apple Development identity and provisioning profile.
- Installing the build to the iPhone succeeded.
- Initial launch was denied by iOS until the development profile was explicitly trusted by the user.
- After profile trust, launching the app on the iPhone succeeded.
- Short locked-screen playback behaved like normal background audio: playback continued after locking, lock-screen controls updated, and no device-side interruption or memory-warning symptom was reported during the manual pass.
- Battery behavior has not yet been quantified with an Instruments energy trace. For this private install, the practical risk is acceptable because playback uses `AVPlayer` streaming a single remote audio asset with background audio mode rather than a custom decoder or polling loop.

## Risks And Follow-Up

- The development profile trust issue is cleared for this phone.
- Battery behavior should be measured on the phone with at least one 10 to 15 minute locked-screen playback sample before marking the deployment path fully comfortable.
- The full-length WAV is functional but too large for a polished release path. The simplest follow-up is to add backend AAC/M4A output or transcoding while keeping the storage/provider interfaces unchanged.
