import AVFoundation
import Combine
import Foundation
import MediaPlayer
import SwiftData

enum PlaybackServiceError: Error, Equatable {
  case missingAudioAsset(storyID: String)
  case invalidAudioAsset(storyID: String)
  case noLoadedStory
  case invalidPlaybackRate(Double)
  case invalidSleepTimerDuration(TimeInterval)
  case bookmarkStoreUnavailable
}

@MainActor
final class PlaybackService: ObservableObject {
  @Published private(set) var state: PlaybackState

  private let engine: PlaybackEngine
  private var positionStore: PlaybackPositionPersisting?
  private var bookmarkStore: PlaybackBookmarkPersisting?
  private let audioSessionManager: PlaybackAudioSessionManaging
  private let interruptionObserver: PlaybackInterruptionObserving?
  private let remoteController: RemotePlaybackControlling?
  private let sleepTimerScheduler: SleepTimerScheduling
  private let now: () -> Date
  private let makeBookmarkID: () -> String
  private let progressPersistenceIntervalSeconds: TimeInterval
  private let nowPlayingProgressUpdateIntervalSeconds: TimeInterval
  private var shouldResumeAfterInterruption = false
  private var lastPositionPersistedAt: Date?
  private var lastNowPlayingUpdatedAt: Date?
  private let skipIntervalSeconds: TimeInterval = 15

  init(
    engine: PlaybackEngine = AVPlayerPlaybackEngine(),
    positionStore: PlaybackPositionPersisting? = nil,
    bookmarkStore: PlaybackBookmarkPersisting? = nil,
    audioSessionManager: PlaybackAudioSessionManaging = AVAudioSessionPlaybackManager(),
    interruptionObserver: PlaybackInterruptionObserving? = AVAudioSessionInterruptionObserver(),
    remoteController: RemotePlaybackControlling? = MPRemotePlaybackController(),
    sleepTimerScheduler: SleepTimerScheduling = TaskSleepTimerScheduler(),
    now: @escaping () -> Date = Date.init,
    makeBookmarkID: @escaping () -> String = { UUID().uuidString },
    progressPersistenceIntervalSeconds: TimeInterval = 15,
    nowPlayingProgressUpdateIntervalSeconds: TimeInterval = 10
  ) {
    self.engine = engine
    self.positionStore = positionStore
    self.bookmarkStore = bookmarkStore
    self.audioSessionManager = audioSessionManager
    self.interruptionObserver = interruptionObserver
    self.remoteController = remoteController
    self.sleepTimerScheduler = sleepTimerScheduler
    self.now = now
    self.makeBookmarkID = makeBookmarkID
    self.progressPersistenceIntervalSeconds = progressPersistenceIntervalSeconds
    self.nowPlayingProgressUpdateIntervalSeconds = nowPlayingProgressUpdateIntervalSeconds
    state = PlaybackState()

    engine.setProgressHandler { [weak self] snapshot in
      self?.handleProgress(snapshot)
    }
    interruptionObserver?.setHandler { [weak self] event in
      self?.handleInterruption(event)
    }
    configureRemoteCommands()
  }

  func setPositionStore(_ positionStore: PlaybackPositionPersisting?) {
    self.positionStore = positionStore
  }

  func setBookmarkStore(_ bookmarkStore: PlaybackBookmarkPersisting?) {
    self.bookmarkStore = bookmarkStore
  }

