@preconcurrency import AVFoundation
@preconcurrency import Foundation

typealias PlaybackProgressHandler = @MainActor (PlaybackProgressSnapshot) -> Void

@MainActor
protocol PlaybackEngine: AnyObject {
  var currentSource: StoryAudioSource? { get }
  var positionSeconds: TimeInterval { get }
  var durationSeconds: TimeInterval { get }
  var isPlaying: Bool { get }
  var playbackRate: Double { get }

  func load(_ source: StoryAudioSource) throws
  func play() throws
  func pause()
  func seek(to seconds: TimeInterval) throws
  func setPlaybackRate(_ rate: Double) throws
  func setProgressHandler(_ handler: PlaybackProgressHandler?)
}

@MainActor
final class AVPlayerPlaybackEngine: PlaybackEngine {
  private let player: AVPlayer
  private let notificationCenter: NotificationCenter
  private var progressHandler: PlaybackProgressHandler?
  nonisolated(unsafe) private var timeObserver: Any?
  nonisolated(unsafe) private var didPlayToEndObserver: NSObjectProtocol?
  nonisolated(unsafe) private var failedToPlayToEndObserver: NSObjectProtocol?
  nonisolated(unsafe) private var itemStatusObservation: NSKeyValueObservation?
  private var requestedPlaybackRate: Double = 1

  private(set) var currentSource: StoryAudioSource?

  init(
    player: AVPlayer = AVPlayer(),
    notificationCenter: NotificationCenter = .default
  ) {
    self.player = player
    self.notificationCenter = notificationCenter
    self.player.automaticallyWaitsToMinimizeStalling = true
  }

  deinit {
    if let timeObserver {
      player.removeTimeObserver(timeObserver)
    }
    if let didPlayToEndObserver {
      notificationCenter.removeObserver(didPlayToEndObserver)
    }
    if let failedToPlayToEndObserver {
      notificationCenter.removeObserver(failedToPlayToEndObserver)
    }
    itemStatusObservation?.invalidate()
  }

  var positionSeconds: TimeInterval {
    seconds(from: player.currentTime())
  }

  var durationSeconds: TimeInterval {
    guard let item = player.currentItem else {
      return 0
    }

    return seconds(from: item.duration)
  }

  var isPlaying: Bool {
    player.timeControlStatus == .playing
  }

  var playbackRate: Double {
    requestedPlaybackRate
  }

  func load(_ source: StoryAudioSource) throws {
    currentSource = source
    clearItemObservers()

    let item = AVPlayerItem(url: source.url)
    item.audioTimePitchAlgorithm = .timeDomain
    player.replaceCurrentItem(with: item)
    observe(item)
    emitProgress(didFinish: false)
  }

  func play() throws {
    player.rate = Float(requestedPlaybackRate)
    startProgressUpdates()
    emitProgress(didFinish: false)
  }

  func pause() {
    player.pause()
    stopProgressUpdates()
    emitProgress(didFinish: false)
  }

  func seek(to seconds: TimeInterval) throws {
    let target = CMTime(seconds: max(seconds, 0), preferredTimescale: 600)
    player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
      Task { @MainActor in
        self?.emitProgress(didFinish: false)
      }
    }
  }

  func setPlaybackRate(_ rate: Double) throws {
    requestedPlaybackRate = rate
    if isPlaying {
      player.rate = Float(rate)
    }
    emitProgress(didFinish: false)
  }

  func setProgressHandler(_ handler: PlaybackProgressHandler?) {
    progressHandler = handler
    emitProgress(didFinish: false)
  }

  private func startProgressUpdates() {
    guard timeObserver == nil else {
      return
    }

    let interval = CMTime(seconds: 0.5, preferredTimescale: 600)
    timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] _ in
      Task { @MainActor in
        self?.emitProgress(didFinish: false)
      }
    }
  }

  private func stopProgressUpdates() {
    guard let timeObserver else {
      return
    }

    player.removeTimeObserver(timeObserver)
    self.timeObserver = nil
  }

  private func emitProgress(
    didFinish: Bool,
    failureMessage: String? = nil
  ) {
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

  private func observe(_ item: AVPlayerItem) {
    didPlayToEndObserver = notificationCenter.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime,
      object: item,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor in
        self?.stopProgressUpdates()
        self?.emitProgress(didFinish: true)
      }
    }

    failedToPlayToEndObserver = notificationCenter.addObserver(
      forName: .AVPlayerItemFailedToPlayToEndTime,
      object: item,
      queue: .main
    ) { [weak self] notification in
      let error = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
      Task { @MainActor in
        self?.stopProgressUpdates()
        self?.emitProgress(
          didFinish: false,
          failureMessage: error?.localizedDescription ?? "Audio playback failed before the story finished."
        )
      }
    }

    itemStatusObservation = item.observe(\.status, options: [.new]) { [weak self] observedItem, _ in
      guard observedItem.status == .failed else {
        return
      }

      Task { @MainActor in
        self?.stopProgressUpdates()
        self?.emitProgress(
          didFinish: false,
          failureMessage: observedItem.error?.localizedDescription ?? "Audio playback failed to load."
        )
      }
    }
  }

  private func clearItemObservers() {
    if let didPlayToEndObserver {
      notificationCenter.removeObserver(didPlayToEndObserver)
      self.didPlayToEndObserver = nil
    }

    if let failedToPlayToEndObserver {
      notificationCenter.removeObserver(failedToPlayToEndObserver)
      self.failedToPlayToEndObserver = nil
    }

    itemStatusObservation?.invalidate()
    itemStatusObservation = nil
  }

  private func seconds(from time: CMTime) -> TimeInterval {
    guard time.isNumeric else {
      return 0
    }

    let seconds = time.seconds
    guard seconds.isFinite else {
      return 0
    }

    return max(seconds, 0)
  }
}
