import XCTest

@MainActor
final class SleepyHistorySmokeUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  func testSmokeNavigatesPrimaryTabsAndSheets() {
    let app = launchApp()

    XCTAssertTrue(app.buttons["Create a new bedtime story"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["mini-player-bar"].waitForExistence(timeout: 2))
    XCTAssertTrue((app.buttons["mini-player-bar"].value as? String)?.contains("/") == true)
    app.tabBars.buttons["Home"].tap()
    XCTAssertTrue(app.buttons["Create a new bedtime story"].waitForExistence(timeout: 2))

    app.tabBars.buttons["Library"].tap()
    XCTAssertTrue(app.otherElements["library-screen"].waitForExistence(timeout: 2))

    app.tabBars.buttons["Bookmarks"].tap()
    XCTAssertTrue(app.tabBars.buttons["Bookmarks"].isSelected)

    app.tabBars.buttons["Create"].tap()
    XCTAssertTrue(app.staticTexts["What you can make"].waitForExistence(timeout: 2))

    app.tabBars.buttons["Settings"].tap()
    XCTAssertTrue(app.staticTexts["Settings"].waitForExistence(timeout: 2))

    app.tabBars.buttons["Home"].tap()
    app.buttons["Create a new bedtime story"].tap()
    XCTAssertTrue(app.staticTexts["Story type"].waitForExistence(timeout: 2))
    app.navigationBars.buttons["Close"].tap()
    XCTAssertTrue(app.buttons["Create a new bedtime story"].waitForExistence(timeout: 2))

    app.buttons["mini-player-bar"].tap()
    XCTAssertTrue(app.staticTexts["Now Playing"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.sliders["now-playing-progress-slider"].waitForExistence(timeout: 2))

    for _ in 0..<3 where !nowPlayingPlayPauseButtonExists(in: app) {
      app.swipeUp()
    }
    XCTAssertTrue(waitForNowPlayingPlayPauseButton(in: app))
    XCTAssertTrue(app.buttons["Transcript"].exists || app.buttons["View transcript"].exists || app.buttons["now-playing-transcript-action"].exists)
    XCTAssertTrue(app.buttons["Sources"].exists || app.buttons["View sources"].exists || app.buttons["now-playing-sources-action"].exists)
    for _ in 0..<5 where !nowPlayingDownloadButtonExists(in: app) {
      app.swipeUp()
    }
    XCTAssertTrue(nowPlayingDownloadButtonExists(in: app))

    for _ in 0..<3 where !app.buttons["now-playing-speed-menu"].exists {
      app.swipeUp()
    }
    XCTAssertTrue(app.buttons["now-playing-speed-menu"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.buttons["now-playing-timer-menu"].exists)
    XCTAssertTrue(app.buttons["now-playing-bookmark"].exists)

    for _ in 0..<3 where !app.buttons["now-playing-close"].exists {
      app.swipeDown()
    }
    app.buttons["now-playing-close"].tap()
    XCTAssertTrue(app.buttons["Create a new bedtime story"].waitForExistence(timeout: 2))
  }

  func testBookmarkToggleUpdatesBookmarksTab() {
    let app = launchApp()

    app.tabBars.buttons["Library"].tap()
    XCTAssertTrue(app.otherElements["library-screen"].waitForExistence(timeout: 2))

    filterLibraryForAlexandria(in: app)
    let addBookmarkButton = app.buttons["Add The Library at Alexandria to bookmarks"]
    for _ in 0..<3 where !addBookmarkButton.isHittable {
      app.swipeUp()
    }
    XCTAssertTrue(addBookmarkButton.waitForExistence(timeout: 2))
    addBookmarkButton.tap()
    app.tabBars.buttons["Bookmarks"].tap()

    XCTAssertTrue(app.otherElements["bookmarks-screen"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.staticTexts["The Library at Alexandria"].waitForExistence(timeout: 2))

    let swipeRow = app.descendants(matching: .any)["bookmark-swipe-row-story_full_length_acceptance"]
    XCTAssertTrue(swipeRow.waitForExistence(timeout: 2))
    swipeRow.swipeLeft()
    swipeRow.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
    XCTAssertTrue(app.staticTexts["No bookmarks yet"].waitForExistence(timeout: 2))

    app.tabBars.buttons["Library"].tap()
    filterLibraryForAlexandria(in: app)
    XCTAssertTrue(addBookmarkButton.waitForExistence(timeout: 2))
    addBookmarkButton.tap()
    app.tabBars.buttons["Bookmarks"].tap()
    XCTAssertTrue(app.staticTexts["The Library at Alexandria"].waitForExistence(timeout: 2))

    app.buttons["Remove The Library at Alexandria from bookmarks"].tap()
    XCTAssertTrue(app.staticTexts["No bookmarks yet"].waitForExistence(timeout: 2))
    XCTAssertFalse(app.buttons["Remove The Library at Alexandria from bookmarks"].exists)
  }

  func testAIProviderDisclosureBlocksFirstGenerationUntilAccepted() {
    let app = launchApp()

    XCTAssertTrue(app.buttons["Create a new bedtime story"].waitForExistence(timeout: 5))
    app.buttons["Create a new bedtime story"].tap()
    XCTAssertTrue(app.staticTexts["Story type"].waitForExistence(timeout: 2))

    tapCreateStorySubmit(in: app)
    XCTAssertTrue(app.staticTexts["AI and provider disclosure"].waitForExistence(timeout: 2))
    XCTAssertFalse(app.otherElements["library-screen"].exists)

    app.buttons["ai-provider-disclosure-cancel"].tap()
    XCTAssertTrue(app.buttons["create-story-submit"].waitForExistence(timeout: 2))

    tapCreateStorySubmit(in: app)
    XCTAssertTrue(app.staticTexts["AI and provider disclosure"].waitForExistence(timeout: 2))
    app.buttons["ai-provider-disclosure-continue"].tap()

    XCTAssertTrue(app.otherElements["library-screen"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.staticTexts["Generation Queue"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.staticTexts["generation-job-message-completed-mock-story-a-lantern-maker-in-ottoman-istanbul"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.staticTexts["A Lantern Maker in Ottoman Istanbul"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.descendants(matching: .any)["story-artwork-a-lantern-maker-in-ottoman-istanbul"].exists)

    app.buttons["library-filter-downloaded"].tap()
    XCTAssertTrue(app.staticTexts["A Lantern Maker in Ottoman Istanbul"].waitForExistence(timeout: 2))

    app.buttons["library-filter-failed"].tap()
    XCTAssertTrue(app.staticTexts["No matching stories"].waitForExistence(timeout: 2))
  }

  func testStarterIdeaOpensCreateWithPrefilledDetails() {
    let app = launchApp()

    XCTAssertTrue(app.buttons["Create a new bedtime story"].waitForExistence(timeout: 5))
    let starterIdea = app.buttons["starter-idea-victorian-kitchen"]
    for _ in 0..<5 where !starterIdea.exists {
      app.swipeUp()
    }
    XCTAssertTrue(starterIdea.waitForExistence(timeout: 2))
    starterIdea.tap()

    XCTAssertTrue(app.staticTexts["Story type"].waitForExistence(timeout: 2))
    XCTAssertEqual(app.textFields["create-story-field-subject"].value as? String, "A talented assistant chef in Victorian England")
    XCTAssertEqual(app.textFields["create-story-field-location"].value as? String, "England")
    XCTAssertEqual(app.staticTexts["$9.52"].waitForExistence(timeout: 2), true)
  }

  func testPlaybackContinuesAfterNowPlayingIsMinimized() {
    let app = launchApp()

    createMockGeneratedStory(in: app)

    let playGeneratedStory = app.buttons["Play A Lantern Maker in Ottoman Istanbul"]
    XCTAssertTrue(playGeneratedStory.waitForExistence(timeout: 2))
    playGeneratedStory.tap()

    XCTAssertTrue(app.staticTexts["Now Playing"].waitForExistence(timeout: 2))
    XCTAssertTrue(waitForNowPlayingPlayPauseButton(in: app))
    nowPlayingPlayPauseButton(in: app).tap()
    XCTAssertTrue(app.buttons["Pause"].waitForExistence(timeout: 4))

    app.buttons["now-playing-close"].tap()
    let miniPlayer = app.buttons["mini-player-bar"]
    XCTAssertTrue(miniPlayer.waitForExistence(timeout: 2))
    XCTAssertEqual(miniPlayer.value as? String, "Playing")

    let miniToggle = app.buttons["mini-player-play-pause"]
    XCTAssertTrue(miniToggle.waitForExistence(timeout: 2))
    miniToggle.tap()
    XCTAssertNotEqual(miniToggle.value as? String, "Playing")
    miniToggle.tap()
    XCTAssertEqual(miniToggle.value as? String, "Playing")

    miniPlayer.tap()
    XCTAssertTrue(app.buttons["Pause"].waitForExistence(timeout: 2))
  }

  func testMiniPlayerPlayPauseStartsPlaybackWithoutOpeningSheet() {
    let app = launchApp()

    let miniToggle = app.buttons["mini-player-play-pause"]
    XCTAssertTrue(miniToggle.waitForExistence(timeout: 5))
    miniToggle.tap()
    XCTAssertEqual(miniToggle.value as? String, "Playing")
    XCTAssertFalse(app.staticTexts["Now Playing"].exists)

    miniToggle.tap()
    XCTAssertNotEqual(miniToggle.value as? String, "Playing")
    XCTAssertFalse(app.staticTexts["Now Playing"].exists)
  }

  func testPlaybackStaysActiveDuringExtendedMinimizedRun() {
    let app = launchApp()

    createMockGeneratedStory(in: app)

    let playGeneratedStory = app.buttons["Play A Lantern Maker in Ottoman Istanbul"]
    XCTAssertTrue(playGeneratedStory.waitForExistence(timeout: 2))
    playGeneratedStory.tap()

    XCTAssertTrue(app.staticTexts["Now Playing"].waitForExistence(timeout: 2))
    XCTAssertTrue(waitForNowPlayingPlayPauseButton(in: app))
    nowPlayingPlayPauseButton(in: app).tap()
    XCTAssertTrue(app.buttons["Pause"].waitForExistence(timeout: 4))

    app.buttons["now-playing-close"].tap()
    let miniPlayer = app.buttons["mini-player-bar"]
    XCTAssertTrue(miniPlayer.waitForExistence(timeout: 2))

    let deadline = Date().addingTimeInterval(65)
    while Date() < deadline {
      XCTAssertTrue(app.exists)
      XCTAssertEqual(miniPlayer.value as? String, "Playing")
      RunLoop.current.run(until: Date().addingTimeInterval(5))
    }

    XCTAssertEqual(miniPlayer.value as? String, "Playing")
  }

  func testProfileRowsNavigateToActionableDetailScreens() {
    let app = launchApp()

    XCTAssertTrue(app.buttons["Create a new bedtime story"].waitForExistence(timeout: 5))
    app.tabBars.buttons["Settings"].tap()
    XCTAssertTrue(app.staticTexts["Settings"].waitForExistence(timeout: 2))

    tapProfileRow("profile-row-downloads", expecting: "Downloads", in: app)
    tapProfileRow("profile-row-listeningHistory", expecting: "Listening History", in: app)
    tapProviderStatusRow(in: app)
    tapProfileRow("profile-row-privacy", expecting: "Privacy", in: app)

    let settingsRow = app.buttons["profile-row-settings"]
    for _ in 0..<5 where !settingsRow.exists {
      app.swipeUp()
    }
    XCTAssertTrue(settingsRow.waitForExistence(timeout: 2))
    settingsRow.tap()
    XCTAssertTrue(app.navigationBars["Enrollment"].waitForExistence(timeout: 2))

    XCTAssertTrue(app.textFields["settings-enrollment-code"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.buttons["Reset AI Disclosure"].exists || app.descendants(matching: .any)["settings-reset-disclosure"].exists)
    XCTAssertTrue(app.segmentedControls["settings-default-speed"].exists)
    XCTAssertTrue(app.segmentedControls["settings-default-sleep-timer"].exists)

    XCTAssertTrue(app.descendants(matching: .any)["settings-reset-disclosure"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["settings-clear-listening-history"].exists)
  }

  func testStoryDetailShowsTranscriptAndSources() {
    let app = launchApp()

    XCTAssertTrue(app.buttons["Create a new bedtime story"].waitForExistence(timeout: 5))
    app.tabBars.buttons["Library"].tap()
    XCTAssertTrue(app.otherElements["library-screen"].waitForExistence(timeout: 2))

    filterLibraryForAlexandria(in: app)
    for _ in 0..<4 where !alexandriaStoryRow(in: app).isHittable {
      app.swipeUp()
    }
    let storyRow = alexandriaStoryRow(in: app)
    XCTAssertTrue(storyRow.waitForExistence(timeout: 2))
    XCTAssertTrue(storyRow.isHittable)
    storyRow.tap()

    XCTAssertTrue(app.descendants(matching: .any)["story-detail-section-navigation"].waitForExistence(timeout: 2))
    app.buttons["story-detail-jump-transcript"].tap()
    XCTAssertTrue(app.staticTexts["Transcript"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.descendants(matching: .any)["story-detail-transcript-section"].exists)

    app.buttons["story-detail-jump-sources"].tap()
    XCTAssertTrue(app.staticTexts["Sources"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.descendants(matching: .any)["story-detail-sources-section"].exists)

    app.buttons["story-detail-jump-notes"].tap()
    XCTAssertTrue(app.staticTexts["Story Notes"].waitForExistence(timeout: 2))
  }

  private func tapProfileRow(_ identifier: String, expecting title: String, in app: XCUIApplication) {
    let row = app.buttons[identifier]
    for _ in 0..<5 where !row.exists {
      app.swipeUp()
    }
    XCTAssertTrue(row.waitForExistence(timeout: 2), "Missing \(identifier)")
    row.tap()

    XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 2), "Missing destination \(title)")
    let settingsBackButton = app.navigationBars.buttons["Settings"]
    if settingsBackButton.exists {
      settingsBackButton.tap()
    } else {
      app.navigationBars.buttons["Back"].tap()
    }
    XCTAssertTrue(app.staticTexts["Settings"].waitForExistence(timeout: 2))
  }

  private func tapProviderStatusRow(in app: XCUIApplication) {
    let row = app.buttons["profile-row-providerStatus"]
    for _ in 0..<5 where !row.exists {
      app.swipeUp()
    }
    XCTAssertTrue(row.waitForExistence(timeout: 2), "Missing profile-row-providerStatus")
    row.tap()

    XCTAssertTrue(app.navigationBars["Provider Status"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.descendants(matching: .any)["provider-status-provider-list"].waitForExistence(timeout: 2))
    for label in [
      "Backend hosting",
      "Object storage",
      "Research dossier",
      "Story writing",
      "Narration",
      "Cover art"
    ] {
      let element = app.staticTexts[label]
      _ = element.waitForExistence(timeout: 1)
      for _ in 0..<3 where !element.exists {
        app.swipeUp()
      }
      XCTAssertTrue(element.waitForExistence(timeout: 2), "Missing provider row \(label)")
    }
    XCTAssertTrue(app.staticTexts["Online"].exists)
    XCTAssertTrue(app.staticTexts["Credits depleted"].exists)
    XCTAssertTrue(app.staticTexts["Needs attention"].exists)
    XCTAssertTrue(app.staticTexts["Google Gemini · gemini-3.1-pro-preview"].exists)
    XCTAssertTrue(app.staticTexts["Anthropic Claude · claude-opus-4-6"].exists)
    XCTAssertTrue(app.staticTexts["API Keys"].exists)
    XCTAssertTrue(app.staticTexts["Billing"].exists)

    let settingsBackButton = app.navigationBars.buttons["Settings"]
    if settingsBackButton.exists {
      settingsBackButton.tap()
    } else {
      app.navigationBars.buttons["Back"].tap()
    }
    XCTAssertTrue(app.staticTexts["Settings"].waitForExistence(timeout: 2))
  }

  private func nowPlayingPlayPauseButtonExists(in app: XCUIApplication) -> Bool {
    app.buttons["now-playing-play-pause"].exists || app.buttons["Play"].exists || app.buttons["Pause"].exists
  }

  private func nowPlayingDownloadButtonExists(in app: XCUIApplication) -> Bool {
    let anyElement = app.descendants(matching: .any)
    return app.buttons["Download"].exists ||
      app.buttons["Download for offline listening"].exists ||
      app.buttons["Remove download"].exists ||
      app.buttons["now-playing-download-action"].exists ||
      anyElement["now-playing-download-action"].exists ||
      anyElement["now-playing-download-action-label"].exists ||
      anyElement["Download"].exists ||
      anyElement["Download for offline listening"].exists ||
      anyElement["Remove download"].exists
  }

  private func waitForNowPlayingPlayPauseButton(in app: XCUIApplication) -> Bool {
    if app.buttons["now-playing-play-pause"].waitForExistence(timeout: 1) {
      return true
    }

    if app.buttons["Play"].waitForExistence(timeout: 1) {
      return true
    }

    return app.buttons["Pause"].waitForExistence(timeout: 1)
  }

  private func nowPlayingPlayPauseButton(in app: XCUIApplication) -> XCUIElement {
    if app.buttons["now-playing-play-pause"].exists {
      return app.buttons["now-playing-play-pause"]
    }
    if app.buttons["Play"].exists {
      return app.buttons["Play"]
    }
    return app.buttons["Pause"]
  }

  private func createMockGeneratedStory(in app: XCUIApplication) {
    XCTAssertTrue(app.buttons["Create a new bedtime story"].waitForExistence(timeout: 5))
    app.buttons["Create a new bedtime story"].tap()
    XCTAssertTrue(app.staticTexts["Story type"].waitForExistence(timeout: 2))
    tapCreateStorySubmit(in: app)
    if app.staticTexts["AI and provider disclosure"].waitForExistence(timeout: 2) {
      app.buttons["ai-provider-disclosure-continue"].tap()
    }

    XCTAssertTrue(app.otherElements["library-screen"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.staticTexts["A Lantern Maker in Ottoman Istanbul"].waitForExistence(timeout: 2))
  }

  private func filterLibraryForAlexandria(in app: XCUIApplication) {
    let searchField = app.textFields["library-search-field"]
    XCTAssertTrue(searchField.waitForExistence(timeout: 2))
    if let value = searchField.value as? String,
       !value.isEmpty,
       value != "Search stories",
       app.buttons["Clear library search"].exists {
      app.buttons["Clear library search"].tap()
    }
    searchField.tap()
    searchField.typeText("Alexandria")
    if app.keyboards.buttons["Search"].exists {
      app.keyboards.buttons["Search"].tap()
    } else if app.keyboards.buttons["return"].exists {
      app.keyboards.buttons["return"].tap()
    }
    XCTAssertTrue(app.staticTexts["The Library at Alexandria"].waitForExistence(timeout: 2))
  }

  private func alexandriaStoryRow(in app: XCUIApplication) -> XCUIElement {
    let identifiedRow = app.buttons["story-row-story_full_length_acceptance"]
    if identifiedRow.exists {
      return identifiedRow
    }

    return app.buttons["Open details for The Library at Alexandria"]
  }

  private func tapCreateStorySubmit(in app: XCUIApplication) {
    let submitButton = app.buttons["create-story-submit"]
    XCTAssertTrue(submitButton.waitForExistence(timeout: 2))
    for _ in 0..<4 where !submitButton.isHittable {
      app.swipeUp()
    }
    XCTAssertTrue(submitButton.isHittable)
    submitButton.tap()
  }

  private func launchApp() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["--reset-ui-testing-state", "--use-mock-generation"]
    app.launch()
    return app
  }
}
