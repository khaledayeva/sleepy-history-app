import Foundation
import SwiftData
import XCTest
@testable import SleepyHistory

final class DownloadServiceTests: XCTestCase {
  private var temporaryDirectory: URL!

  override func setUpWithError() throws {
    try super.setUpWithError()
    temporaryDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
  }

  override func tearDownWithError() throws {
    if let temporaryDirectory {
      try? FileManager.default.removeItem(at: temporaryDirectory)
    }
    try super.tearDownWithError()
  }

  @MainActor
  func testDownloadsAudioAndArtworkMarksStateAndResolvesLocalPlayback() async throws {
    let container = try PersistenceContainerFactory.makeInMemoryContainer()
    let context = container.mainContext
    let story = makeStory()
    context.insert(story)

    let fetcher = FakeDownloadAssetFetcher(responses: [
      Self.audioURL: .success(Self.response(data: Self.audioData, mimeType: "audio/mp4")),
      Self.coverURL: .success(Self.response(data: Self.coverData, mimeType: "image/png"))
    ])
    let service = try StoryDownloadService(
      downloadsDirectory: temporaryDirectory,
      fetcher: fetcher,
      context: context,
      now: { Self.downloadDate }
    )

    let result = try await service.download(story: story)

    XCTAssertEqual(result.storyID, "story_offline")
    XCTAssertEqual(result.downloadedAssetIDs, ["asset_audio", "asset_cover"])
    XCTAssertEqual(result.byteCount, Int64(Self.audioData.count + Self.coverData.count))
    XCTAssertEqual(try service.storageUsage().byteCount, result.byteCount)
    XCTAssertEqual(fetcher.requestedURLs, [Self.audioURL, Self.coverURL])

    let audioAsset = try XCTUnwrap(story.assets.first { $0.kind == "audio" })
    let coverAsset = try XCTUnwrap(story.assets.first { $0.kind == "coverImage" })
    let audioFileName = try XCTUnwrap(audioAsset.localFileName)
    let coverFileName = try XCTUnwrap(coverAsset.localFileName)

    XCTAssertEqual(audioAsset.byteCount, Int64(Self.audioData.count))
    XCTAssertEqual(coverAsset.byteCount, Int64(Self.coverData.count))
    XCTAssertTrue(FileManager.default.fileExists(atPath: service.localAssetsDirectory.appendingPathComponent(audioFileName).path(percentEncoded: false)))
    XCTAssertTrue(FileManager.default.fileExists(atPath: service.localAssetsDirectory.appendingPathComponent(coverFileName).path(percentEncoded: false)))

    let state = try XCTUnwrap(story.state)
    XCTAssertTrue(state.isDownloaded)
    XCTAssertEqual(state.downloadedAt, Self.downloadDate)
    XCTAssertEqual(story.updatedAt, Self.downloadDate)

    let source = try StoryAudioSource.resolve(
      for: story,
      localAssetsDirectory: service.localAssetsDirectory
    )
    XCTAssertEqual(source.kind, .localFile)
    XCTAssertEqual(source.url.lastPathComponent, audioFileName)

    let directoryValues = try service.localAssetsDirectory.resourceValues(forKeys: [.isExcludedFromBackupKey])
    let audioValues = try source.url.resourceValues(forKeys: [.isExcludedFromBackupKey])
    let coverValues = try service.localAssetsDirectory
      .appendingPathComponent(coverFileName)
      .resourceValues(forKeys: [.isExcludedFromBackupKey])

    XCTAssertEqual(directoryValues.isExcludedFromBackup, true)
    XCTAssertEqual(audioValues.isExcludedFromBackup, true)
    XCTAssertEqual(coverValues.isExcludedFromBackup, true)
    assertReadableAfterFirstUnlock(source.url)

    var descriptor = FetchDescriptor<PersistentStory>(
      predicate: #Predicate { $0.id == "story_offline" }
    )
    descriptor.relationshipKeyPathsForPrefetching = [\.assets, \.state]
    let persistedStory = try XCTUnwrap(try context.fetch(descriptor).first)

    XCTAssertEqual(persistedStory.state?.isDownloaded, true)
    XCTAssertEqual(persistedStory.assets.first { $0.kind == "audio" }?.localFileName, audioFileName)
  }

