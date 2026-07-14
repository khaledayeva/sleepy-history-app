import XCTest
import SwiftData
@testable import SleepyHistory

final class SleepyHistoryTests: XCTestCase {
  @MainActor
  func testRootViewTypeExists() {
    XCTAssertNotNil(RootView())
  }

  func testAppTabsExposeStableNavigationLabels() {
    XCTAssertEqual(AppTab.allCases.map(\.title), [
      "Home",
      "Library",
      "Create",
      "Bookmarks",
      "Settings"
    ])

    XCTAssertEqual(AppTab.allCases.map(\.accessibilityIdentifier), [
      "tab-home",
      "tab-library",
      "tab-create",
      "tab-bookmarks",
      "tab-settings"
    ])
  }

  func testDefaultCatalogContainsHostedStoryOnly() {
    XCTAssertEqual(FixtureStory.continueListening.id, "story_full_length_acceptance")
    XCTAssertEqual(FixtureStory.catalog.map(\.id), ["story_full_length_acceptance"])
    XCTAssertEqual(FixtureStory.recent.count, 1)
    XCTAssertTrue(FixtureStory.bookmarks.isEmpty)

    XCTAssertTrue(FixtureStory.catalog.contains { $0.status == .completed })
    XCTAssertFalse(FixtureStory.catalog.contains { $0.status == .inProgress })
    XCTAssertFalse(FixtureStory.catalog.contains { $0.status == .failed })

    let nowPlayingStory = FixtureStory.continueListening
    XCTAssertFalse(nowPlayingStory.chapter.isEmpty)
    XCTAssertFalse(nowPlayingStory.currentTime.isEmpty)
    XCTAssertFalse(nowPlayingStory.remainingTime.isEmpty)
    XCTAssertEqual(nowPlayingStory.totalTimeLabel, "59:00")
    XCTAssertEqual(nowPlayingStory.progressLabel, "Not started")
  }

  func testLibraryFiltersUseStableLabelsAndFixtureData() {
    XCTAssertEqual(LibraryStoryFilter.allCases.map(\.title), [
      "All",
      "Downloaded",
      "In Progress",
      "Completed",
      "Failed"
    ])

    XCTAssertEqual(LibraryStoryFilter.allCases.map(\.accessibilityIdentifier), [
      "library-filter-all",
      "library-filter-downloaded",
      "library-filter-inProgress",
      "library-filter-completed",
      "library-filter-failed"
    ])

    XCTAssertEqual(
      FixtureStory.library(matching: .all, searchText: "").count,
      FixtureStory.catalog.count
    )
    XCTAssertEqual(
      FixtureStory.library(matching: .downloaded, searchText: "").count,
      FixtureStory.catalog.filter(\.isDownloaded).count
    )
    XCTAssertEqual(
      FixtureStory.library(matching: .completed, searchText: "").count,
      FixtureStory.catalog.filter { $0.status == .completed && $0.progress >= 0.99 }.count
    )
    XCTAssertEqual(
      FixtureStory.library(matching: .inProgress, searchText: "").count,
      FixtureStory.catalog.filter { $0.status == .inProgress || ($0.status == .completed && $0.progress > 0 && $0.progress < 0.99) }.count
    )
    XCTAssertEqual(
      FixtureStory.library(matching: .failed, searchText: "").count,
      FixtureStory.catalog.filter { $0.status == .failed }.count
    )
  }

  func testLibrarySearchMatchesTitlesAndCategories() {
    XCTAssertEqual(
      FixtureStory.library(matching: .all, searchText: "alexandria").map(\.id),
      ["story_full_length_acceptance"]
    )

    XCTAssertEqual(
      FixtureStory.library(matching: .all, searchText: "daily life").map(\.id),
      ["story_full_length_acceptance"]
    )

    XCTAssertEqual(
      FixtureStory.library(matching: .failed, searchText: "cover").map(\.id),
      []
    )
  }

  func testCreateStoryDraftProducesMockJobEstimate() {
    var draft = CreateStoryDraft()
    XCTAssertEqual(draft.kind, .dailyLife)
    XCTAssertEqual(draft.subject, "A lantern maker in Ottoman Istanbul")
    XCTAssertEqual(draft.era, "Late 16th century")
    XCTAssertEqual(draft.location, "Istanbul")
    XCTAssertEqual(draft.perspective, "A calm ordinary craftsperson")
    XCTAssertEqual(draft.estimatedCost, "$9.52")
    XCTAssertEqual(draft.estimatedTime, "29-65 min")

    draft.kind = .historicalFigure
    draft.subject = "Hypatia of Alexandria"
    draft.durationMinutes = 45

    let job = FixtureGeneratedJob(draft: draft)
    XCTAssertTrue(job.id.contains("hypatia-of-alexandria"))
    XCTAssertEqual(job.title, "Hypatia of Alexandria")
    XCTAssertEqual(job.progress, 0.18)
    XCTAssertEqual(job.state, .running)
    XCTAssertEqual(job.stage, "Researching")
    XCTAssertEqual(draft.estimatedCost, "$7.27")
    XCTAssertEqual(draft.apiRequest.kind, "historical_figure")
    XCTAssertEqual(draft.apiRequest.voiceId, "calm_narrator_01")
    XCTAssertEqual(CreateStoryDraft.approvedVoices, ["Calm narrator"])
  }

