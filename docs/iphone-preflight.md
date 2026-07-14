# iPhone and Xcode Preflight

Created: 2026-05-09

## Target

- Device: iPhone 14 Pro Max.
- Target OS: iOS 26.
- First install path: direct Xcode install with automatic signing.

## Local Toolchain Result

The local machine now has:

```text
Xcode 26.4.1
Build version 17E202
Developer directory: /Applications/Xcode.app/Contents/Developer
iPhoneOS SDK: 26.4
iOS Simulator runtime: 26.4
```

`xcodebuild -showsdks` reports iOS 26.4 and iOS Simulator 26.4 SDKs. `xcrun simctl list runtimes` reports the iOS 26.4 simulator runtime.

## Preflight Verdict

Status: passed.

Toolchain, simulator runtime, pairing, Developer Mode, signing team, provisioning, generic device build, physical app install, and first app launch are verified.

## Device and Simulator Service Results

Commands attempted:

```bash
xcodebuild -version
xcodebuild -showsdks
xcrun --sdk iphoneos --show-sdk-version
xcrun simctl list runtimes
xcrun devicectl list devices
xcrun devicectl device info details --device BA7F46B3-E8D0-56F0-88FD-0C3179B568DC
xcrun devicectl device info lockState --device BA7F46B3-E8D0-56F0-88FD-0C3179B568DC
xcodebuild -project ios/SleepyHistory.xcodeproj -scheme SleepyHistory -destination 'generic/platform=iOS Simulator' build
xcodebuild -project ios/SleepyHistory.xcodeproj -scheme SleepyHistory -destination 'generic/platform=iOS' -derivedDataPath /private/tmp/sleepy-history-derived-generic -allowProvisioningUpdates build
xcrun devicectl device install app --device BA7F46B3-E8D0-56F0-88FD-0C3179B568DC /tmp/sleepy-history-derived-generic/Build/Products/Debug-iphoneos/SleepyHistory.app
xcrun devicectl device process launch --device BA7F46B3-E8D0-56F0-88FD-0C3179B568DC --terminate-existing com.khaledayeva.SleepyHistory
```

Successful:

- `xcodebuild -version` returned Xcode 26.4.1, build 17E202.
- `xcodebuild -showsdks` returned iOS 26.4 and iOS Simulator 26.4 SDKs.
- `xcrun --sdk iphoneos --show-sdk-version` returned 26.4.
- `xcrun simctl list runtimes` returned iOS 26.4.
- `xcrun devicectl list devices` found `Khaled’s iPhone`, available and paired, model iPhone 14 Pro Max.
- `xcrun devicectl device info details` reported iOS 26.4.2, Developer Mode enabled, pairing state paired, tunnel connected, and UDID `00008120-0019193E0EE3C01E`.
- A generic iOS Simulator build of the Sleepy History scaffold succeeded.
- A generic signed iOS device build succeeded with automatic provisioning.
- The signed Sleepy History app installed successfully on the physical iPhone.
- `xcrun devicectl device process launch` launched `com.khaledayeva.SleepyHistory` on the physical iPhone after the personal developer profile was trusted.

Blocked or inconclusive:

- None for the MVP deployment preflight.

## Signing Team and Device Status

Verified:

- Signing team: configured locally for the owner's Apple Developer account and intentionally omitted from the public project.
- Xcode account type: personal team.
- Bundle identifier: `com.khaledayeva.SleepyHistory`.
- Signing identity used by Xcode: `Apple Development: khaledayeva@gmail.com (WGP2D385G4)`.
- Provisioning profile: `iOS Team Provisioning Profile: com.khaledayeva.SleepyHistory`.
- Provisioning UUID: `750e8662-1cba-4ffc-9a16-26f0e6e80ef0`.
- Provisioning expiry: 2026-05-17T14:28:05Z.
- Target device UDID: `00008120-0019193E0EE3C01E`.
- Developer Mode: enabled.
- Pairing state: paired.
- Current connection transport: local network.

Follow-up notes:

1. Keep the iPhone unlocked and awake when doing future first installs because developer disk image mounting fails while locked.
2. Personal-team provisioning profiles expire quickly; renew before 2026-05-17T14:28:05Z if direct device install is still in use.
3. If local-network device services become flaky, use a USB cable for install and launch attempts.

## Minimum Success Criteria

This preflight is complete only when:

- Xcode reports an iOS 26-capable SDK/toolchain. Done.
- The physical iPhone 14 Pro Max appears in Xcode or `xcrun devicectl list devices`. Done.
- Developer Mode is confirmed on the phone. Done.
- Automatic signing has a valid team. Done.
- A hello-world app installs and launches on the phone. Done.
- Provisioning expiry constraints are recorded. Done.

The iOS 26 phone deployment preflight is complete. Later phone tasks can proceed with the same bundle identifier, signing team, and direct Xcode install path.