  @MainActor
  func testDownloadsOnlyAudioForPlaybackAndLeavesArtworkRemote() async throws {
    let container = try PersistenceContainerFactory.makeInMemoryContainer()
    let context = container.mainContext
    let story = makeStory()
    context.insert(story)

    let fetcher = FakeDownloadAssetFetcher(responses: [
      Self.audioURL: .success(Self.response(data: Self.audioData, mimeType: "audio/mp4")),
      Self.coverURL: .success(Self.response(data: Self.coverData, mimeType: "image/png"))
    ])
    let service = try StoryDownloadService(
      downloadsDirectory: temporaryDirectory,
      fetcher: fetcher,
      context: context,
      now: { Self.downloadDate }
    )

    let result = try await service.downloadAudioForPlayback(story: story)

    XCTAssertEqual(result.downloadedAssetIDs, ["asset_audio"])
    XCTAssertEqual(result.byteCount, Int64(Self.audioData.count))
    XCTAssertEqual(fetcher.requestedURLs, [Self.audioURL])
    XCTAssertEqual(story.assets.first { $0.kind == "audio" }?.localFileName?.hasSuffix(".m4a"), true)
    XCTAssertNil(story.assets.first { $0.kind == "coverImage" }?.localFileName)
    XCTAssertEqual(story.state?.isDownloaded, true)
    let audioFileName = try XCTUnwrap(story.assets.first { $0.kind == "audio" }?.localFileName)
    assertReadableAfterFirstUnlock(service.localAssetsDirectory.appendingPathComponent(audioFileName))
  }