  func testGenerationEstimateChangesWithDurationAndDetails() {
    var shortDraft = CreateStoryDraft()
    shortDraft.durationMinutes = 30
    shortDraft.subject = ""
    shortDraft.era = ""
    shortDraft.location = ""
    shortDraft.perspective = ""

    var longDraft = CreateStoryDraft()
    longDraft.durationMinutes = 65

    let shortEstimate = GenerationEstimate(draft: shortDraft)
    let longEstimate = GenerationEstimate(draft: longDraft)

    XCTAssertLessThan(shortEstimate.totalUSD, longEstimate.totalUSD)
    XCTAssertLessThan(shortEstimate.lowerMinutes, longEstimate.lowerMinutes)
    XCTAssertGreaterThan(shortEstimate.lowerMinutes, 0)
    XCTAssertEqual(longEstimate.costLabel, "$10.28")
    XCTAssertEqual(longEstimate.detailLines.count, 3)
  }

  func testAIProviderDisclosureStatesProviderAndPromptPrivacyBoundary() {
    XCTAssertEqual(
      AIProviderDisclosure.acceptedStorageKey,
      "sleepy-history.ai-provider-disclosure-accepted"
    )
    XCTAssertTrue(AIProviderDisclosure.summary.contains("AI-assisted"))
    XCTAssertTrue(AIProviderDisclosure.providerRouting.contains("Gemini"))
    XCTAssertTrue(AIProviderDisclosure.providerRouting.contains("Claude"))
    XCTAssertTrue(AIProviderDisclosure.providerRouting.contains("ElevenLabs"))
    XCTAssertTrue(AIProviderDisclosure.providerRouting.contains("OpenAI"))
    XCTAssertTrue(AIProviderDisclosure.privacyBoundary.contains("subject"))
    XCTAssertTrue(AIProviderDisclosure.privacyBoundary.contains("era"))
    XCTAssertTrue(AIProviderDisclosure.privacyBoundary.contains("selected voice"))
    XCTAssertTrue(AIProviderDisclosure.privacyBoundary.contains("Provider keys stay on the backend"))
    XCTAssertTrue(AIProviderDisclosure.shouldPresentConsent(hasAccepted: false))
    XCTAssertFalse(AIProviderDisclosure.shouldPresentConsent(hasAccepted: true))
  }

  func testProfileDestinationsExposeStableRoutesForSettingsSurfaces() {
    XCTAssertEqual(ProfileDestination.allCases.map(\.title), [
      "Downloads",
      "Listening History",
      "Provider Status",
      "Privacy",
      "Enrollment"
    ])

    XCTAssertEqual(ProfileDestination.allCases.map(\.accessibilityIdentifier), [
      "profile-row-downloads",
      "profile-row-listeningHistory",
      "profile-row-providerStatus",
      "profile-row-privacy",
      "profile-row-settings"
    ])
  }

  func testPlaybackDefaultsMapSettingsToPlayerControls() {
    XCTAssertEqual(PlaybackDefaults.speedKey, "sleepy-history.default-playback-speed")
    XCTAssertEqual(PlaybackDefaults.sleepTimerKey, "sleepy-history.default-sleep-timer")
    XCTAssertEqual(PlaybackDefaults.playbackRate(for: "0.8x"), 0.8)
    XCTAssertEqual(PlaybackDefaults.playbackRate(for: "1.5x"), 1.5)
    XCTAssertEqual(PlaybackDefaults.sleepTimerSeconds(for: "15 min"), 900)
    XCTAssertEqual(PlaybackDefaults.sleepTimerSeconds(for: "Off"), nil)
  }

  func testGeneratedStoryDownloadStateCanBeClearedForVisibleSettingsActions() {
    var draft = CreateStoryDraft()
    draft.subject = "a night watchman in Edo"
    let downloadedStory = FullMockMode.makeFixtureStory(from: draft)

    let clearedStory = downloadedStory.withDownloadState(
      isDownloaded: false,
      downloadDetail: "Streaming only"
    )

    XCTAssertTrue(downloadedStory.isDownloaded)
    XCTAssertFalse(clearedStory.isDownloaded)
    XCTAssertEqual(clearedStory.downloadDetail, "Streaming only")
    XCTAssertEqual(clearedStory.id, downloadedStory.id)
    XCTAssertEqual(clearedStory.title, downloadedStory.title)
  }

  func testBackendHealthStatusSummariesAreUserFacingAndSafe() throws {
    let data = Data("""
    {
      "ok": true,
      "service": "sleepy-history-server",
      "mode": "production",
      "providerKillSwitch": false,
      "worker": {
        "ok": true,
        "status": "idle",
        "processedJobs": 4
      }
    }
    """.utf8)

    let health = try JSONDecoder().decode(BackendHealthStatus.self, from: data)

    XCTAssertEqual(health.backendSummary, "Backend online")
    XCTAssertEqual(health.providerSummary, "Provider steps visible below")
    XCTAssertEqual(health.workerSummary, "Worker idle")
  }

