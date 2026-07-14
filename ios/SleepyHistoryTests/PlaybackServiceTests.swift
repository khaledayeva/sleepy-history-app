import Foundation
import SwiftData
import XCTest
@testable import SleepyHistory

@MainActor
final class PlaybackServiceTests: XCTestCase {
  func testLoadsAndPlaysRemoteAudioWithoutNetwork() throws {
    let engine = FakePlaybackEngine()
    let service = makeService(engine: engine)
    let story = makeStory(
      id: "story_remote",
      durationSeconds: 1_200,
      audioAsset: PersistentAsset(
        id: "asset_remote_audio",
        kind: "audio",
        remoteURLString: "https://media.example.com/story-remote.m4a",
        mimeType: "audio/mp4",
        createdAt: Self.referenceDate
      )
    )

    try service.load(story: story)
    try service.play()

    XCTAssertEqual(engine.currentSource?.kind, .remote)
    XCTAssertEqual(engine.currentSource?.url.absoluteString, "https://media.example.com/story-remote.m4a")
    XCTAssertEqual(engine.loadRequests.count, 1)
    XCTAssertTrue(engine.didPlay)
    XCTAssertEqual(service.state.status, .playing)
  }

  func testPrefersLocalAudioWhenLocalFileNameAndAssetDirectoryExist() throws {
    let engine = FakePlaybackEngine()
    let service = makeService(engine: engine)
    let temporaryDirectory = makeTemporaryDirectory()
    let localAssetDirectory = temporaryDirectory.appendingPathComponent("audio", isDirectory: true)
    try FileManager.default.createDirectory(
      at: localAssetDirectory,
      withIntermediateDirectories: true
    )
    try Data().write(to: localAssetDirectory.appendingPathComponent("story-local.m4a"))
    let story = makeStory(
      id: "story_local",
      durationSeconds: 900,
      audioAsset: PersistentAsset(
        id: "asset_local_audio",
        kind: "audio",
        remoteURLString: "https://media.example.com/story-local.m4a",
        localFileName: "story-local.m4a",
        mimeType: "audio/mp4",
        createdAt: Self.referenceDate
      )
    )

    try service.load(story: story, localAssetsDirectory: localAssetDirectory)

    XCTAssertEqual(engine.currentSource?.kind, .localFile)
    XCTAssertEqual(engine.currentSource?.url, localAssetDirectory.appendingPathComponent("story-local.m4a"))
  }

  func testFullMockModeCreatesLocalPlayableStoryWithoutNetwork() throws {
    let engine = FakePlaybackEngine()
    let service = makeService(engine: engine)
    let temporaryDirectory = makeTemporaryDirectory()
    let localAssetDirectory = temporaryDirectory.appendingPathComponent("mock-assets", isDirectory: true)
    var draft = CreateStoryDraft()
    draft.subject = "a quiet market scribe"
    draft.durationMinutes = 60

    let story = try FullMockMode.makePersistentStory(
      from: draft,
      localAssetsDirectory: localAssetDirectory,
      now: Self.referenceDate,
      audioDurationSeconds: 2
    )

    let audioAsset = try XCTUnwrap(story.assets.first { $0.kind == "audio" })
    XCTAssertNil(audioAsset.remoteURLString)
    XCTAssertEqual(audioAsset.mimeType, "audio/wav")
    XCTAssertEqual(story.generationStatus, "completed")
    XCTAssertEqual(story.state?.isDownloaded, true)
    XCTAssertEqual(story.durationSeconds, 3_600)
    let audioFileName = try XCTUnwrap(audioAsset.localFileName)
    let audioURL = localAssetDirectory.appendingPathComponent(audioFileName)
    let audioData = try Data(contentsOf: audioURL)
    let audioResourceValues = try audioURL.resourceValues(forKeys: [.isExcludedFromBackupKey])
    XCTAssertTrue(audioData.starts(with: Data("RIFF".utf8)))
    XCTAssertTrue(audioData.dropFirst(44).contains { $0 != 0 })
    XCTAssertEqual(audioResourceValues.isExcludedFromBackup, true)

    try service.play(story: story, localAssetsDirectory: localAssetDirectory)

    XCTAssertEqual(engine.currentSource?.kind, .localFile)
    XCTAssertTrue(engine.didPlay)
    XCTAssertEqual(service.state.status, .playing)
    XCTAssertEqual(service.state.durationSeconds, 3_600)
  }