  func load(
    story: PersistentStory,
    localAssetsDirectory: URL? = nil
  ) throws {
    try audioSessionManager.configureForBackgroundPlayback()

    let source = try StoryAudioSource.resolve(
      for: story,
      localAssetsDirectory: localAssetsDirectory
    )
    let savedPosition = try positionStore?.savedPosition(for: story.id)
    let duration = bestDuration(
      storyDuration: story.durationSeconds,
      savedDuration: savedPosition?.durationSeconds,
      engineDuration: engine.durationSeconds
    )
    let startPosition = clamped(
      savedPosition?.positionSeconds ?? 0,
      durationSeconds: duration
    )

    state = PlaybackState(
      storyID: story.id,
      storyTitle: story.title,
      source: source,
      status: .loading,
      positionSeconds: startPosition,
      durationSeconds: duration,
      chapterID: savedPosition?.chapterID,
      playbackRate: state.playbackRate,
      sleepTimer: state.sleepTimer
    )

    do {
      try engine.load(source)
      try engine.setPlaybackRate(state.playbackRate)
      if startPosition > 0 {
        try engine.seek(to: startPosition)
      }

      state.status = .paused
      state.positionSeconds = startPosition
      try persistCurrentPosition(force: true)
      updateNowPlayingInfo(force: true)
    } catch {
      state.status = .failed(error.localizedDescription)
      throw error
    }
  }

  func play() throws {
    guard state.storyID != nil else {
      throw PlaybackServiceError.noLoadedStory
    }

    do {
      try audioSessionManager.setActive(true)
      try engine.play()
      state.status = .playing
      updateNowPlayingInfo(force: true)
    } catch {
      state.status = .failed(error.localizedDescription)
      throw error
    }
  }

  func play(
    story: PersistentStory,
    localAssetsDirectory: URL? = nil
  ) throws {
    try load(story: story, localAssetsDirectory: localAssetsDirectory)
    try play()
  }

  func pause() throws {
    guard state.storyID != nil else {
      throw PlaybackServiceError.noLoadedStory
    }

    engine.pause()
    state.status = .paused
    try persistCurrentPosition(force: true)
    try audioSessionManager.setActive(false)
    updateNowPlayingInfo(force: true)
  }

  func seek(to seconds: TimeInterval) throws {
    guard state.storyID != nil else {
      throw PlaybackServiceError.noLoadedStory
    }

    let target = clamped(seconds, durationSeconds: state.durationSeconds)

    do {
      try engine.seek(to: target)
      state.positionSeconds = target
      try persistCurrentPosition(force: true)
      updateNowPlayingInfo(force: true)
    } catch {
      state.status = .failed(error.localizedDescription)
      throw error
    }
  }

  func skipForward(seconds: TimeInterval? = nil) throws {
    try seek(to: state.positionSeconds + (seconds ?? skipIntervalSeconds))
  }

  func skipBackward(seconds: TimeInterval? = nil) throws {
    try seek(to: state.positionSeconds - (seconds ?? skipIntervalSeconds))
  }

  func setPlaybackRate(_ rate: Double) throws {
    guard state.storyID != nil else {
      throw PlaybackServiceError.noLoadedStory
    }
    guard rate.isFinite, rate > 0 else {
      throw PlaybackServiceError.invalidPlaybackRate(rate)
    }

    let clampedRate = min(max(rate, 0.5), 2)

    do {
      try engine.setPlaybackRate(clampedRate)
      state.playbackRate = clampedRate
      updateNowPlayingInfo(force: true)
    } catch {
      state.status = .failed(error.localizedDescription)
      throw error
    }
  }

  func startSleepTimer(durationSeconds: TimeInterval) throws {
    guard state.storyID != nil else {
      throw PlaybackServiceError.noLoadedStory
    }
    guard durationSeconds.isFinite, durationSeconds > 0 else {
      throw PlaybackServiceError.invalidSleepTimerDuration(durationSeconds)
    }

    sleepTimerScheduler.cancel()
    let endsAt = now().addingTimeInterval(durationSeconds)
    state.sleepTimer = .scheduled(
      endsAt: endsAt,
      durationSeconds: durationSeconds
    )
    sleepTimerScheduler.schedule(after: durationSeconds) { [weak self] in
      self?.handleSleepTimerExpired()
    }
  }

  func cancelSleepTimer() {
    sleepTimerScheduler.cancel()
    state.sleepTimer = .inactive
  }