  func testBackendHealthStatusMapsProviderRows() throws {
    let data = Data("""
    {
      "ok": true,
      "service": "sleepy-history-server",
      "mode": "production",
      "providerKillSwitch": false,
      "providers": [
        {
          "id": "railway-backend",
          "step": "Backend hosting",
          "provider": "Railway",
          "state": "online",
          "detail": "Ready",
          "consoleLinks": [
            { "label": "Dashboard", "url": "https://railway.com/dashboard" }
          ]
        },
        {
          "id": "cloudflare-r2-storage",
          "step": "Object storage",
          "provider": "Cloudflare R2",
          "state": "online",
          "detail": "Ready",
          "consoleLinks": [
            { "label": "R2", "url": "https://dash.cloudflare.com/?to=/:account/r2" }
          ]
        },
        {
          "id": "gemini-research",
          "step": "Research dossier",
          "provider": "Google Gemini",
          "model": "gemini-3.1-pro-preview",
          "state": "online",
          "detail": "Ready",
          "consoleLinks": [
            { "label": "API Keys", "url": "https://aistudio.google.com/app/apikey" },
            { "label": "Billing", "url": "https://console.cloud.google.com/billing" }
          ]
        },
        {
          "id": "elevenlabs-narration",
          "step": "Narration",
          "provider": "ElevenLabs",
          "model": "eleven_multilingual_v2 · pcm_24000",
          "state": "credits_depleted",
          "detail": "Credits are depleted.",
          "consoleLinks": [
            { "label": "Credits", "url": "https://elevenlabs.io/app/subscription" }
          ]
        }
      ],
      "worker": {
        "ok": false,
        "status": "error",
        "processedJobs": 4
      }
    }
    """.utf8)

    let health = try JSONDecoder().decode(BackendHealthStatus.self, from: data)

    XCTAssertEqual(health.providerRows.map(\.label), ["Online", "Online", "Online", "Credits depleted"])
    XCTAssertEqual(health.providerRows[2].providerLine, "Google Gemini · gemini-3.1-pro-preview")
    XCTAssertEqual(health.providerRows[2].consoleLinks.map(\.label), ["API Keys", "Billing"])
    XCTAssertEqual(health.providerRows[3].providerLine, "ElevenLabs · eleven_multilingual_v2 · pcm_24000")
    XCTAssertEqual(health.providerRows[3].systemImage, "exclamationmark.circle.fill")
    XCTAssertEqual(BackendHealthStatus.Provider.defaultConsoleLinks(for: "openai-cover-art").map(\.label), ["API Keys", "Billing", "Usage"])
    XCTAssertEqual(health.workerSummary, "Worker needs attention")
  }

  func testFullMockModeCreatesCompleteOfflineFixtureStoryFromDraft() {
    var draft = CreateStoryDraft()
    draft.subject = "A lantern maker in Ottoman Istanbul"
    draft.durationMinutes = 60

    let story = FullMockMode.makeFixtureStory(from: draft)
    let completedJob = FixtureGeneratedJob(completedStory: story, draft: draft)
    let library = FixtureStory.library(in: [story] + FixtureStory.catalog, matching: .all, searchText: "ottoman")

    XCTAssertEqual(story.id, "mock-story-a-lantern-maker-in-ottoman-istanbul")
    XCTAssertEqual(story.title, "A Lantern Maker in Ottoman Istanbul")
    XCTAssertEqual(story.status, .completed)
    XCTAssertTrue(story.isDownloaded)
    XCTAssertEqual(story.downloadDetail, "Audio ready offline")
    XCTAssertEqual(story.symbol, "book.closed.fill")
    XCTAssertFalse(story.transcriptSections.isEmpty)
    XCTAssertFalse(story.funFacts.isEmpty)
    XCTAssertEqual(completedJob.state, .completed)
    XCTAssertEqual(completedJob.progress, 1)
    XCTAssertEqual(library.map(\.id), [story.id])
  }

  func testGenerationProgressFixturesCoverCancelRetryFailureAndPartialStates() {
    let showcase = FixtureJobShowcase()

    XCTAssertTrue(showcase.jobs.isEmpty)
    XCTAssertEqual(showcase.mockServer.id, "job_mock_server_research")
    XCTAssertEqual(showcase.mockServer.progress, 0.28)
    XCTAssertEqual(showcase.mockServer.stage, "Researching")
    XCTAssertTrue(showcase.mockServer.detail.contains("Daily Life"))
    XCTAssertEqual(FixtureGeneratedJob.failed.failureReason, "Cover art retry needed")
    XCTAssertEqual(FixtureGeneratedJob.failed.state.label, "Needs Retry")
    XCTAssertEqual(FixtureGeneratedJob.partial.state.systemImage, "clock.badge.checkmark")
  }