  func testProgressUsesActualEngineDurationWhenItBecomesAvailable() throws {
    let engine = FakePlaybackEngine()
    let remote = FakeRemotePlaybackController()
    var now = Self.referenceDate
    let service = makeService(engine: engine, remoteController: remote, now: { now })
    let story = makeStory(id: "story_actual_duration", durationSeconds: 3_600)

    try service.load(story: story)
    try service.play()
    now = now.addingTimeInterval(11)
    engine.emitProgress(positionSeconds: 90, durationSeconds: 600, isPlaying: true)

    XCTAssertEqual(service.state.durationSeconds, 600)
    XCTAssertEqual(service.state.progress, 0.15, accuracy: 0.000_001)
    XCTAssertEqual(remote.metadataUpdates.last?.durationSeconds, 600)
  }

  func testSeekUsesClampedAccurateTargetAndPersistsPosition() throws {
    let engine = FakePlaybackEngine()
    let positionStore = InMemoryPlaybackPositionStore()
    let service = makeService(engine: engine, positionStore: positionStore)
    let story = makeStory(id: "story_seek", durationSeconds: 300)

    try service.load(story: story)
    try service.seek(to: 127.5)

    XCTAssertEqual(engine.seekRequests.last, 127.5)
    XCTAssertEqual(service.state.positionSeconds, 127.5)
    XCTAssertEqual(positionStore.persistedPositions.last?.storyID, "story_seek")
    XCTAssertEqual(positionStore.persistedPositions.last?.positionSeconds, 127.5)

    try service.seek(to: 500)

    XCTAssertEqual(engine.seekRequests.last, 300)
    XCTAssertEqual(service.state.positionSeconds, 300)
  }

  func testProgressUpdatesStateAndPersistsPlaybackPosition() throws {
    let engine = FakePlaybackEngine()
    let positionStore = InMemoryPlaybackPositionStore()
    var now = Self.referenceDate
    let service = makeService(engine: engine, positionStore: positionStore, now: { now })
    let story = makeStory(id: "story_progress", durationSeconds: 600)

    try service.load(story: story)
    try service.play()
    now = now.addingTimeInterval(16)
    engine.emitProgress(positionSeconds: 150, durationSeconds: 600, isPlaying: true)

    XCTAssertEqual(service.state.status, .playing)
    XCTAssertEqual(service.state.positionSeconds, 150)
    XCTAssertEqual(service.state.durationSeconds, 600)
    XCTAssertEqual(service.state.progress, 0.25, accuracy: 0.000_001)
    XCTAssertEqual(positionStore.persistedPositions.last?.positionSeconds, 150)
  }

  func testContinuousPlaybackProgressThrottlesPersistenceAndNowPlayingUpdates() throws {
    let engine = FakePlaybackEngine()
    let positionStore = InMemoryPlaybackPositionStore()
    let remote = FakeRemotePlaybackController()
    var now = Self.referenceDate
    let service = makeService(
      engine: engine,
      positionStore: positionStore,
      remoteController: remote,
      now: { now }
    )
    let story = makeStory(id: "story_background_progress", durationSeconds: 3_600)

    try service.load(story: story)
    try service.play()
    let initialPersistCount = positionStore.persistedPositions.count
    let initialMetadataCount = remote.metadataUpdates.count

    now = now.addingTimeInterval(4)
    engine.emitProgress(positionSeconds: 4, durationSeconds: 3_600, isPlaying: true)
    now = now.addingTimeInterval(4)
    engine.emitProgress(positionSeconds: 8, durationSeconds: 3_600, isPlaying: true)

    XCTAssertEqual(service.state.positionSeconds, 8)
    XCTAssertEqual(positionStore.persistedPositions.count, initialPersistCount)
    XCTAssertEqual(remote.metadataUpdates.count, initialMetadataCount)

    now = now.addingTimeInterval(8)
    engine.emitProgress(positionSeconds: 16, durationSeconds: 3_600, isPlaying: true)

    XCTAssertEqual(positionStore.persistedPositions.last?.positionSeconds, 16)
    XCTAssertEqual(remote.metadataUpdates.last?.positionSeconds, 16)
  }