  @discardableResult
  func createBookmark(note: String? = nil) throws -> PlaybackBookmark {
    guard let storyID = state.storyID else {
      throw PlaybackServiceError.noLoadedStory
    }
    guard let bookmarkStore else {
      throw PlaybackServiceError.bookmarkStoreUnavailable
    }

    let bookmark = PlaybackBookmark(
      id: makeBookmarkID(),
      storyID: storyID,
      chapterID: state.chapterID,
      positionSeconds: state.positionSeconds,
      note: note,
      createdAt: now()
    )
    try bookmarkStore.persist(bookmark)
    return bookmark
  }

  func handleInterruption(_ event: PlaybackInterruptionEvent) {
    switch event {
    case .began:
      shouldResumeAfterInterruption = state.status == .playing || engine.isPlaying
      engine.pause()
      if state.storyID != nil {
        state.status = .paused
        try? persistCurrentPosition(force: true)
        updateNowPlayingInfo(force: true)
      }
    case .ended(let shouldResume):
      guard shouldResume, shouldResumeAfterInterruption else {
        shouldResumeAfterInterruption = false
        return
      }

      shouldResumeAfterInterruption = false
      do {
        try play()
    } catch {
      state.status = .failed(error.localizedDescription)
      updateNowPlayingInfo(force: true)
    }
  }
  }

  func refreshProgress() throws {
    guard state.storyID != nil else {
      throw PlaybackServiceError.noLoadedStory
    }

    handleProgress(
      PlaybackProgressSnapshot(
        positionSeconds: engine.positionSeconds,
        durationSeconds: engine.durationSeconds,
        isPlaying: engine.isPlaying
      )
    )
  }

  private func handleProgress(_ snapshot: PlaybackProgressSnapshot) {
    guard state.storyID != nil else {
      return
    }

    let duration = bestDuration(
      storyDuration: state.durationSeconds,
      savedDuration: nil,
      engineDuration: snapshot.durationSeconds
    )
    let position = clamped(
      snapshot.positionSeconds,
      durationSeconds: duration
    )

    state.positionSeconds = position
    state.durationSeconds = duration

    let isFailure = snapshot.failureMessage != nil
    let didReachEnd = snapshot.didFinish || (duration > 0 && position >= duration)
    let shouldPersistImmediately = isFailure || didReachEnd

    if let failureMessage = snapshot.failureMessage {
      state.status = .failed(failureMessage)
      cancelSleepTimer()
      try? audioSessionManager.setActive(false)
    } else if didReachEnd {
      state.status = .ended
      cancelSleepTimer()
      try? audioSessionManager.setActive(false)
    } else if snapshot.isPlaying {
      state.status = .playing
    } else if state.status == .loading {
      state.status = .paused
    }

    do {
      try persistCurrentPosition(force: shouldPersistImmediately)
    } catch {
      state.status = .failed(error.localizedDescription)
    }

    updateNowPlayingInfo(force: shouldPersistImmediately)
  }

  private func handleSleepTimerExpired() {
    guard state.storyID != nil else {
      state.sleepTimer = .inactive
      return
    }

    engine.pause()
    state.status = .paused
    state.sleepTimer = .inactive
    try? persistCurrentPosition(force: true)
    try? audioSessionManager.setActive(false)
    updateNowPlayingInfo(force: true)
  }

  private func persistCurrentPosition(force: Bool = false) throws {
    guard let positionStore,
          let storyID = state.storyID else {
      return
    }

    let timestamp = now()
    guard force || shouldPersistProgress(at: timestamp) else {
      return
    }

    try positionStore.persist(
      PlaybackPosition(
        storyID: storyID,
        positionSeconds: state.positionSeconds,
        durationSeconds: state.durationSeconds,
        chapterID: state.chapterID
      )
    )
    lastPositionPersistedAt = timestamp
  }

  private func bestDuration(
    storyDuration: TimeInterval,
    savedDuration: TimeInterval?,
    engineDuration: TimeInterval
  ) -> TimeInterval {
    let candidates = [
      engineDuration,
      savedDuration ?? 0,
      storyDuration
    ]

    return candidates.first(where: { $0 > 0 }) ?? 0
  }