  func testAPIJobAdapterMapsMockServerProgressAndErrorsIntoQueueCards() {
    let runningJob = FixtureGeneratedJob(apiJob: .mockServerFixture)
    XCTAssertEqual(runningJob.id, "job_mock_server_research")
    XCTAssertEqual(runningJob.title, "A Baker's Quiet Morning in Pompeii")
    XCTAssertEqual(runningJob.state, .running)
    XCTAssertEqual(runningJob.message, "Mock server is gathering grounded daily-life details")

    let failedAPIJob = APIGenerationJob(
      id: "job_mock_server_failed",
      status: "failed",
      request: APIStoryGenerationRequest(
        kind: "daily_life",
        subject: "A failed fixture",
        targetDurationMinutes: 60
      ),
      progress: APIJobProgress(stage: "reviewing", percent: 72, message: "Review stopped"),
      createdAt: "2026-05-10T16:20:00Z",
      updatedAt: "2026-05-10T16:22:00Z",
      storyId: nil,
      error: APIError(code: "review_failed", message: "Needs a gentler rewrite", retryable: true, details: nil)
    )
    let failedJob = FixtureGeneratedJob(apiJob: failedAPIJob)

    XCTAssertEqual(failedJob.state, .failed)
    XCTAssertEqual(failedJob.failureReason, "Needs a gentler rewrite")
    XCTAssertEqual(failedJob.progress, 0.72)

    let lowercasedHostedJob = APIGenerationJob(
      id: "job_lantern",
      status: "writing",
      request: APIStoryGenerationRequest(
        kind: "daily_life",
        subject: "A lantern maker in Ottoman Istanbul",
        targetDurationMinutes: 60,
        era: "Ottoman period",
        location: "Istanbul",
        perspective: "artisan",
        voiceId: "Calm narrator"
      ),
      progress: APIJobProgress(stage: "writing", percent: 42, message: nil),
      createdAt: "2026-05-29T14:00:00Z",
      updatedAt: "2026-05-29T14:05:00Z",
      storyId: nil,
      error: nil
    )

    XCTAssertEqual(FixtureGeneratedJob(apiJob: lowercasedHostedJob).title, "A Lantern Maker in Ottoman Istanbul")

    let budgetAPIJob = APIGenerationJob(
      id: "job_budget_blocked",
      status: "failed",
      request: APIStoryGenerationRequest(
        kind: "daily_life",
        subject: "The Detailed Day of a Talented Undercook Chef in Victorian England",
        targetDurationMinutes: 65
      ),
      progress: APIJobProgress(stage: "queued", percent: 18, message: "Budget guardrail stopped this request"),
      createdAt: "2026-06-03T14:20:00Z",
      updatedAt: "2026-06-03T14:21:00Z",
      storyId: nil,
      error: APIError(
        code: "daily_budget_exceeded",
        message: "Estimated job cost exceeds the configured daily cap.",
        retryable: false,
        details: [
          "estimatedCostUsd": .number(10.28),
          "currentDailyCostUsd": .number(20.56),
          "maxDailyCostUsd": .number(25.00)
        ]
      )
    )
    let budgetJob = FixtureGeneratedJob(apiJob: budgetAPIJob)

    XCTAssertEqual(budgetJob.state, .budgetLimit)
    XCTAssertEqual(budgetJob.state.label, "Budget Limit")
    XCTAssertEqual(budgetJob.failureReason, "Daily generation budget reached. Today's reserved estimate is $20.56 of $25.00; this story is estimated at $10.28. Wait for the daily reset or raise MAX_DAILY_COST_USD in Railway.")

    let anthropicQuotaAPIJob = APIGenerationJob(
      id: "job_anthropic_quota",
      status: "failed",
      request: APIStoryGenerationRequest(
        kind: "daily_life",
        subject: "The Detailed Day of a Talented Undercook Chef in Victorian England",
        targetDurationMinutes: 65
      ),
      progress: APIJobProgress(stage: "writing", percent: 45, message: "Writing chapter transcripts"),
      createdAt: "2026-06-03T15:20:00Z",
      updatedAt: "2026-06-03T15:21:00Z",
      storyId: nil,
      error: APIError(
        code: "provider_quota_exceeded",
        message: "Anthropic Claude credits are depleted or billing is not available. Refill Anthropic credits, then retry the writing step.",
        retryable: true,
        details: [
          "provider": .string("Anthropic Claude"),
          "status": .number(400)
        ]
      )
    )
    let anthropicQuotaJob = FixtureGeneratedJob(apiJob: anthropicQuotaAPIJob)

    XCTAssertEqual(anthropicQuotaJob.state, .failed)
    XCTAssertEqual(anthropicQuotaJob.failureReason, "Anthropic credits are depleted. Refill credits in the Anthropic console, then retry this story.")
  }

  func testTransientGenerationInterruptionKeepsActiveJobRunning() {
    let runningJob = FixtureGeneratedJob(apiJob: .mockServerFixture)
    let interruptedJob = runningJob.interruptedForDisplay(
      message: "Backend connection interrupted. Reconnecting to the generation job."
    )

    XCTAssertEqual(interruptedJob.id, runningJob.id)
    XCTAssertEqual(interruptedJob.progress, runningJob.progress)
    XCTAssertEqual(interruptedJob.state, .running)
    XCTAssertEqual(interruptedJob.state.label, "Generating")
    XCTAssertEqual(interruptedJob.stage, "Reconnecting")
    XCTAssertEqual(interruptedJob.failureReason, "Backend connection interrupted. Reconnecting to the generation job.")

    let failedJob = FixtureGeneratedJob.failed.interruptedForDisplay(message: "Backend connection interrupted.")
    XCTAssertEqual(failedJob.state, .failed)
    XCTAssertEqual(failedJob.stage, FixtureGeneratedJob.failed.stage)
  }

  func testRetryPolicyRefreshesBackendStateBeforeRetryEndpoint() {
    XCTAssertEqual(
      GenerationRetryPolicy.disposition(for: .mockServerFixture),
      .resumePolling
    )

    let failedAPIJob = APIGenerationJob(
      id: "job_failed",
      status: "failed",
      request: APIStoryGenerationRequest(
        kind: "daily_life",
        subject: "A failed fixture",
        targetDurationMinutes: 60
      ),
      progress: APIJobProgress(stage: "voicing", percent: 84, message: "Stopped"),
      createdAt: "2026-06-04T22:38:00Z",
      updatedAt: "2026-06-04T22:38:00Z",
      storyId: nil,
      error: APIError(code: "provider_error", message: "Stopped", retryable: true, details: nil)
    )
    XCTAssertEqual(
      GenerationRetryPolicy.disposition(for: failedAPIJob),
      .retryEndpoint
    )

    let completedAPIJob = APIGenerationJob(
      id: "job_completed",
      status: "completed",
      request: APIStoryGenerationRequest(
        kind: "daily_life",
        subject: "A completed fixture",
        targetDurationMinutes: 60
      ),
      progress: APIJobProgress(stage: "completed", percent: 100, message: "Completed"),
      createdAt: "2026-06-04T22:38:00Z",
      updatedAt: "2026-06-04T22:38:00Z",
      storyId: "story_completed",
      error: nil
    )
    XCTAssertEqual(
      GenerationRetryPolicy.disposition(for: completedAPIJob),
      .importCompletedStory("story_completed")
    )
  }