  func testFinishedProgressEndsPlaybackAndDeactivatesAudioSession() throws {
    let engine = FakePlaybackEngine()
    let audioSession = FakePlaybackAudioSessionManager()
    let positionStore = InMemoryPlaybackPositionStore()
    let remote = FakeRemotePlaybackController()
    let service = makeService(
      engine: engine,
      positionStore: positionStore,
      audioSessionManager: audioSession,
      remoteController: remote
    )
    let story = makeStory(id: "story_finished", durationSeconds: 600)

    try service.load(story: story)
    try service.play()
    engine.emitProgress(positionSeconds: 600, durationSeconds: 600, isPlaying: false, didFinish: true)

    XCTAssertEqual(service.state.status, .ended)
    XCTAssertEqual(service.state.positionSeconds, 600)
    XCTAssertEqual(positionStore.persistedPositions.last?.positionSeconds, 600)
    XCTAssertEqual(remote.metadataUpdates.last?.positionSeconds, 600)
    XCTAssertEqual(audioSession.setActiveRequests, [true, false])
  }

  func testFailedProgressMarksPlaybackFailureAndDeactivatesAudioSession() throws {
    let engine = FakePlaybackEngine()
    let audioSession = FakePlaybackAudioSessionManager()
    let positionStore = InMemoryPlaybackPositionStore()
    let remote = FakeRemotePlaybackController()
    let service = makeService(
      engine: engine,
      positionStore: positionStore,
      audioSessionManager: audioSession,
      remoteController: remote
    )
    let story = makeStory(id: "story_failed", durationSeconds: 600)

    try service.load(story: story)
    try service.play()
    engine.emitProgress(
      positionSeconds: 32,
      durationSeconds: 600,
      isPlaying: false,
      failureMessage: "Remote audio stalled."
    )

    XCTAssertEqual(service.state.status, .failed("Remote audio stalled."))
    XCTAssertEqual(service.state.positionSeconds, 32)
    XCTAssertEqual(positionStore.persistedPositions.last?.positionSeconds, 32)
    XCTAssertEqual(remote.metadataUpdates.last?.positionSeconds, 32)
    XCTAssertEqual(audioSession.setActiveRequests, [true, false])
  }

  func testLoadsSavedPositionBeforePlayback() throws {
    let engine = FakePlaybackEngine()
    let positionStore = InMemoryPlaybackPositionStore(savedPositions: [
      "story_resume": PlaybackPosition(
        storyID: "story_resume",
        positionSeconds: 248,
        durationSeconds: 1_000,
        chapterID: "chapter_04"
      )
    ])
    let service = makeService(engine: engine, positionStore: positionStore)
    let story = makeStory(id: "story_resume", durationSeconds: 1_000)

    try service.load(story: story)

    XCTAssertEqual(engine.seekRequests.last, 248)
    XCTAssertEqual(service.state.positionSeconds, 248)
    XCTAssertEqual(service.state.chapterID, "chapter_04")
  }

