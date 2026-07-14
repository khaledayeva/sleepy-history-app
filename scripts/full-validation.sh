#!/usr/bin/env bash
set -euo pipefail

IOS_TEST_DESTINATION="${IOS_TEST_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro Max}"

xcodegen generate --spec ios/project.yml --project ios
xcodebuild -project ios/SleepyHistory.xcodeproj -scheme SleepyHistory -destination 'generic/platform=iOS Simulator' build
xcodebuild -project ios/SleepyHistory.xcodeproj -scheme SleepyHistory -destination "$IOS_TEST_DESTINATION" test
npm --prefix server run build
npm --prefix server test
npm --prefix server run lint
node scripts/validate-release.mjs