  @MainActor
  func testResolvingExistingLocalAudioRepairsFileProtectionForLockedPlayback() throws {
    let story = makeStory()
    let audioAsset = try XCTUnwrap(story.assets.first { $0.kind == "audio" })
    let localFileName = "legacy-audio.m4a"
    let audioURL = temporaryDirectory.appendingPathComponent(localFileName)
    try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
    try Self.audioData.write(to: audioURL)
    audioAsset.localFileName = localFileName

    #if os(iOS)
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.complete],
      ofItemAtPath: audioURL.path(percentEncoded: false)
    )
    #endif

    let source = try StoryAudioSource.resolve(for: story, localAssetsDirectory: temporaryDirectory)

    XCTAssertEqual(source.kind, .localFile)
    assertReadableAfterFirstUnlock(source.url)
  }

  @MainActor
  func testDeleteDownloadsRemovesFilesClearsAssetFilenamesAndUpdatesUsage() async throws {
    let story = makeStory()
    let service = try StoryDownloadService(
      downloadsDirectory: temporaryDirectory,
      fetcher: FakeDownloadAssetFetcher(responses: [
        Self.audioURL: .success(Self.response(data: Self.audioData, mimeType: "audio/mp4")),
        Self.coverURL: .success(Self.response(data: Self.coverData, mimeType: "image/png"))
      ]),
      now: { Self.deleteDate }
    )

    _ = try await service.download(story: story)
    XCTAssertGreaterThan(try service.storageUsage().byteCount, 0)

    try service.deleteDownloads(for: story)

    XCTAssertEqual(try service.storageUsage().byteCount, 0)
    XCTAssertEqual(story.assets.compactMap(\.localFileName), [])
    XCTAssertEqual(story.assets.compactMap(\.byteCount), [])
    XCTAssertEqual(story.state?.isDownloaded, false)
    XCTAssertNil(story.state?.downloadedAt)
    XCTAssertEqual(story.updatedAt, Self.deleteDate)
  }

  @MainActor
  func testDeleteStoryRemovesDownloadsAndPersistentStoryState() async throws {
    let container = try PersistenceContainerFactory.makeInMemoryContainer()
    let context = container.mainContext
    let story = makeStory()
    context.insert(story)
    let service = try StoryDownloadService(
      downloadsDirectory: temporaryDirectory,
      fetcher: FakeDownloadAssetFetcher(responses: [
        Self.audioURL: .success(Self.response(data: Self.audioData, mimeType: "audio/mp4")),
        Self.coverURL: .success(Self.response(data: Self.coverData, mimeType: "image/png"))
      ]),
      context: context,
      now: { Self.deleteDate }
    )

    _ = try await service.download(story: story)
    XCTAssertGreaterThan(try service.storageUsage().byteCount, 0)

    try service.deleteStory(story)

    let descriptor = FetchDescriptor<PersistentStory>(
      predicate: #Predicate { $0.id == "story_offline" }
    )
    XCTAssertEqual(try context.fetch(descriptor), [])
    XCTAssertEqual(try service.storageUsage().byteCount, 0)
  }

  @MainActor
  func testDeleteStoryRunsRemoteDeletionBeforeLocalCleanup() async throws {
    let container = try PersistenceContainerFactory.makeInMemoryContainer()
    let context = container.mainContext
    let story = makeStory()
    context.insert(story)
    let service = try StoryDownloadService(
      downloadsDirectory: temporaryDirectory,
      fetcher: FakeDownloadAssetFetcher(responses: [
        Self.audioURL: .success(Self.response(data: Self.audioData, mimeType: "audio/mp4")),
        Self.coverURL: .success(Self.response(data: Self.coverData, mimeType: "image/png"))
      ]),
      context: context,
      now: { Self.deleteDate }
    )
    var remoteDeleted = false

    _ = try await service.download(story: story)
    try await service.deleteStory(story) {
      remoteDeleted = true
    }

    let descriptor = FetchDescriptor<PersistentStory>(
      predicate: #Predicate { $0.id == "story_offline" }
    )
    XCTAssertTrue(remoteDeleted)
    XCTAssertEqual(try context.fetch(descriptor), [])
    XCTAssertEqual(try service.storageUsage().byteCount, 0)
  }

  @MainActor
  func testRejectsMissingRemoteURLWithoutStartingNetworkRequest() async throws {
    let story = makeStory(
      audioRemoteURLString: .some(nil),
      coverRemoteURLString: Self.coverURL.absoluteString
    )
    let fetcher = FakeDownloadAssetFetcher(responses: [
      Self.coverURL: .success(Self.response(data: Self.coverData, mimeType: "image/png"))
    ])
    let service = try StoryDownloadService(
      downloadsDirectory: temporaryDirectory,
      fetcher: fetcher
    )

    do {
      _ = try await service.download(story: story)
      XCTFail("Expected download to fail for the missing audio remote URL.")
    } catch {
      XCTAssertEqual(error as? StoryDownloadServiceError, .invalidRemoteURL(assetID: "asset_audio"))
    }

    XCTAssertEqual(fetcher.requestedURLs, [])
    XCTAssertNil(story.state)
    XCTAssertEqual(try service.storageUsage().byteCount, 0)
  }

  @MainActor
  func testRejectsNonSuccessHTTPStatus() async throws {
    let story = makeStory()
    let fetcher = FakeDownloadAssetFetcher(responses: [
      Self.audioURL: .success(Self.response(data: Self.audioData, mimeType: "audio/mp4")),
      Self.coverURL: .success(Self.response(data: Self.coverData, statusCode: 503, mimeType: "image/png"))
    ])
    let service = try StoryDownloadService(
      downloadsDirectory: temporaryDirectory,
      fetcher: fetcher
    )

    do {
      _ = try await service.download(story: story)
      XCTFail("Expected download to fail for a non-success status.")
    } catch {
      XCTAssertEqual(error as? StoryDownloadServiceError, .rejectedStatusCode(503, assetID: "asset_cover"))
    }

    XCTAssertEqual(fetcher.requestedURLs, [Self.audioURL, Self.coverURL])
    XCTAssertNil(story.state)
    XCTAssertEqual(story.assets.compactMap(\.localFileName), [])
    XCTAssertEqual(try service.storageUsage().byteCount, 0)
  }

  private func makeStory(
    audioRemoteURLString: String?? = nil,
    coverRemoteURLString: String?? = nil
  ) -> PersistentStory {
    let resolvedAudioRemoteURLString = audioRemoteURLString ?? Self.audioURL.absoluteString
    let resolvedCoverRemoteURLString = coverRemoteURLString ?? Self.coverURL.absoluteString
    let story = PersistentStory(
      id: "story_offline",
      title: "A Quiet Offline Story",
      synopsis: "A calm fixture story.",
      kind: "daily-life",
      generationStatus: "completed",
      createdAt: Self.createdDate,
      updatedAt: Self.createdDate,
      durationSeconds: 1_800
    )
    story.assets = [
      PersistentAsset(
        id: "asset_audio",
        kind: "audio",
        remoteURLString: resolvedAudioRemoteURLString,
        mimeType: "audio/mp4",
        createdAt: Self.createdDate
      ),
      PersistentAsset(
        id: "asset_cover",
        kind: "coverImage",
        remoteURLString: resolvedCoverRemoteURLString,
        mimeType: "image/png",
        createdAt: Self.createdDate
      )
    ]
    return story
  }

  private static func response(
    data: Data,
    statusCode: Int = 200,
    mimeType: String
  ) -> (Data, URLResponse?) {
    (
      data,
      HTTPURLResponse(
        url: URL(string: "https://media.example.com")!,
        statusCode: statusCode,
        httpVersion: nil,
        headerFields: ["Content-Type": mimeType]
      )
    )
  }

  private func assertReadableAfterFirstUnlock(
    _ url: URL,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    #if os(iOS)
    do {
      let attributes = try FileManager.default.attributesOfItem(atPath: url.path(percentEncoded: false))
      let protection = attributes[.protectionKey] as? FileProtectionType
      #if targetEnvironment(simulator)
      if let protection {
        XCTAssertEqual(
          protection,
          .completeUntilFirstUserAuthentication,
          file: file,
          line: line
        )
      }
      #else
      XCTAssertEqual(
        protection,
        .completeUntilFirstUserAuthentication,
        file: file,
        line: line
      )
      #endif
    } catch {
      XCTFail("Could not read file protection attributes: \(error)", file: file, line: line)
    }
    #endif
  }

  private static let audioURL = URL(string: "https://media.example.com/story/audio.m4a")!
  private static let coverURL = URL(string: "https://media.example.com/story/cover.png")!
  private static let audioData = Data("audio-bytes".utf8)
  private static let coverData = Data("cover-bytes".utf8)
  private static let createdDate = Date(timeIntervalSince1970: 1_779_552_000)
  private static let downloadDate = Date(timeIntervalSince1970: 1_779_555_600)
  private static let deleteDate = Date(timeIntervalSince1970: 1_779_559_200)
}

private final class FakeDownloadAssetFetcher: DownloadAssetFetching, @unchecked Sendable {
  private let responses: [URL: Result<(Data, URLResponse?), Error>]
  private(set) var requestedURLs: [URL] = []
  private let fileManager = FileManager.default

  init(responses: [URL: Result<(Data, URLResponse?), Error>]) {
    self.responses = responses
  }

  func download(from url: URL, to temporaryDirectory: URL) async throws -> DownloadedAssetFile {
    requestedURLs.append(url)

    guard let result = responses[url] else {
      throw URLError(.fileDoesNotExist)
    }

    let (data, response) = try result.get()
    try fileManager.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
    let fileURL = temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: false)
    try data.write(to: fileURL)

    return DownloadedAssetFile(fileURL: fileURL, response: response)
  }
}
