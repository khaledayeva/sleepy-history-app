import SwiftUI
import SwiftData

@main
struct SleepyHistoryApp: App {
  private let modelContainer: ModelContainer

  init() {
    if ProcessInfo.processInfo.arguments.contains("--reset-ui-testing-state") {
      UserDefaults.standard.removeObject(forKey: "sleepy-history.favorite-story-ids")
      UserDefaults.standard.removeObject(forKey: "sleepy-history.bookmarked-story-ids")
      UserDefaults.standard.removeObject(forKey: "sleepy-history.active-generation-job-id")
      UserDefaults.standard.removeObject(forKey: AIProviderDisclosure.acceptedStorageKey)
    }
    modelContainer = try! PersistenceContainerFactory.makeAppContainer()
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .modelContainer(modelContainer)
    }
  }
}
