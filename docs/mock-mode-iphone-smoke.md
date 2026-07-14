# Mock-Mode iPhone Smoke

Date: 2026-05-10

Target device:
- Khaled's iPhone
- iPhone 14 Pro Max
- iOS 26.4.2
- Device identifier: `00008120-0019193E0EE3C01E`

Verified from Mac/Xcode:
- `xcrun devicectl list devices` reported `Khaled's iPhone` as available and paired.
- `xcodebuild -project ios/SleepyHistory.xcodeproj -scheme SleepyHistory -showdestinations` listed the device as an available iOS destination.
- `xcodebuild -project ios/SleepyHistory.xcodeproj -scheme SleepyHistory -configuration Debug -destination id=00008120-0019193E0EE3C01E -derivedDataPath /tmp/sleepy-history-device-derived build` succeeded after wiring the Now Playing sheet to `PlaybackService`.
- `xcrun devicectl device install app --device 00008120-0019193E0EE3C01E /tmp/sleepy-history-device-derived/Build/Products/Debug-iphoneos/SleepyHistory.app` installed `com.khaledayeva.SleepyHistory`.
- `xcrun devicectl device process launch --device 00008120-0019193E0EE3C01E com.khaledayeva.SleepyHistory` launched the app.

Playback fix applied:
- The Now Playing play/pause, seek, skip, speed, and sleep timer controls now call `PlaybackService` instead of only toggling local SwiftUI state.
- Full mock mode now writes an audible local WAV for physical-device smoke testing.
- Mock audio filenames use a versioned suffix (`-mock-audio-v2.wav`) so old silent files cannot mask the fix on an existing install.

Automated validation already passing:
- Simulator unit tests: 44 passed.
- Full validation: iOS tests, server tests, server lint, release validation, plan validation, and security gate passed.
- UI quality gate passed.

Manual evidence recorded for task 7.3 approval:
- Completed 2026-05-10 from user-provided physical iPhone screenshots and confirmation.
- Now Playing renders on the iPhone 14 Pro Max with story title, chapter subtitle, progress, play/pause, skip controls, speed, timer, bookmark, and more controls.
- Lock screen shows iOS media controls for Sleepy History with `The Library at Alexandria`, progress, remaining time, play/pause, skip controls, and AirPlay route button.
- User confirmed both in-app playback and lock-screen playback are working.

Current status:
- Build, install, and launch on the physical iPhone passed.
- Physical visual QA and lock-screen audio playback evidence passed via user confirmation and screenshots.