  func testUsesPositionStoreAttachedAfterInitialization() throws {
    let engine = FakePlaybackEngine()
    let service = makeService(engine: engine)
    service.setPositionStore(
      InMemoryPlaybackPositionStore(savedPositions: [
        "story_late_store": PlaybackPosition(
          storyID: "story_late_store",
          positionSeconds: 420,
          durationSeconds: 1_200,
          chapterID: "chapter_05"
        )
      ])
    )
    let story = makeStory(id: "story_late_store", durationSeconds: 1_200)

    try service.load(story: story)

    XCTAssertEqual(engine.seekRequests.last, 420)
    XCTAssertEqual(service.state.positionSeconds, 420)
    XCTAssertEqual(service.state.progress, 0.35, accuracy: 0.000_001)
    XCTAssertEqual(service.state.chapterID, "chapter_05")
  }

  func testSwiftDataStorePersistsServicePlaybackPositionAcrossContainerRecreation() throws {
    let temporaryDirectory = makeTemporaryDirectory()
    let storeURL = temporaryDirectory.appendingPathComponent("SleepyHistory.store")
    let firstContainer = try PersistenceContainerFactory.makeDiskContainer(at: storeURL)
    let firstContext = firstContainer.mainContext
    let story = makeStory(id: "story_swiftdata_position", durationSeconds: 1_800)
    firstContext.insert(story)
    try firstContext.save()

    let engine = FakePlaybackEngine()
    let store = SwiftDataPlaybackPositionStore(
      context: firstContext,
      now: { Self.referenceDate }
    )
    let service = makeService(
      engine: engine,
      positionStore: store,
      progressPersistenceIntervalSeconds: 0
    )

    try service.load(story: story)
    try service.play()
    engine.emitProgress(positionSeconds: 721.25, durationSeconds: 1_800, isPlaying: true)

    let relaunchedContainer = try PersistenceContainerFactory.makeDiskContainer(at: storeURL)
    let relaunchedContext = relaunchedContainer.mainContext
    var descriptor = FetchDescriptor<PersistentStory>(
      predicate: #Predicate { $0.id == "story_swiftdata_position" }
    )
    descriptor.relationshipKeyPathsForPrefetching = [\.state]

    let persistedStory = try XCTUnwrap(try relaunchedContext.fetch(descriptor).first)
    let persistedState = try XCTUnwrap(persistedStory.state)
    XCTAssertEqual(persistedState.playbackPositionSeconds, 721.25)
    XCTAssertEqual(persistedState.playbackDurationSeconds, 1_800)
    XCTAssertEqual(persistedState.lastPlayedAt, Self.referenceDate)
  }

  func testConfiguresBackgroundAudioSessionAndRemoteMetadata() throws {
    let engine = FakePlaybackEngine()
    let audioSession = FakePlaybackAudioSessionManager()
    let remote = FakeRemotePlaybackController()
    let service = makeService(
      engine: engine,
      audioSessionManager: audioSession,
      remoteController: remote
    )
    let story = makeStory(id: "story_background", durationSeconds: 1_500)

    try service.load(story: story)
    try service.play()

    XCTAssertEqual(audioSession.didConfigureForBackgroundPlaybackCount, 1)
    XCTAssertEqual(audioSession.setActiveRequests, [true])
    XCTAssertEqual(remote.metadataUpdates.last?.title, "Quiet History")
    XCTAssertEqual(remote.metadataUpdates.last?.durationSeconds, 1_500)
    XCTAssertEqual(remote.metadataUpdates.last?.playbackRate, 1)
  }

  func testInterruptionPausesAndResumesOnlyWhenPlaybackWasActive() throws {
    let engine = FakePlaybackEngine()
    let service = makeService(engine: engine)
    let story = makeStory(id: "story_interruption", durationSeconds: 600)

    try service.load(story: story)
    try service.play()

    service.handleInterruption(.began)

    XCTAssertTrue(engine.didPause)
    XCTAssertEqual(service.state.status, .paused)

    engine.didPlay = false
    service.handleInterruption(.ended(shouldResume: true))

    XCTAssertTrue(engine.didPlay)
    XCTAssertEqual(service.state.status, .playing)

    try service.pause()
    engine.didPlay = false
    service.handleInterruption(.began)
    service.handleInterruption(.ended(shouldResume: true))

    XCTAssertFalse(engine.didPlay)
  }