  func testBookmarksCanBeDerivedFromPersistedStoryIDs() {
    let bookmarks = FixtureStory.bookmarks(in: ["story_full_length_acceptance"])

    XCTAssertEqual(bookmarks.map(\.id), ["story_full_length_acceptance"])
    XCTAssertEqual(FixtureStory.defaultBookmarkedIDsStorage, "")
  }

  func testBookmarksCanIncludeGeneratedStoriesFromVisibleCatalog() {
    var draft = CreateStoryDraft()
    draft.subject = "a night watchman in Edo"
    let generatedStory = FullMockMode.makeFixtureStory(from: draft)
    let stories = [generatedStory] + FixtureStory.catalog

    let bookmarks = FixtureStory.bookmarks(in: [generatedStory.id], from: stories)

    XCTAssertEqual(bookmarks.map(\.id), [generatedStory.id])
  }

  func testPlaybackStateDerivesVisibleStoryProgress() {
    let recentListenDate = Date().addingTimeInterval(-2 * 24 * 60 * 60)
    let expectedWeekday = FixtureStory.lastListenedLabel(for: recentListenDate)
    let state = PersistentStoryState(
      storyID: FixtureStory.hostedStoryID,
      playbackPositionSeconds: 60,
      playbackDurationSeconds: 3_548,
      lastPlayedAt: recentListenDate,
      updatedAt: recentListenDate
    )

    let story = FixtureStory.continueListening.applying(playbackState: state)

    XCTAssertEqual(story.currentTime, "1:00")
    XCTAssertEqual(story.remainingTime, "-58:08")
    XCTAssertEqual(story.progress, 60.0 / 3_548.0, accuracy: 0.000_001)
    XCTAssertEqual(story.progressLabel, "1% listened")
    XCTAssertEqual(story.progressStatusLabel, "In progress")
    XCTAssertEqual(story.lastListenedLabel, expectedWeekday)
  }

  func testLastListenedLabelUsesWeekdayThenConcreteDate() {
    let now = Date(timeIntervalSince1970: 1_779_897_600)
    let withinWeek = Date(timeIntervalSince1970: 1_779_552_000)
    let older = Date(timeIntervalSince1970: 1_778_860_800)

    XCTAssertEqual(FixtureStory.lastListenedLabel(for: withinWeek, now: now), "Saturday")
    XCTAssertEqual(FixtureStory.lastListenedLabel(for: older, now: now), "May 15, 2026")
  }

  func testUpNextPrefersActiveAndNewestStories() {
    let active = FixtureStory.continueListening.applying(playbackState: PersistentStoryState(
      storyID: FixtureStory.hostedStoryID,
      playbackPositionSeconds: 90,
      playbackDurationSeconds: 3_548,
      lastPlayedAt: Date(timeIntervalSince1970: 1_779_200_000),
      updatedAt: Date(timeIntervalSince1970: 1_779_200_000)
    ))
    let generated = FullMockMode.makeFixtureStory(from: StarterIdea.all[0].draft)

    let upNext = FixtureStory.upNext(in: [generated, active], fallback: FixtureStory.continueListening)

    XCTAssertEqual(upNext.map(\.id).prefix(2), [active.id, generated.id])
  }

  func testStarterIdeasProvidePrefilledDraftsAndNoFoodOnlyDailyLifeIcon() {
    XCTAssertGreaterThanOrEqual(StarterIdea.all.count, 5)
    XCTAssertNotEqual(CreateStoryKind.dailyLife.systemImage, "fork.knife")
    XCTAssertEqual(CreateStoryKind.historicalFigure.systemImage, "sleepy.ancient-bust")
    XCTAssertEqual(CreateStoryKind.dailyLife.systemImage, "sleepy.sunrise")
    XCTAssertEqual(StarterIdea.all[0].draft.subject, "A talented assistant chef in Victorian England")
    XCTAssertEqual(StarterIdea.all[0].draft.location, "England")
  }

  func testStorySpecificArtworkScenesCoverVisibleCatalogAndGeneratedStories() {
    XCTAssertEqual(
      StoryArtworkScene.scene(for: FixtureStory.continueListening.title, category: FixtureStory.continueListening.category),
      .alexandria
    )
    XCTAssertEqual(
      StoryArtworkScene.scene(for: "The Warm Kitchen: A Day in a Victorian Country House", category: "Daily Life"),
      .warmKitchen
    )
    XCTAssertEqual(
      StoryArtworkScene.scene(for: "A Lantern Maker in Ottoman Istanbul", category: "Daily Life"),
      .lanternMaker
    )
    XCTAssertEqual(
      StoryArtworkScene.scene(for: "The Copper and the Flame: A Day in a Victorian Kitchen", category: "Daily Life"),
      .copperAndFlame
    )
    XCTAssertEqual(
      StoryArtworkScene.scene(for: "The Copper and the Coal: A Day in a Victorian Kitchen", category: "Daily Life"),
      .copperAndCoal
    )
  }