  private func clamped(
    _ seconds: TimeInterval,
    durationSeconds: TimeInterval
  ) -> TimeInterval {
    let lowerBounded = max(seconds, 0)
    guard durationSeconds > 0 else {
      return lowerBounded
    }

    return min(lowerBounded, durationSeconds)
  }

  private func configureRemoteCommands() {
    remoteController?.configure(
      PlaybackRemoteCommandHandlers(
        play: { [weak self] in
          self?.runRemoteCommand { try self?.play() } ?? .failed
        },
        pause: { [weak self] in
          self?.runRemoteCommand { try self?.pause() } ?? .failed
        },
        togglePlayPause: { [weak self] in
          self?.runRemoteCommand {
            guard let self else {
              return
            }

            if self.state.status == .playing || self.engine.isPlaying {
              try self.pause()
            } else {
              try self.play()
            }
          } ?? .failed
        },
        skipForward: { [weak self] in
          self?.runRemoteCommand { try self?.skipForward() } ?? .failed
        },
        skipBackward: { [weak self] in
          self?.runRemoteCommand { try self?.skipBackward() } ?? .failed
        },
        seek: { [weak self] seconds in
          self?.runRemoteCommand { try self?.seek(to: seconds) } ?? .failed
        },
        changePlaybackRate: { [weak self] rate in
          self?.runRemoteCommand { try self?.setPlaybackRate(rate) } ?? .failed
        }
      )
    )
  }

  private func runRemoteCommand(_ action: () throws -> Void) -> PlaybackRemoteCommandResult {
    do {
      try action()
      return .success
    } catch {
      state.status = .failed(error.localizedDescription)
      updateNowPlayingInfo(force: true)
      return .failed
    }
  }

  private func updateNowPlayingInfo(force: Bool = true) {
    let timestamp = now()
    guard force || shouldUpdateNowPlayingProgress(at: timestamp) else {
      return
    }

    remoteController?.update(
      PlaybackNowPlayingMetadata(
        title: state.storyTitle ?? "Sleepy History",
        durationSeconds: state.durationSeconds,
        positionSeconds: state.positionSeconds,
        playbackRate: state.status == .playing ? state.playbackRate : 0,
        defaultPlaybackRate: state.playbackRate
      )
    )
    lastNowPlayingUpdatedAt = timestamp
  }

  private func shouldPersistProgress(at timestamp: Date) -> Bool {
    guard let lastPositionPersistedAt else {
      return true
    }

    return timestamp.timeIntervalSince(lastPositionPersistedAt) >= progressPersistenceIntervalSeconds
  }

  private func shouldUpdateNowPlayingProgress(at timestamp: Date) -> Bool {
    guard let lastNowPlayingUpdatedAt else {
      return true
    }

    return timestamp.timeIntervalSince(lastNowPlayingUpdatedAt) >= nowPlayingProgressUpdateIntervalSeconds
  }
}

@MainActor
protocol PlaybackAudioSessionManaging: AnyObject {
  func configureForBackgroundPlayback() throws
  func setActive(_ active: Bool) throws
}

@MainActor
final class AVAudioSessionPlaybackManager: PlaybackAudioSessionManaging {
  private let session: AVAudioSession

  init(session: AVAudioSession = .sharedInstance()) {
    self.session = session
  }

  func configureForBackgroundPlayback() throws {
    try session.setCategory(.playback, mode: .spokenAudio, options: [])
  }

  func setActive(_ active: Bool) throws {
    let options: AVAudioSession.SetActiveOptions = active ? [] : [.notifyOthersOnDeactivation]
    try session.setActive(active, options: options)
  }
}

enum PlaybackInterruptionEvent: Equatable {
  case began
  case ended(shouldResume: Bool)
}

@MainActor
protocol PlaybackInterruptionObserving: AnyObject {
  func setHandler(_ handler: (@MainActor (PlaybackInterruptionEvent) -> Void)?)
}

@MainActor
final class AVAudioSessionInterruptionObserver: PlaybackInterruptionObserving {
  private let notificationCenter: NotificationCenter
  private var token: NSObjectProtocol?
  private var handler: (@MainActor (PlaybackInterruptionEvent) -> Void)?

