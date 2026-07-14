import Foundation
import SwiftData

enum PersistenceContainerFactory {
  static let schema = Schema([
    PersistentStory.self,
    PersistentAsset.self,
    PersistentBookmark.self,
    PersistentChapter.self,
    PersistentSource.self,
    PersistentStoryState.self
  ])

  static func makeAppContainer() throws -> ModelContainer {
    try makeContainer()
  }

  static func makeInMemoryContainer() throws -> ModelContainer {
    try makeContainer(isStoredInMemoryOnly: true)
  }

  static func makeDiskContainer(at storeURL: URL) throws -> ModelContainer {
    try FileManager.default.createDirectory(
      at: storeURL.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )

    return try makeContainer(storeURL: storeURL, isStoredInMemoryOnly: false)
  }

  private static func makeContainer(
    storeURL: URL? = nil,
    isStoredInMemoryOnly: Bool = false
  ) throws -> ModelContainer {
    let configuration: ModelConfiguration

    if isStoredInMemoryOnly {
      configuration = ModelConfiguration(
        schema: schema,
        isStoredInMemoryOnly: true,
        allowsSave: true,
        cloudKitDatabase: .none
      )
    } else if let storeURL {
      configuration = ModelConfiguration(
        schema: schema,
        url: storeURL,
        allowsSave: true,
        cloudKitDatabase: .none
      )
    } else {
      configuration = ModelConfiguration(
        schema: schema,
        allowsSave: true,
        cloudKitDatabase: .none
      )
    }

    return try ModelContainer(
      for: schema,
      configurations: [configuration]
    )
  }
}