  func testLivePlaybackStateUpdatesVisibleMiniPlayerProgress() {
    let state = PlaybackState(
      storyID: FixtureStory.hostedStoryID,
      storyTitle: "The Library at Alexandria",
      status: .playing,
      positionSeconds: 90,
      durationSeconds: 3_548
    )

    let story = FixtureStory.continueListening.applying(playbackState: state)

    XCTAssertEqual(story.currentTime, "1:30")
    XCTAssertEqual(story.remainingTime, "-57:38")
    XCTAssertEqual(story.progressLabel, "2% listened")
  }

  func testLibraryFiltersUseDerivedListeningProgress() {
    let partialState = PersistentStoryState(
      storyID: FixtureStory.hostedStoryID,
      playbackPositionSeconds: 60,
      playbackDurationSeconds: 3_548,
      updatedAt: Date(timeIntervalSince1970: 1_779_555_600)
    )
    let partialStory = FixtureStory.continueListening.applying(playbackState: partialState)

    XCTAssertEqual(
      FixtureStory.library(in: [partialStory], matching: .completed, searchText: "").map(\.id),
      []
    )
    XCTAssertEqual(
      FixtureStory.library(in: [partialStory], matching: .inProgress, searchText: "").map(\.id),
      [FixtureStory.hostedStoryID]
    )

    let finishedState = PersistentStoryState(
      storyID: FixtureStory.hostedStoryID,
      playbackPositionSeconds: 3_545,
      playbackDurationSeconds: 3_548,
      updatedAt: Date(timeIntervalSince1970: 1_779_555_700)
    )
    let finishedStory = FixtureStory.continueListening.applying(playbackState: finishedState)

    XCTAssertEqual(
      FixtureStory.library(in: [finishedStory], matching: .completed, searchText: "").map(\.id),
      [FixtureStory.hostedStoryID]
    )
    XCTAssertEqual(
      FixtureStory.library(in: [finishedStory], matching: .inProgress, searchText: "").map(\.id),
      []
    )
  }

  func testNearFinishedPlaybackStateShowsFinishedConsistently() {
    let state = PersistentStoryState(
      storyID: FixtureStory.hostedStoryID,
      playbackPositionSeconds: 3_545,
      playbackDurationSeconds: 3_548,
      updatedAt: Date(timeIntervalSince1970: 1_779_555_600)
    )

    let story = FixtureStory.continueListening.applying(playbackState: state)

    XCTAssertEqual(story.progressLabel, "Finished")
    XCTAssertEqual(story.progressStatusLabel, "Finished")
    XCTAssertEqual(story.remainingTime, "-0:03")
  }

  func testStoryDetailProvidesReadableTranscriptAndSourceMetadata() {
    let story = FixtureStory.continueListening

    XCTAssertGreaterThanOrEqual(story.transcriptSections.count, 3)
    XCTAssertFalse(story.aboutText.isEmpty)
    XCTAssertFalse(story.funFacts.isEmpty)
    XCTAssertEqual(story.sourceLinks.first?.title, "Library of Alexandria background dossier")
    XCTAssertEqual(
      story.sourceLinks.first?.notes,
      "Used for the setting, institutional roles, and gentle daily-life texture around Ptolemaic Alexandria."
    )
  }

  func testFixtureStoryUsesPersistentChaptersSourcesAndCoverArt() {
    let createdAt = Date(timeIntervalSince1970: 1_779_552_000)
    let persistentStory = PersistentStory(
      id: "story_generated_detail",
      title: "The Warm Kitchen",
      synopsis: "A quiet generated story in a Victorian kitchen.",
      kind: "daily_life",
      generationStatus: "completed",
      createdAt: createdAt,
      updatedAt: createdAt,
      durationSeconds: 2_940
    )
    persistentStory.assets = [
      PersistentAsset(
        id: "asset_audio",
        kind: "audio",
        remoteURLString: "https://media.example.com/story/audio.wav",
        mimeType: "audio/wav",
        createdAt: createdAt,
        story: persistentStory
      ),
      PersistentAsset(
        id: "asset_cover_full",
        kind: "cover_full",
        remoteURLString: "https://media.example.com/story/cover-full.png",
        mimeType: "image/png",
        createdAt: createdAt,
        story: persistentStory
      ),
      PersistentAsset(
        id: "asset_cover_thumb",
        kind: "cover_thumbnail",
        remoteURLString: "https://media.example.com/story/cover-thumb.png",
        localFileName: "cover-thumb.png",
        mimeType: "image/png",
        createdAt: createdAt,
        story: persistentStory
      )
    ]
    persistentStory.chapters = [
      PersistentChapter(
        id: "chapter_02",
        index: 2,
        title: "The Copper Pans Warm",
        summary: "The kitchen settles into work.",
        estimatedDurationSeconds: 420,
        transcript: "You hear the copper pans settle over a low flame.",
        sourceIDs: ["source_01"],
        story: persistentStory
      )
    ]
    persistentStory.sources = [
      PersistentSource(
        id: "source_01",
        title: "Victorian Household Management",
        urlString: "https://example.com/victorian-household",
        publisher: "Fixture Archive",
        notes: "Used for kitchen routines.",
        story: persistentStory
      )
    ]

    let story = FixtureStory(persistentStory: persistentStory)

    XCTAssertEqual(story.transcriptSections.map(\.title), ["Chapter 2: The Copper Pans Warm"])
    XCTAssertEqual(story.transcriptSections.first?.text, "You hear the copper pans settle over a low flame.")
    XCTAssertEqual(story.sourceLinks.first?.title, "Victorian Household Management")
    XCTAssertEqual(story.sourceLinks.first?.publisher, "Fixture Archive")
    XCTAssertEqual(story.sourceLinks.first?.url?.absoluteString, "https://example.com/victorian-household")
    XCTAssertEqual(
      story.sourceLinks.first?.displayContext,
      "Used for kitchen routines."
    )
    XCTAssertEqual(story.coverRemoteURLString, "https://media.example.com/story/cover-thumb.png")
    XCTAssertEqual(story.coverLocalFileName, "cover-thumb.png")
    XCTAssertEqual(story.symbol, "book.closed.fill")
  }

