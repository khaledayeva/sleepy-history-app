import Foundation
import SwiftData

@MainActor
protocol PlaybackPositionPersisting: AnyObject {
  func savedPosition(for storyID: String) throws -> PlaybackPosition?
  func persist(_ position: PlaybackPosition) throws
}

@MainActor
final class SwiftDataPlaybackPositionStore: PlaybackPositionPersisting {
  private let context: ModelContext
  private let now: () -> Date

  init(context: ModelContext, now: @escaping () -> Date = Date.init) {
    self.context = context
    self.now = now
  }

  func savedPosition(for storyID: String) throws -> PlaybackPosition? {
    guard let state = try fetchState(storyID: storyID) else {
      return nil
    }

    return PlaybackPosition(
      storyID: storyID,
      positionSeconds: state.playbackPositionSeconds,
      durationSeconds: state.playbackDurationSeconds,
      chapterID: state.playbackChapterID
    )
  }

  func persist(_ position: PlaybackPosition) throws {
    let timestamp = now()
    let state: PersistentStoryState

    if let existingState = try fetchState(storyID: position.storyID) {
      state = existingState
    } else {
      state = PersistentStoryState(
        storyID: position.storyID,
        updatedAt: timestamp
      )
      context.insert(state)
    }

    state.playbackPositionSeconds = max(position.positionSeconds, 0)
    state.playbackDurationSeconds = max(position.durationSeconds, 0)
    state.playbackChapterID = position.chapterID
    state.lastPlayedAt = timestamp
    state.updatedAt = timestamp

    if state.story == nil,
       let story = try fetchStory(storyID: position.storyID) {
      state.story = story
      story.state = state
    }

    try context.save()
  }

  private func fetchState(storyID: String) throws -> PersistentStoryState? {
    var descriptor = FetchDescriptor<PersistentStoryState>(
      predicate: #Predicate { $0.storyID == storyID }
    )
    descriptor.fetchLimit = 1

    return try context.fetch(descriptor).first
  }

  private func fetchStory(storyID: String) throws -> PersistentStory? {
    var descriptor = FetchDescriptor<PersistentStory>(
      predicate: #Predicate { $0.id == storyID }
    )
    descriptor.fetchLimit = 1

    return try context.fetch(descriptor).first
  }
}