  init(notificationCenter: NotificationCenter = .default) {
    self.notificationCenter = notificationCenter
  }

  func setHandler(_ handler: (@MainActor (PlaybackInterruptionEvent) -> Void)?) {
    self.handler = handler

    if let token {
      notificationCenter.removeObserver(token)
      self.token = nil
    }

    guard handler != nil else {
      return
    }

    token = notificationCenter.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: nil
    ) { [weak self] notification in
      guard let event = Self.event(from: notification) else {
        return
      }

      Task { @MainActor in
        self?.handler?(event)
      }
    }
  }

  nonisolated private static func event(from notification: Notification) -> PlaybackInterruptionEvent? {
    guard
      let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: typeValue)
    else {
      return nil
    }

    switch type {
    case .began:
      return .began
    case .ended:
      let optionsValue = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
      return .ended(shouldResume: options.contains(.shouldResume))
    @unknown default:
      return nil
    }
  }
}

enum PlaybackRemoteCommandResult: Equatable {
  case success
  case failed
}

struct PlaybackRemoteCommandHandlers {
  var play: @MainActor () -> PlaybackRemoteCommandResult
  var pause: @MainActor () -> PlaybackRemoteCommandResult
  var togglePlayPause: @MainActor () -> PlaybackRemoteCommandResult
  var skipForward: @MainActor () -> PlaybackRemoteCommandResult
  var skipBackward: @MainActor () -> PlaybackRemoteCommandResult
  var seek: @MainActor (TimeInterval) -> PlaybackRemoteCommandResult
  var changePlaybackRate: @MainActor (Double) -> PlaybackRemoteCommandResult
}

struct PlaybackNowPlayingMetadata: Equatable {
  var title: String
  var durationSeconds: TimeInterval
  var positionSeconds: TimeInterval
  var playbackRate: Double
  var defaultPlaybackRate: Double
}

@MainActor
protocol RemotePlaybackControlling: AnyObject {
  func configure(_ handlers: PlaybackRemoteCommandHandlers)
  func update(_ metadata: PlaybackNowPlayingMetadata)
}

@MainActor
final class MPRemotePlaybackController: RemotePlaybackControlling {
  private let commandCenter: MPRemoteCommandCenter
  private let nowPlayingInfoCenter: MPNowPlayingInfoCenter
  private var targets: [Any] = []

  init(
    commandCenter: MPRemoteCommandCenter = .shared(),
    nowPlayingInfoCenter: MPNowPlayingInfoCenter = .default()
  ) {
    self.commandCenter = commandCenter
    self.nowPlayingInfoCenter = nowPlayingInfoCenter
  }

  func configure(_ handlers: PlaybackRemoteCommandHandlers) {
    removeTargets()

    commandCenter.playCommand.isEnabled = true
    targets.append(commandCenter.playCommand.addTarget { _ in
      Task { @MainActor in
        _ = handlers.play()
      }
      return .success
    })

    commandCenter.pauseCommand.isEnabled = true
    targets.append(commandCenter.pauseCommand.addTarget { _ in
      Task { @MainActor in
        _ = handlers.pause()
      }
      return .success
    })

    commandCenter.togglePlayPauseCommand.isEnabled = true
    targets.append(commandCenter.togglePlayPauseCommand.addTarget { _ in
      Task { @MainActor in
        _ = handlers.togglePlayPause()
      }
      return .success
    })

    commandCenter.skipForwardCommand.isEnabled = true
    commandCenter.skipForwardCommand.preferredIntervals = [15]
    targets.append(commandCenter.skipForwardCommand.addTarget { _ in
      Task { @MainActor in
        _ = handlers.skipForward()
      }
      return .success
    })

    commandCenter.skipBackwardCommand.isEnabled = true
    commandCenter.skipBackwardCommand.preferredIntervals = [15]
    targets.append(commandCenter.skipBackwardCommand.addTarget { _ in
      Task { @MainActor in
        _ = handlers.skipBackward()
      }
      return .success
    })

    commandCenter.changePlaybackPositionCommand.isEnabled = true
    targets.append(commandCenter.changePlaybackPositionCommand.addTarget { event in
      guard let event = event as? MPChangePlaybackPositionCommandEvent else {
        return .commandFailed
      }

      Task { @MainActor in
        _ = handlers.seek(event.positionTime)
      }
      return .success
    })

    commandCenter.changePlaybackRateCommand.isEnabled = true
    commandCenter.changePlaybackRateCommand.supportedPlaybackRates = [0.75, 1, 1.25, 1.5, 2]
    targets.append(commandCenter.changePlaybackRateCommand.addTarget { event in
      guard let event = event as? MPChangePlaybackRateCommandEvent else {
        return .commandFailed
      }

      Task { @MainActor in
        _ = handlers.changePlaybackRate(Double(event.playbackRate))
      }
      return .success
    })
  }