  func testFixtureStoryUsesConsistentBookArtworkSymbolForGeneratedStories() {
    let createdAt = Date(timeIntervalSince1970: 1_779_552_000)
    let lanternStory = PersistentStory(
      id: "story_lantern_maker",
      title: "A Lantern Maker in Ottoman Istanbul",
      synopsis: "A quiet generated story about a craftsperson.",
      kind: "daily_life",
      generationStatus: "completed",
      createdAt: createdAt,
      updatedAt: createdAt,
      durationSeconds: 3_600
    )

    let fixture = FixtureStory(persistentStory: lanternStory)

    XCTAssertEqual(fixture.symbol, "book.closed.fill")
    XCTAssertNotEqual(fixture.symbol, "fork.knife")
  }

  func testFullMockModePersistsGeneratedStyleCoverArtwork() throws {
    let temporaryDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer {
      try? FileManager.default.removeItem(at: temporaryDirectory)
    }

    var draft = CreateStoryDraft()
    draft.subject = "A lantern maker in Ottoman Istanbul"
    let story = try FullMockMode.makePersistentStory(
      from: draft,
      localAssetsDirectory: temporaryDirectory,
      audioDurationSeconds: 1
    )

    let coverAsset = try XCTUnwrap(story.assets.first { $0.kind == "coverImage" })
    let coverFileName = try XCTUnwrap(coverAsset.localFileName)
    let coverURL = temporaryDirectory.appendingPathComponent(coverFileName)

    XCTAssertEqual(coverAsset.mimeType, "image/png")
    XCTAssertTrue(FileManager.default.fileExists(atPath: coverURL.path(percentEncoded: false)))
    XCTAssertGreaterThan(coverAsset.byteCount ?? 0, 0)
  }

  func testSourceLinksProvideReadableContextWhenProviderOnlySendsATitle() {
    let source = FixtureSourceLink(
      title: "The Country House Servant",
      publisher: "Gemini grounded research",
      url: URL(string: "https://archive.example.org/country-house-servant"),
      notes: nil,
      retrievedAt: "2026-05-27T21:00:00Z"
    )

    XCTAssertEqual(source.locationLabel, "archive.example.org")
    XCTAssertTrue(source.displayContext.contains("Research citation"))
    XCTAssertTrue(source.displayContext.contains("archive.example.org"))
    XCTAssertEqual(source.retrievalLabel, "Retrieved 2026-05-27T21:00:00Z")
  }

  func testAppConfigurationReadsOnlyAPIBaseURLFromBundleInfo() throws {
    let configuration = try AppConfiguration(infoDictionary: [
      AppConfiguration.apiBaseURLInfoKey: "http://127.0.0.1:8787"
    ])

    XCTAssertEqual(configuration.apiBaseURL.absoluteString, "http://127.0.0.1:8787")
  }

  func testAppConfigurationRejectsMissingOrInvalidBaseURL() {
    XCTAssertThrowsError(try AppConfiguration(infoDictionary: [:])) { error in
      XCTAssertEqual(error as? AppConfigurationError, .missingAPIBaseURL)
    }

    XCTAssertThrowsError(try AppConfiguration(infoDictionary: [
      AppConfiguration.apiBaseURLInfoKey: "not a url"
    ])) { error in
      XCTAssertEqual(error as? AppConfigurationError, .invalidAPIBaseURL("not a url"))
    }
  }

  func testEnrollmentTokenStoreAbstractionPersistsAndDeletesToken() throws {
    let store = InMemoryEnrollmentTokenStore()

    XCTAssertNil(try store.readToken())

    try store.saveToken("enrollment-token-from-backend")
    XCTAssertEqual(try store.readToken(), "enrollment-token-from-backend")

    try store.deleteToken()
    XCTAssertNil(try store.readToken())
  }

