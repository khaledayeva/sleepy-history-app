import Foundation

enum StoryAudioSourceKind: Equatable {
  case localFile
  case remote
}

struct StoryAudioSource: Equatable {
  var url: URL
  var kind: StoryAudioSourceKind

  init(localFileURL: URL) {
    url = localFileURL
    kind = .localFile
  }

  init(remoteURL: URL) {
    url = remoteURL
    kind = .remote
  }

  static func resolve(
    for story: PersistentStory,
    localAssetsDirectory: URL? = nil
  ) throws -> StoryAudioSource {
    guard let audioAsset = story.assets.first(where: { $0.kind == "audio" }) else {
      throw PlaybackServiceError.missingAudioAsset(storyID: story.id)
    }

    if let localFileName = audioAsset.localFileName,
       let localAssetsDirectory {
      let localURL = localAssetsDirectory.appendingPathComponent(localFileName)
      if FileManager.default.fileExists(atPath: localURL.path(percentEncoded: false)) {
        try DownloadFileStore.prepareForLockedPlayback(localURL)
        return StoryAudioSource(localFileURL: localURL)
      }
    }

    if let remoteURLString = audioAsset.remoteURLString,
       let remoteURL = URL(string: remoteURLString),
       let scheme = remoteURL.scheme,
       ["http", "https"].contains(scheme.lowercased()) {
      return StoryAudioSource(remoteURL: remoteURL)
    }

    throw PlaybackServiceError.invalidAudioAsset(storyID: story.id)
  }
}
