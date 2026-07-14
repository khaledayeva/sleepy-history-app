import XCTest
@testable import SleepyHistory

final class ArtworkCacheTests: XCTestCase {
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

  func testStoresAndLoadsArtworkWithoutNetwork() throws {
    let cache = try ArtworkCache(baseURL: temporaryDirectory)
    let fileURL = try cache.store(Self.pngData, storyId: "story/offline art", variant: .thumbnail)

    let loaded = try cache.cachedData(storyId: "story/offline art", variant: .thumbnail)

    XCTAssertEqual(loaded, Self.pngData)
    XCTAssertTrue(FileManager.default.fileExists(atPath: fileURL.path(percentEncoded: false)))
    XCTAssertEqual(fileURL.lastPathComponent, "thumbnail.png")
    XCTAssertTrue(fileURL.path(percentEncoded: false).contains("story_offline_art"))
  }

  func testMissingArtworkReturnsNilInsteadOfFetching() throws {
    let cache = try ArtworkCache(baseURL: temporaryDirectory)

    let loaded = try cache.cachedData(storyId: "missing", variant: .full)

    XCTAssertNil(loaded)
  }

  func testGeneratedArtworkIsExcludedFromICloudBackup() throws {
    let cache = try ArtworkCache(baseURL: temporaryDirectory)
    let fileURL = try cache.store(Self.pngData, storyId: "story_backup", variant: .placeholder)

    let cacheValues = try temporaryDirectory.resourceValues(forKeys: [.isExcludedFromBackupKey])
    let fileValues = try fileURL.resourceValues(forKeys: [.isExcludedFromBackupKey])

    XCTAssertEqual(cacheValues.isExcludedFromBackup, true)
    XCTAssertEqual(fileValues.isExcludedFromBackup, true)
  }

  #if canImport(UIKit)
  func testCachedImageCanRenderFromStoredDataOffline() throws {
    let cache = try ArtworkCache(baseURL: temporaryDirectory)
    _ = try cache.store(Self.pngData, storyId: "story_render", variant: .full)

    let image = try cache.cachedImage(storyId: "story_render", variant: .full)

    XCTAssertNotNil(image)
    XCTAssertEqual(image?.size.width, 1)
    XCTAssertEqual(image?.size.height, 1)
  }
  #endif

  private static let pngData = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4cf7AfwAI0QOHKybRAwAAAABJRU5ErkJggg==")!
}
