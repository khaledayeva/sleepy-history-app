import Foundation
#if canImport(UIKit)
import UIKit
#endif

enum ArtworkVariant: String, CaseIterable {
  case full
  case thumbnail
  case placeholder
}

struct ArtworkCache {
  let baseURL: URL

  private let fileManager: FileManager

  init(baseURL: URL? = nil, fileManager: FileManager = .default) throws {
    self.fileManager = fileManager
    self.baseURL = try baseURL ?? Self.defaultBaseURL(fileManager: fileManager)
    try fileManager.createDirectory(at: self.baseURL, withIntermediateDirectories: true)
    try Self.excludeFromBackup(self.baseURL)
  }

  func store(_ data: Data, storyId: String, variant: ArtworkVariant) throws -> URL {
    let directory = directoryURL(for: storyId)
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    try Self.excludeFromBackup(directory)

    let fileURL = fileURL(storyId: storyId, variant: variant)
    try data.write(to: fileURL, options: [.atomic])
    try Self.excludeFromBackup(fileURL)
    return fileURL
  }

  func cachedData(storyId: String, variant: ArtworkVariant) throws -> Data? {
    let url = fileURL(storyId: storyId, variant: variant)
    guard fileManager.fileExists(atPath: url.path(percentEncoded: false)) else {
      return nil
    }

    return try Data(contentsOf: url)
  }

  #if canImport(UIKit)
  func cachedImage(storyId: String, variant: ArtworkVariant) throws -> UIImage? {
    guard let data = try cachedData(storyId: storyId, variant: variant) else {
      return nil
    }

    return UIImage(data: data)
  }
  #endif

  func removeArtwork(storyId: String) throws {
    let directory = directoryURL(for: storyId)
    guard fileManager.fileExists(atPath: directory.path(percentEncoded: false)) else {
      return
    }

    try fileManager.removeItem(at: directory)
  }

  private func directoryURL(for storyId: String) -> URL {
    baseURL.appendingPathComponent(Self.safePathComponent(storyId), isDirectory: true)
  }

  private func fileURL(storyId: String, variant: ArtworkVariant) -> URL {
    directoryURL(for: storyId).appendingPathComponent("\(variant.rawValue).png")
  }

  private static func defaultBaseURL(fileManager: FileManager) throws -> URL {
    let applicationSupport = try fileManager.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    return applicationSupport
      .appendingPathComponent("SleepyHistory", isDirectory: true)
      .appendingPathComponent("ArtworkCache", isDirectory: true)
  }

  private static func excludeFromBackup(_ url: URL) throws {
    var resourceValues = URLResourceValues()
    resourceValues.isExcludedFromBackup = true
    var mutableURL = url
    try mutableURL.setResourceValues(resourceValues)
  }

  private static func safePathComponent(_ value: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
    let scalars = value.unicodeScalars.map { scalar in
      allowed.contains(scalar) ? Character(scalar) : "_"
    }
    let sanitized = String(scalars)
    return sanitized.isEmpty ? "story" : sanitized
  }
}
