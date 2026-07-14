import Foundation

enum PlaybackStatus: Equatable {
  case idle
  case loading
  case playing
  case paused
  case ended
  case failed(String)
}

struct PlaybackState: Equatable {
  var storyID: String?
  var storyTitle: String?
  var source: StoryAudioSource?
  var status: PlaybackStatus
  var positionSeconds: TimeInterval
  var durationSeconds: TimeInterval
  var chapterID: String?
  var playbackRate: Double
  var sleepTimer: SleepTimerState

  init(
    storyID: String? = nil,
    storyTitle: String? = nil,
    source: StoryAudioSource? = nil,
    status: PlaybackStatus = .idle,
    positionSeconds: TimeInterval = 0,
    durationSeconds: TimeInterval = 0,
    chapterID: String? = nil,
    playbackRate: Double = 1,
    sleepTimer: SleepTimerState = .inactive
  ) {
    self.storyID = storyID
    self.storyTitle = storyTitle
    self.source = source
    self.status = status
    self.positionSeconds = positionSeconds
    self.durationSeconds = durationSeconds
    self.chapterID = chapterID
    self.playbackRate = playbackRate
    self.sleepTimer = sleepTimer
  }

  var progress: Double {
    guard durationSeconds > 0 else {
      return 0
    }

    return min(max(positionSeconds / durationSeconds, 0), 1)
  }
}

enum SleepTimerState: Equatable {
  case inactive
  case scheduled(endsAt: Date, durationSeconds: TimeInterval)
}

struct PlaybackProgressSnapshot: Equatable {
  var positionSeconds: TimeInterval
  var durationSeconds: TimeInterval
  var isPlaying: Bool
  var didFinish: Bool
  var failureMessage: String?

  init(
    positionSeconds: TimeInterval,
    durationSeconds: TimeInterval,
    isPlaying: Bool,
    didFinish: Bool = false,
    failureMessage: String? = nil
  ) {
    self.positionSeconds = positionSeconds
    self.durationSeconds = durationSeconds
    self.isPlaying = isPlaying
    self.didFinish = didFinish
    self.failureMessage = failureMessage
  }
}

struct PlaybackPosition: Equatable {
  var storyID: String
  var positionSeconds: TimeInterval
  var durationSeconds: TimeInterval
  var chapterID: String?

  init(
    storyID: String,
    positionSeconds: TimeInterval,
    durationSeconds: TimeInterval,
    chapterID: String? = nil
  ) {
    self.storyID = storyID
    self.positionSeconds = positionSeconds
    self.durationSeconds = durationSeconds
    self.chapterID = chapterID
  }
}

struct PlaybackBookmark: Equatable {
  var id: String
  var storyID: String
  var chapterID: String?
  var positionSeconds: TimeInterval
  var note: String?
  var createdAt: Date

  init(
    id: String,
    storyID: String,
    chapterID: String? = nil,
    positionSeconds: TimeInterval,
    note: String? = nil,
    createdAt: Date
  ) {
    self.id = id
    self.storyID = storyID
    self.chapterID = chapterID
    self.positionSeconds = positionSeconds
    self.note = note
    self.createdAt = createdAt
  }
}