  func testRemoteCommandsDrivePlaybackControls() throws {
    let engine = FakePlaybackEngine()
    let remote = FakeRemotePlaybackController()
    let service = makeService(engine: engine, remoteController: remote)
    let story = makeStory(id: "story_remote_commands", durationSeconds: 300)

    try service.load(story: story)
    try service.seek(to: 120)

    XCTAssertEqual(remote.handlers?.skipForward(), .success)
    XCTAssertEqual(engine.seekRequests.last, 135)

    XCTAssertEqual(remote.handlers?.skipBackward(), .success)
    XCTAssertEqual(engine.seekRequests.last, 120)

    XCTAssertEqual(remote.handlers?.seek(42), .success)
    XCTAssertEqual(engine.seekRequests.last, 42)

    XCTAssertEqual(remote.handlers?.changePlaybackRate(1.25), .success)
    XCTAssertEqual(engine.playbackRate, 1.25)
    XCTAssertEqual(service.state.playbackRate, 1.25)

    XCTAssertEqual(remote.handlers?.togglePlayPause(), .success)
    XCTAssertTrue(engine.didPlay)
    XCTAssertEqual(service.state.status, .playing)

    XCTAssertEqual(remote.handlers?.togglePlayPause(), .success)
    XCTAssertTrue(engine.didPause)
    XCTAssertEqual(service.state.status, .paused)
  }

  func testSleepTimerStopsPlaybackAndCanBeCanceled() throws {
    let engine = FakePlaybackEngine()
    let sleepTimer = FakeSleepTimerScheduler()
    let service = makeService(engine: engine, sleepTimerScheduler: sleepTimer)
    let story = makeStory(id: "story_sleep_timer", durationSeconds: 900)

    try service.load(story: story)
    try service.play()
    try service.startSleepTimer(durationSeconds: 120)

    XCTAssertEqual(sleepTimer.scheduledSeconds, 120)
    XCTAssertEqual(
      service.state.sleepTimer,
      .scheduled(
        endsAt: Self.referenceDate.addingTimeInterval(120),
        durationSeconds: 120
      )
    )

    sleepTimer.fire()

    XCTAssertTrue(engine.didPause)
    XCTAssertEqual(service.state.status, .paused)
    XCTAssertEqual(service.state.sleepTimer, .inactive)

    try service.startSleepTimer(durationSeconds: 60)
    service.cancelSleepTimer()

    XCTAssertTrue(sleepTimer.didCancel)
    XCTAssertEqual(service.state.sleepTimer, .inactive)
  }

  func testSpeedControlUpdatesEngineAndNowPlayingMetadata() throws {
    let engine = FakePlaybackEngine()
    let remote = FakeRemotePlaybackController()
    let service = makeService(engine: engine, remoteController: remote)
    let story = makeStory(id: "story_speed", durationSeconds: 720)

    try service.load(story: story)
    try service.play()
    try service.setPlaybackRate(1.5)

    XCTAssertEqual(engine.playbackRate, 1.5)
    XCTAssertEqual(service.state.playbackRate, 1.5)
    XCTAssertEqual(remote.metadataUpdates.last?.defaultPlaybackRate, 1.5)
    XCTAssertEqual(remote.metadataUpdates.last?.playbackRate, 1.5)
  }