  func update(_ metadata: PlaybackNowPlayingMetadata) {
    nowPlayingInfoCenter.nowPlayingInfo = [
      MPMediaItemPropertyTitle: metadata.title,
      MPMediaItemPropertyPlaybackDuration: metadata.durationSeconds,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: metadata.positionSeconds,
      MPNowPlayingInfoPropertyPlaybackRate: metadata.playbackRate,
      MPNowPlayingInfoPropertyDefaultPlaybackRate: metadata.defaultPlaybackRate,
      MPNowPlayingInfoPropertyIsLiveStream: false
    ]
  }

  private func removeTargets() {
    guard !targets.isEmpty else {
      return
    }

    for target in targets {
      commandCenter.playCommand.removeTarget(target)
      commandCenter.pauseCommand.removeTarget(target)
      commandCenter.togglePlayPauseCommand.removeTarget(target)
      commandCenter.skipForwardCommand.removeTarget(target)
      commandCenter.skipBackwardCommand.removeTarget(target)
      commandCenter.changePlaybackPositionCommand.removeTarget(target)
      commandCenter.changePlaybackRateCommand.removeTarget(target)
    }
    targets.removeAll()
  }
}

@MainActor
protocol SleepTimerScheduling: AnyObject {
  func schedule(after seconds: TimeInterval, handler: @escaping @MainActor () -> Void)
  func cancel()
}

@MainActor
final class TaskSleepTimerScheduler: SleepTimerScheduling {
  private var task: Task<Void, Never>?

  deinit {
    task?.cancel()
  }

  func schedule(after seconds: TimeInterval, handler: @escaping @MainActor () -> Void) {
    cancel()
    task = Task { @MainActor in
      let nanoseconds = UInt64(max(seconds, 0) * 1_000_000_000)
      try? await Task.sleep(nanoseconds: nanoseconds)
      guard !Task.isCancelled else {
        return
      }
      handler()
    }
  }

  func cancel() {
    task?.cancel()
    task = nil
  }
}

@MainActor
protocol PlaybackBookmarkPersisting: AnyObject {
  func persist(_ bookmark: PlaybackBookmark) throws
}

@MainActor
final class SwiftDataPlaybackBookmarkStore: PlaybackBookmarkPersisting {
  private let context: ModelContext

  init(context: ModelContext) {
    self.context = context
  }

  func persist(_ bookmark: PlaybackBookmark) throws {
    let persistentBookmark = PersistentBookmark(
      id: bookmark.id,
      chapterID: bookmark.chapterID,
      positionSeconds: max(bookmark.positionSeconds, 0),
      note: bookmark.note,
      createdAt: bookmark.createdAt
    )
    context.insert(persistentBookmark)

    if let story = try fetchStory(storyID: bookmark.storyID) {
      persistentBookmark.story = story
      story.bookmarks.append(persistentBookmark)
    }

    try context.save()
  }

  private func fetchStory(storyID: String) throws -> PersistentStory? {
    var descriptor = FetchDescriptor<PersistentStory>(
      predicate: #Predicate { $0.id == storyID }
    )
    descriptor.fetchLimit = 1

    return try context.fetch(descriptor).first
  }
}