  @MainActor
  func testSwiftDataPersistsGeneratedStoryAcrossContainerRecreation() throws {
    let temporaryDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let storeURL = temporaryDirectory.appendingPathComponent("SleepyHistory.store")

    defer {
      try? FileManager.default.removeItem(at: temporaryDirectory)
    }

    let createdAt = Date(timeIntervalSince1970: 1_779_552_000)
    let updatedAt = Date(timeIntervalSince1970: 1_779_555_600)
    let firstLaunchContainer = try PersistenceContainerFactory.makeDiskContainer(at: storeURL)
    let firstLaunchContext = firstLaunchContainer.mainContext

    let story = PersistentStory(
      id: "story_abbasid_observatory",
      title: "A Quiet Night at the Abbasid Observatory",
      synopsis: "A generated bedtime history about stargazing, careful records, and lantern light.",
      kind: "daily-life",
      generationStatus: "completed",
      createdAt: createdAt,
      updatedAt: updatedAt,
      durationSeconds: 3_720
    )

    story.assets = [
      PersistentAsset(
        id: "asset_audio_story_abbasid_observatory",
        kind: "audio",
        remoteURLString: "https://example.com/stories/abbasid-observatory/audio.m4a",
        localFileName: "abbasid-observatory.m4a",
        mimeType: "audio/mp4",
        byteCount: 42_000_000,
        createdAt: createdAt
      ),
      PersistentAsset(
        id: "asset_cover_story_abbasid_observatory",
        kind: "coverImage",
        remoteURLString: "https://example.com/stories/abbasid-observatory/cover.png",
        localFileName: "abbasid-observatory-cover.png",
        mimeType: "image/png",
        byteCount: 240_000,
        createdAt: createdAt
      )
    ]
    story.chapters = [
      PersistentChapter(
        id: "chapter_story_abbasid_observatory_03",
        index: 3,
        title: "The First Star Chart",
        summary: "A careful chart is checked.",
        estimatedDurationSeconds: 600,
        transcript: "The first star chart is turned beneath the lamplight.",
        sourceIDs: ["source_story_abbasid_observatory"],
        story: story
      )
    ]
    story.sources = [
      PersistentSource(
        id: "source_story_abbasid_observatory",
        title: "Astronomy in the Abbasid Caliphate",
        urlString: "https://example.com/abbasid-astronomy",
        publisher: "Fixture Archive",
        notes: "Fixture source notes.",
        story: story
      )
    ]

    story.bookmarks = [
      PersistentBookmark(
        id: "bookmark_story_abbasid_observatory_first_star",
        chapterID: "chapter_03",
        positionSeconds: 1_245,
        note: "Return to the first star chart.",
        createdAt: updatedAt
      )
    ]

    story.state = PersistentStoryState(
      storyID: story.id,
      isFavorite: true,
      isDownloaded: true,
      downloadedAt: updatedAt,
      playbackPositionSeconds: 1_502,
      playbackDurationSeconds: story.durationSeconds,
      playbackChapterID: "chapter_03",
      lastPlayedAt: updatedAt,
      updatedAt: updatedAt
    )

    firstLaunchContext.insert(story)
    try firstLaunchContext.save()

    let relaunchedContainer = try PersistenceContainerFactory.makeDiskContainer(at: storeURL)
    let relaunchedContext = relaunchedContainer.mainContext
    var descriptor = FetchDescriptor<PersistentStory>(
      predicate: #Predicate { $0.id == "story_abbasid_observatory" }
    )
    descriptor.relationshipKeyPathsForPrefetching = [
      \.assets,
      \.bookmarks,
      \.chapters,
      \.sources,
      \.state
    ]

    let persistedStories = try relaunchedContext.fetch(descriptor)
    XCTAssertEqual(persistedStories.count, 1)

    let persistedStory = try XCTUnwrap(persistedStories.first)
    XCTAssertEqual(persistedStory.title, "A Quiet Night at the Abbasid Observatory")
    XCTAssertEqual(persistedStory.generationStatus, "completed")
    XCTAssertEqual(persistedStory.durationSeconds, 3_720)

    let assetsByKind = Dictionary(uniqueKeysWithValues: persistedStory.assets.map { ($0.kind, $0) })
    XCTAssertEqual(assetsByKind["audio"]?.localFileName, "abbasid-observatory.m4a")
    XCTAssertEqual(assetsByKind["audio"]?.byteCount, 42_000_000)
    XCTAssertEqual(assetsByKind["coverImage"]?.mimeType, "image/png")

    let bookmark = try XCTUnwrap(persistedStory.bookmarks.first)
    XCTAssertEqual(bookmark.chapterID, "chapter_03")
    XCTAssertEqual(bookmark.positionSeconds, 1_245)
    XCTAssertEqual(bookmark.note, "Return to the first star chart.")

    let chapter = try XCTUnwrap(persistedStory.chapters.first)
    XCTAssertEqual(chapter.title, "The First Star Chart")
    XCTAssertEqual(chapter.sourceIDs, ["source_story_abbasid_observatory"])

    let source = try XCTUnwrap(persistedStory.sources.first)
    XCTAssertEqual(source.title, "Astronomy in the Abbasid Caliphate")
    XCTAssertEqual(source.urlString, "https://example.com/abbasid-astronomy")

    let state = try XCTUnwrap(persistedStory.state)
    XCTAssertTrue(state.isFavorite)
    XCTAssertTrue(state.isDownloaded)
    XCTAssertEqual(state.playbackPositionSeconds, 1_502)
    XCTAssertEqual(state.playbackDurationSeconds, 3_720)
    XCTAssertEqual(state.playbackChapterID, "chapter_03")
    XCTAssertEqual(state.lastPlayedAt, updatedAt)
  }
}

private final class InMemoryEnrollmentTokenStore: EnrollmentTokenStore {
  private var token: String?

  func readToken() throws -> String? {
    token
  }

  func saveToken(_ token: String) throws {
    self.token = token
  }

  func deleteToken() throws {
    token = nil
  }
}
