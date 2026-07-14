import Foundation
import SwiftData

@Model
final class PersistentStory {
  @Attribute(.unique) var id: String
  var title: String
  var synopsis: String
  var kind: String
  var generationStatus: String
  var createdAt: Date
  var updatedAt: Date
  var durationSeconds: TimeInterval

  @Relationship(deleteRule: .cascade, inverse: \PersistentAsset.story)
  var assets: [PersistentAsset]

  @Relationship(deleteRule: .cascade, inverse: \PersistentBookmark.story)
  var bookmarks: [PersistentBookmark]

  @Relationship(deleteRule: .cascade, inverse: \PersistentChapter.story)
  var chapters: [PersistentChapter]

  @Relationship(deleteRule: .cascade, inverse: \PersistentSource.story)
  var sources: [PersistentSource]

  @Relationship(deleteRule: .cascade, inverse: \PersistentStoryState.story)
  var state: PersistentStoryState?

  init(
    id: String,
    title: String,
    synopsis: String,
    kind: String,
    generationStatus: String,
    createdAt: Date,
    updatedAt: Date,
    durationSeconds: TimeInterval,
    assets: [PersistentAsset] = [],
    bookmarks: [PersistentBookmark] = [],
    chapters: [PersistentChapter] = [],
    sources: [PersistentSource] = [],
    state: PersistentStoryState? = nil
  ) {
    self.id = id
    self.title = title
    self.synopsis = synopsis
    self.kind = kind
    self.generationStatus = generationStatus
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.durationSeconds = durationSeconds
    self.assets = assets
    self.bookmarks = bookmarks
    self.chapters = chapters
    self.sources = sources
    self.state = state
  }
}

@Model
final class PersistentAsset {
  @Attribute(.unique) var id: String
  var kind: String
  var remoteURLString: String?
  var localFileName: String?
  var mimeType: String?
  var byteCount: Int64?
  var createdAt: Date
  var story: PersistentStory?

  init(
    id: String,
    kind: String,
    remoteURLString: String? = nil,
    localFileName: String? = nil,
    mimeType: String? = nil,
    byteCount: Int64? = nil,
    createdAt: Date,
    story: PersistentStory? = nil
  ) {
    self.id = id
    self.kind = kind
    self.remoteURLString = remoteURLString
    self.localFileName = localFileName
    self.mimeType = mimeType
    self.byteCount = byteCount
    self.createdAt = createdAt
    self.story = story
  }
}

@Model
final class PersistentBookmark {
  @Attribute(.unique) var id: String
  var chapterID: String?
  var positionSeconds: TimeInterval
  var note: String?
  var createdAt: Date
  var story: PersistentStory?

  init(
    id: String,
    chapterID: String? = nil,
    positionSeconds: TimeInterval,
    note: String? = nil,
    createdAt: Date,
    story: PersistentStory? = nil
  ) {
    self.id = id
    self.chapterID = chapterID
    self.positionSeconds = positionSeconds
    self.note = note
    self.createdAt = createdAt
    self.story = story
  }
}

@Model
final class PersistentChapter {
  @Attribute(.unique) var id: String
  var index: Int
  var title: String
  var summary: String
  var estimatedDurationSeconds: TimeInterval
  var transcript: String
  var sourceIDsStorage: String
  var story: PersistentStory?

  var sourceIDs: [String] {
    get {
      sourceIDsStorage
        .split(separator: ",")
        .map(String.init)
        .filter { !$0.isEmpty }
    }
    set {
      sourceIDsStorage = newValue.joined(separator: ",")
    }
  }

  init(
    id: String,
    index: Int,
    title: String,
    summary: String,
    estimatedDurationSeconds: TimeInterval,
    transcript: String,
    sourceIDs: [String] = [],
    story: PersistentStory? = nil
  ) {
    self.id = id
    self.index = index
    self.title = title
    self.summary = summary
    self.estimatedDurationSeconds = estimatedDurationSeconds
    self.transcript = transcript
    self.sourceIDsStorage = sourceIDs.joined(separator: ",")
    self.story = story
  }
}

@Model
final class PersistentSource {
  @Attribute(.unique) var id: String
  var title: String
  var urlString: String?
  var publisher: String?
  var retrievedAt: String?
  var notes: String?
  var story: PersistentStory?

  init(
    id: String,
    title: String,
    urlString: String? = nil,
    publisher: String? = nil,
    retrievedAt: String? = nil,
    notes: String? = nil,
    story: PersistentStory? = nil
  ) {
    self.id = id
    self.title = title
    self.urlString = urlString
    self.publisher = publisher
    self.retrievedAt = retrievedAt
    self.notes = notes
    self.story = story
  }
}

@Model
final class PersistentStoryState {
  @Attribute(.unique) var storyID: String
  var isFavorite: Bool
  var isDownloaded: Bool
  var downloadedAt: Date?
  var playbackPositionSeconds: TimeInterval
  var playbackDurationSeconds: TimeInterval
  var playbackChapterID: String?
  var lastPlayedAt: Date?
  var updatedAt: Date
  var story: PersistentStory?

  init(
    storyID: String,
    isFavorite: Bool = false,
    isDownloaded: Bool = false,
    downloadedAt: Date? = nil,
    playbackPositionSeconds: TimeInterval = 0,
    playbackDurationSeconds: TimeInterval = 0,
    playbackChapterID: String? = nil,
    lastPlayedAt: Date? = nil,
    updatedAt: Date,
    story: PersistentStory? = nil
  ) {
    self.storyID = storyID
    self.isFavorite = isFavorite
    self.isDownloaded = isDownloaded
    self.downloadedAt = downloadedAt
    self.playbackPositionSeconds = playbackPositionSeconds
    self.playbackDurationSeconds = playbackDurationSeconds
    self.playbackChapterID = playbackChapterID
    self.lastPlayedAt = lastPlayedAt
    self.updatedAt = updatedAt
    self.story = story
  }
}