  func testCreatesBookmarkAndPersistsWithSwiftDataStore() throws {
    let temporaryDirectory = makeTemporaryDirectory()
    let storeURL = temporaryDirectory.appendingPathComponent("SleepyHistory.store")
    let container = try PersistenceContainerFactory.makeDiskContainer(at: storeURL)
    let context = container.mainContext
    let story = makeStory(id: "story_bookmark", durationSeconds: 1_800)
    context.insert(story)
    try context.save()

    let engine = FakePlaybackEngine()
    let bookmarkStore = SwiftDataPlaybackBookmarkStore(context: context)
    let service = makeService(
      engine: engine,
      bookmarkStore: bookmarkStore,
      makeBookmarkID: { "bookmark_fixed" }
    )

    try service.load(story: story)
    try service.seek(to: 444)
    let bookmark = try service.createBookmark(note: "The candlelit archive.")

    XCTAssertEqual(bookmark.id, "bookmark_fixed")
    XCTAssertEqual(bookmark.storyID, "story_bookmark")
    XCTAssertEqual(bookmark.positionSeconds, 444)

    let relaunchedContainer = try PersistenceContainerFactory.makeDiskContainer(at: storeURL)
    let relaunchedContext = relaunchedContainer.mainContext
    var descriptor = FetchDescriptor<PersistentStory>(
      predicate: #Predicate { $0.id == "story_bookmark" }
    )
    descriptor.relationshipKeyPathsForPrefetching = [\.bookmarks]

    let persistedStory = try XCTUnwrap(try relaunchedContext.fetch(descriptor).first)
    let persistedBookmark = try XCTUnwrap(persistedStory.bookmarks.first)
    XCTAssertEqual(persistedBookmark.id, "bookmark_fixed")
    XCTAssertEqual(persistedBookmark.positionSeconds, 444)
    XCTAssertEqual(persistedBookmark.note, "The candlelit archive.")
  }

  private func makeStory(
    id: String,
    durationSeconds: TimeInterval,
    audioAsset: PersistentAsset? = nil
  ) -> PersistentStory {
    let story = PersistentStory(
      id: id,
      title: "Quiet History",
      synopsis: "A calm fixture story.",
      kind: "daily-life",
      generationStatus: "completed",
      createdAt: Self.referenceDate,
      updatedAt: Self.referenceDate,
      durationSeconds: durationSeconds
    )
    story.assets = [
      audioAsset ?? PersistentAsset(
        id: "asset_\(id)_audio",
        kind: "audio",
        remoteURLString: "https://media.example.com/\(id).m4a",
        mimeType: "audio/mp4",
        createdAt: Self.referenceDate
      )
    ]

    return story
  }

  private func makeService(
    engine: PlaybackEngine,
    positionStore: PlaybackPositionPersisting? = nil,
    bookmarkStore: PlaybackBookmarkPersisting? = nil,
    audioSessionManager: PlaybackAudioSessionManaging? = nil,
    interruptionObserver: PlaybackInterruptionObserving? = nil,
    remoteController: RemotePlaybackControlling? = nil,
    sleepTimerScheduler: SleepTimerScheduling? = nil,
    now: @escaping () -> Date = { PlaybackServiceTests.referenceDate },
    makeBookmarkID: @escaping () -> String = { UUID().uuidString },
    progressPersistenceIntervalSeconds: TimeInterval = 15,
    nowPlayingProgressUpdateIntervalSeconds: TimeInterval = 10
  ) -> PlaybackService {
    PlaybackService(
      engine: engine,
      positionStore: positionStore,
      bookmarkStore: bookmarkStore,
      audioSessionManager: audioSessionManager ?? FakePlaybackAudioSessionManager(),
      interruptionObserver: interruptionObserver ?? FakePlaybackInterruptionObserver(),
      remoteController: remoteController ?? FakeRemotePlaybackController(),
      sleepTimerScheduler: sleepTimerScheduler ?? FakeSleepTimerScheduler(),
      now: now,
      makeBookmarkID: makeBookmarkID,
      progressPersistenceIntervalSeconds: progressPersistenceIntervalSeconds,
      nowPlayingProgressUpdateIntervalSeconds: nowPlayingProgressUpdateIntervalSeconds
    )
  }

  private func makeTemporaryDirectory() -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    addTeardownBlock {
      try? FileManager.default.removeItem(at: directory)
    }

    return directory
  }

  private static let referenceDate = Date(timeIntervalSince1970: 1_779_552_000)
}

@MainActor
private final class FakePlaybackEngine: PlaybackEngine {
  private var progressHandler: PlaybackProgressHandler?

