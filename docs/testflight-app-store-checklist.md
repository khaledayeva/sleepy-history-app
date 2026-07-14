# TestFlight And App Store Checklist

Created: 2026-05-24

Task: 8.7

## Current Recommendation

Keep using direct Xcode installs for the private MVP. Move to TestFlight when we want over-the-air installs, recurring tester access, or a more release-like build loop. Move to App Store submission only after generation reliability, cost controls, support expectations, and privacy copy are stable.

## Archive Evidence

- Scheme: `SleepyHistory`
- Bundle ID: `com.khaledayeva.SleepyHistory`
- Minimum deployment target: iOS 26.0
- Backend base URL: `https://sleepy-history-api-production.up.railway.app`
- Background audio mode: enabled with `UIBackgroundModes = audio`
- Archive output path used for verification: `/private/tmp/SleepyHistory-8.7.xcarchive`
- Verification command completed successfully on 2026-05-24 with `** ARCHIVE SUCCEEDED **`.
- The current archive is signed with the available Apple Development identity and team provisioning profile. TestFlight/App Store upload will still require the normal App Store Connect distribution setup when we decide to submit.

## App Icon

- The app has an asset catalog app icon at `ios/SleepyHistory/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png`.
- Before TestFlight, verify the icon renders correctly in Xcode's asset catalog for every required idiom/size.
- Before App Store submission, replace any temporary icon with final Sleepy History artwork and confirm there are no alpha-channel or missing-size warnings during archive validation.

## Screenshots

Capture fresh screenshots after the UI is stable:

- iPhone 14 Pro Max Home screen.
- Now Playing sheet with `The Library at Alexandria`.
- Lock-screen playback controls.
- Library with at least one generated or full-length-capable story.
- Create Story flow with the AI/provider disclosure accepted.
- Profile or Settings showing privacy/provider status.

Use real generated assets when possible, but avoid exposing signed R2 URLs, provider keys, device tokens, or internal admin screens in screenshots.

## Metadata

Prepare these fields in App Store Connect:

- App name: Sleepy History.
- Subtitle: Calm bedtime history stories.
- Category: Books or Lifestyle. Choose Books if the app is positioned primarily around narrated story content; choose Lifestyle if sleep routine framing becomes primary.
- Description: Explain that the app creates and plays calm, long-form history stories for bedtime, with AI-assisted research, writing, narration, and cover art handled through a protected backend.
- Keywords: bedtime stories, history, sleep, narration, audio, learning, relaxation.
- Support URL: a stable support page or email destination.
- Privacy Policy URL: required before TestFlight external testing or App Store submission.
- Marketing URL: optional for TestFlight, recommended for public launch.

## Age Rating

Expected rating should stay low if the content policy remains enforced:

- No unrestricted web access.
- No explicit sexual content.
- No graphic violence or gore.
- Historical violence is factual, brief, non-graphic, and sleep-appropriate.
- No gambling, contests, or user-generated public feeds in the MVP.

Re-run the age-rating questionnaire if generation scope expands beyond calm history stories.

## Privacy Nutrition Labels

Expected MVP posture:

- Contact info: not collected unless a support/account feature is added.
- User content: story prompts may be sent to the backend and generation providers.
- Identifiers: device enrollment token is used for owner auth, stored in Keychain, and should not be used for tracking.
- Usage data: local playback position and story status are stored on-device; backend job logs may store operational status.
- Diagnostics: only server logs needed for generation reliability unless crash reporting is added.
- Tracking: no third-party tracking, advertising SDK, or cross-app tracking.

Before public release, verify the actual backend retention policy and any analytics/crash-reporting SDKs against these labels.

## Reviewer Access

For TestFlight or App Review, choose one path:

- Demo mode: keep reviewer access limited to fixture/mock stories and the hosted full-length demo story.
- Enrolled reviewer device: create a fresh one-time enrollment code and provide the backend URL through App Review notes, not in source code.

Do not provide provider API keys, Railway credentials, R2 credentials, or reusable static device tokens to reviewers.

## Release Checks

Run before uploading a build:

```bash
xcodebuild -project ios/SleepyHistory.xcodeproj -scheme SleepyHistory -configuration Release -destination 'generic/platform=iOS' archive -archivePath /private/tmp/SleepyHistory.xcarchive -allowProvisioningUpdates
```

Then verify:

- Archive completes without signing, entitlement, icon, or Info.plist errors.
- Release build uses HTTPS backend URLs only.
- Provider keys are absent from the iOS app bundle.
- The backend is reachable and `/health` returns production OK.
- The hosted demo story endpoint returns `The Library at Alexandria` without exposing permanent public asset URLs.
- Lock-screen playback works on the target iPhone after installing the same release candidate or a matching Debug build.

## Submission Hold Criteria

Do not submit publicly if any of these are true:

- Full-length generation regularly fails or requires manual provider intervention.
- Cost controls, enrollment, or provider kill switches are disabled.
- Audio remains WAV-only for broad distribution and storage/bandwidth cost is a concern.
- Privacy policy, support URL, or reviewer instructions are missing.
- App Store metadata promises public self-service generation before the backend can support it safely.