  private(set) var currentSource: StoryAudioSource?
  private(set) var loadRequests: [StoryAudioSource] = []
  private(set) var seekRequests: [TimeInterval] = []
  var didPlay = false
  var didPause = false

  var positionSeconds: TimeInterval = 0
  var durationSeconds: TimeInterval = 0
  var isPlaying = false
  var playbackRate: Double = 1

  func load(_ source: StoryAudioSource) throws {
    currentSource = source
    loadRequests.append(source)
  }

  func play() throws {
    didPlay = true
    isPlaying = true
  }

  func pause() {
    didPause = true
    isPlaying = false
  }

  func seek(to seconds: TimeInterval) throws {
    positionSeconds = seconds
    seekRequests.append(seconds)
  }

  func setPlaybackRate(_ rate: Double) throws {
    playbackRate = rate
  }

  func setProgressHandler(_ handler: PlaybackProgressHandler?) {
    progressHandler = handler
  }

  func emitProgress(
    positionSeconds: TimeInterval,
    durationSeconds: TimeInterval,
    isPlaying: Bool,
    didFinish: Bool = false,
    failureMessage: String? = nil
  ) {
    self.positionSeconds = positionSeconds
    self.durationSeconds = durationSeconds
    self.isPlaying = isPlaying
    progressHandler?(
      PlaybackProgressSnapshot(
        positionSeconds: positionSeconds,
        durationSeconds: durationSeconds,
        isPlaying: isPlaying,
        didFinish: didFinish,
        failureMessage: failureMessage
      )
    )
  }
}

@MainActor
private final class FakePlaybackAudioSessionManager: PlaybackAudioSessionManaging {
  private(set) var didConfigureForBackgroundPlaybackCount = 0
  private(set) var setActiveRequests: [Bool] = []

  func configureForBackgroundPlayback() throws {
    didConfigureForBackgroundPlaybackCount += 1
  }

  func setActive(_ active: Bool) throws {
    setActiveRequests.append(active)
  }
}

@MainActor
private final class FakePlaybackInterruptionObserver: PlaybackInterruptionObserving {
  private(set) var handler: (@MainActor (PlaybackInterruptionEvent) -> Void)?

  func setHandler(_ handler: (@MainActor (PlaybackInterruptionEvent) -> Void)?) {
    self.handler = handler
  }

  func emit(_ event: PlaybackInterruptionEvent) {
    handler?(event)
  }
}

@MainActor
private final class FakeRemotePlaybackController: RemotePlaybackControlling {
  private(set) var handlers: PlaybackRemoteCommandHandlers?
  private(set) var metadataUpdates: [PlaybackNowPlayingMetadata] = []

  func configure(_ handlers: PlaybackRemoteCommandHandlers) {
    self.handlers = handlers
  }

  func update(_ metadata: PlaybackNowPlayingMetadata) {
    metadataUpdates.append(metadata)
  }
}

@MainActor
private final class FakeSleepTimerScheduler: SleepTimerScheduling {
  private(set) var scheduledSeconds: TimeInterval?
  private(set) var didCancel = false
  private var handler: (@MainActor () -> Void)?

  func schedule(after seconds: TimeInterval, handler: @escaping @MainActor () -> Void) {
    scheduledSeconds = seconds
    didCancel = false
    self.handler = handler
  }

  func cancel() {
    didCancel = true
    handler = nil
  }

  func fire() {
    let handler = handler
    self.handler = nil
    handler?()
  }
}

@MainActor
private final class InMemoryPlaybackPositionStore: PlaybackPositionPersisting {
  private var savedPositions: [String: PlaybackPosition]
  private(set) var persistedPositions: [PlaybackPosition] = []

  init(savedPositions: [String: PlaybackPosition] = [:]) {
    self.savedPositions = savedPositions
  }

  func savedPosition(for storyID: String) throws -> PlaybackPosition? {
    savedPositions[storyID]
  }

  func persist(_ position: PlaybackPosition) throws {
    savedPositions[position.storyID] = position
    persistedPositions.append(position)
  }
}
