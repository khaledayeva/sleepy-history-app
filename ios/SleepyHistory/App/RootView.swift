import SwiftData
import SwiftUI
import UIKit

struct RootView: View {
  @Environment(\.modelContext) private var modelContext
  @AppStorage("sleepy-history.bookmarked-story-ids") private var bookmarkedStoryIDsStorage = FixtureStory.defaultBookmarkedIDsStorage
  @AppStorage("sleepy-history.active-generation-job-id") private var activeGenerationJobID = ""
  @AppStorage(AIProviderDisclosure.acceptedStorageKey) private var hasAcceptedAIProviderDisclosure = false
  @Query(sort: \PersistentStory.updatedAt, order: .reverse) private var persistentStories: [PersistentStory]
  @Query(sort: \PersistentStoryState.updatedAt, order: .reverse) private var playbackStates: [PersistentStoryState]
  @State private var selectedTab: AppTab = .home
  @State private var nowPlayingStory: FixtureStory?
  @State private var lastPlayedStory: FixtureStory?
  @State private var createStoryPresentation: CreateStoryPresentation?
  @State private var submittedJob: FixtureGeneratedJob?
  @State private var submittedJobDraft: CreateStoryDraft?
  @State private var mockGeneratedStories: [FixtureStory] = []
  @State private var generationTask: Task<Void, Never>?
  @StateObject private var playbackService = PlaybackService()

  private var bookmarkedStoryIDs: Set<String> {
    Set(bookmarkedStoryIDsStorage.split(separator: ",").map(String.init))
  }

  private var playbackStateByStoryID: [String: PersistentStoryState] {
    Dictionary(uniqueKeysWithValues: playbackStates.map { ($0.storyID, $0) })
  }

  private var visibleStories: [FixtureStory] {
    let persistedGeneratedStories = persistentStories
      .map(FixtureStory.init(persistentStory:))
    let stories = FixtureStory.deduplicating(
      persistedGeneratedStories + mockGeneratedStories + FixtureStory.catalog
    )

    return stories.map { story in
      story.applying(playbackState: playbackStateByStoryID[story.id])
    }
  }

  private var continueListeningStory: FixtureStory {
    upNextStories.first ?? FixtureStory.continueListening
  }

  private var upNextStories: [FixtureStory] {
    FixtureStory.upNext(in: visibleStories, fallback: FixtureStory.continueListening)
  }

  private var miniPlayerStory: FixtureStory {
    let baseStory = lastPlayedStory ?? continueListeningStory
    let persistedStory = baseStory.applying(playbackState: playbackStateByStoryID[baseStory.id])

    return persistedStory.applying(playbackState: playbackService.state)
  }

  var body: some View {
    ZStack(alignment: .bottom) {
      TabView(selection: $selectedTab) {
        ForEach(AppTab.allCases) { tab in
          NavigationStack {
            AppTabScreen(
              tab: tab,
              bookmarkedStoryIDs: bookmarkedStoryIDs,
              storyCatalog: visibleStories,
              continueListeningStory: continueListeningStory,
              upNextStories: upNextStories,
              submittedJob: submittedJob,
              openCreateStory: { draft in
                openCreateStory(draft)
              },
              playStory: { story in
                lastPlayedStory = story
                nowPlayingStory = story
              },
              toggleBookmark: { story in
                toggleBookmark(story.id)
              },
              clearBookmarks: {
                bookmarkedStoryIDsStorage = FixtureStory.defaultBookmarkedIDsStorage
              },
              clearGeneratedDownloads: {
                mockGeneratedStories = mockGeneratedStories.map { story in
                  story.withDownloadState(isDownloaded: false, downloadDetail: "Streaming only")
                }
              },
              hasAcceptedAIProviderDisclosure: $hasAcceptedAIProviderDisclosure,
              submitCreateStory: { draft in
                submitCreateStory(draft)
              },
              cancelJob: { job in
                cancelGenerationJob(job)
              },
              retryJob: { job in
                retryGenerationJob(job)
              },
              deleteJob: { job in
                deleteGenerationJob(job)
              }
            )
          }
          .tabItem {
            Label(tab.title, systemImage: tab.systemImage)
          }
          .tag(tab)
          .accessibilityIdentifier(tab.accessibilityIdentifier)
        }
      }
      .toolbarBackground(SleepyTheme.ColorToken.tabBar, for: .tabBar)
      .toolbarBackground(.visible, for: .tabBar)
      .accessibilityIdentifier("sleepy-history-tab-shell")

      MiniPlayerBar(
        story: miniPlayerStory,
        playbackState: playbackService.state,
        openAction: {
          lastPlayedStory = miniPlayerStory
          nowPlayingStory = miniPlayerStory
        },
        togglePlayback: {
          toggleMiniPlayerPlayback(for: miniPlayerStory)
        }
      )
      .padding(.horizontal, SleepyTheme.Spacing.md)
      .padding(.bottom, 58)
    }
    .tint(SleepyTheme.ColorToken.gold)
    .preferredColorScheme(.dark)
    .onAppear {
      migrateLegacyFavoritesIfNeeded()
      applyLaunchTabOverrideIfNeeded()
      applyLaunchGenerationOverrideIfNeeded()
      resumeActiveGenerationIfNeeded()
    }
    .sheet(item: $createStoryPresentation) { presentation in
      NavigationStack {
        CreateStoryFlowView(
          initialDraft: presentation.draft,
          hasAcceptedAIProviderDisclosure: $hasAcceptedAIProviderDisclosure
        ) { draft in
          submitCreateStory(draft)
        }
      }
      .presentationDetents([.large])
      .presentationDragIndicator(.visible)
    }
    .sheet(item: $nowPlayingStory) { story in
      NowPlayingSheet(
        story: story.applying(playbackState: playbackStateByStoryID[story.id]),
        playbackService: playbackService,
        isBookmarked: Binding(
          get: { bookmarkedStoryIDs.contains(story.id) },
          set: { isBookmarked in
            setBookmark(story.id, isBookmarked: isBookmarked)
          }
        )
      )
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
  }

  private func toggleBookmark(_ storyID: String) {
    setBookmark(storyID, isBookmarked: !bookmarkedStoryIDs.contains(storyID))
  }

  private func setBookmark(_ storyID: String, isBookmarked: Bool) {
    var ids = bookmarkedStoryIDs
    if isBookmarked {
      ids.insert(storyID)
    } else {
      ids.remove(storyID)
    }
    bookmarkedStoryIDsStorage = ids.sorted().joined(separator: ",")
  }

  private func toggleMiniPlayerPlayback(for story: FixtureStory) {
    Task { @MainActor in
      do {
        playbackService.setPositionStore(SwiftDataPlaybackPositionStore(context: modelContext))
        playbackService.setBookmarkStore(SwiftDataPlaybackBookmarkStore(context: modelContext))

        if playbackService.state.storyID == story.id {
          if playbackService.state.status == .playing {
            try playbackService.pause()
          } else {
            try playbackService.play()
          }
        } else {
          lastPlayedStory = story
          let persistentStory = try await persistentStoryForMiniPlayback(story)
          let localAssetsDirectory = try await localAssetsDirectoryForPlayback(persistentStory)
          try playbackService.play(
            story: persistentStory,
            localAssetsDirectory: localAssetsDirectory
          )
        }
      } catch {
        lastPlayedStory = story
        nowPlayingStory = story
      }
    }
  }

  private func persistentStoryForMiniPlayback(_ story: FixtureStory) async throws -> PersistentStory {
    if let persistentStory = try fetchPersistentStory(id: story.id) {
      return try await refreshedStoryForRootPlayback(persistentStory)
    }

    if story.id == FixtureStory.continueListening.id,
       let apiStory = try? await SleepyHistoryAPIClient(apiBaseURL: AppConfiguration().apiBaseURL)
        .demoStory(id: FixtureStory.hostedStoryID) {
      return try upsertPersistentStory(APIStoryPersistenceMapper.makePersistentStory(from: apiStory))
    }

    let localAssetsDirectory = try Self.localAssetsDirectory()
    return try upsertPersistentStory(FullMockMode.makePersistentStory(
      from: story,
      localAssetsDirectory: localAssetsDirectory
    ))
  }

  private func refreshedStoryForRootPlayback(_ persistentStory: PersistentStory) async throws -> PersistentStory {
    if localAssetsDirectoryIfPresent(for: persistentStory) != nil {
      return persistentStory
    }

    if persistentStory.id == FixtureStory.hostedStoryID {
      let apiStory = try await SleepyHistoryAPIClient(
        apiBaseURL: AppConfiguration().apiBaseURL
      ).demoStory(id: FixtureStory.hostedStoryID)
      return try upsertPersistentStory(APIStoryPersistenceMapper.makePersistentStory(from: apiStory))
    }

    let apiStory = try await SleepyHistoryAPIClient(
      apiBaseURL: AppConfiguration().apiBaseURL
    ).story(id: persistentStory.id)
    return try upsertPersistentStory(APIStoryPersistenceMapper.makePersistentStory(from: apiStory))
  }

  private func localAssetsDirectoryForPlayback(_ persistentStory: PersistentStory) async throws -> URL? {
    if let localAssetsDirectory = localAssetsDirectoryIfPresent(for: persistentStory) {
      return localAssetsDirectory
    }

    guard shouldCacheAudioForPlayback(persistentStory) else {
      return nil
    }

    let service = try StoryDownloadService(context: modelContext)
    _ = try await service.downloadAudioForPlayback(story: persistentStory)
    return localAssetsDirectoryIfPresent(for: persistentStory) ?? service.localAssetsDirectory
  }

  private func shouldCacheAudioForPlayback(_ persistentStory: PersistentStory) -> Bool {
    guard let audioAsset = persistentStory.assets.first(where: { $0.kind.lowercased() == "audio" }) else {
      return false
    }

    return audioAsset.localFileName == nil && audioAsset.remoteURLString != nil
  }

  private func localAssetsDirectoryIfPresent(for persistentStory: PersistentStory) -> URL? {
    guard let localFileName = persistentStory.assets.first(where: { $0.kind == "audio" })?.localFileName else {
      return nil
    }

    let candidateDirectories = [
      try? StoryDownloadService(context: modelContext).localAssetsDirectory,
      try? Self.localAssetsDirectory()
    ].compactMap { $0 }

    return candidateDirectories.first { directory in
      FileManager.default.fileExists(
        atPath: directory.appendingPathComponent(localFileName).path(percentEncoded: false)
      )
    }
  }

  private func openCreateStory(_ draft: CreateStoryDraft?) {
    createStoryPresentation = CreateStoryPresentation(draft: draft ?? CreateStoryDraft())
  }

  private func submitMockStory(_ draft: CreateStoryDraft) {
    let generatedStory = FullMockMode.makeFixtureStory(from: draft)
    mockGeneratedStories.removeAll { $0.id == generatedStory.id }
    mockGeneratedStories.insert(generatedStory, at: 0)
    submittedJob = FixtureGeneratedJob(completedStory: generatedStory, draft: draft)
    submittedJobDraft = draft
    createStoryPresentation = nil
    selectedTab = .library
  }

  private func submitCreateStory(_ draft: CreateStoryDraft) {
    if ProcessInfo.processInfo.arguments.contains("--use-mock-generation") {
      submitMockStory(draft)
      return
    }

    let initialJob = FixtureGeneratedJob(draft: draft)
    submittedJob = initialJob
    submittedJobDraft = draft
    createStoryPresentation = nil
    selectedTab = .library

    generationTask?.cancel()
    generationTask = Task {
      await submitHostedStory(draft, fallbackJob: initialJob)
    }
  }

  @MainActor
  private func submitHostedStory(_ draft: CreateStoryDraft, fallbackJob: FixtureGeneratedJob) async {
    do {
      let client = try apiClient()
      let created = try await client.createGenerationJob(draft.apiRequest)
      activeGenerationJobID = created.job.id
      submittedJob = FixtureGeneratedJob(createdJob: created.job, draft: draft)
      await pollGenerationJob(id: created.job.id, draft: draft)
    } catch SleepyHistoryAPIClientError.missingEnrollmentToken {
      if ProcessInfo.processInfo.arguments.contains("--use-mock-generation") {
        submitMockStory(draft)
      } else {
        submittedJob = fallbackJob.failedForDisplay(message: "Enroll this iPhone in Settings before generating a real story.")
      }
    } catch {
      let failure = userFacingGenerationFailure(error)
      submittedJob = fallbackJob.failedForDisplay(message: failure.message, state: failure.state)
    }
  }

  @MainActor
  private func pollGenerationJob(id jobID: String, draft: CreateStoryDraft?) async {
    do {
      let client = try apiClient()

      while !Task.isCancelled {
        do {
          try await Task.sleep(for: .seconds(4))
        } catch {
          return
        }

        do {
          let apiJob = try await client.generationJob(id: jobID)
          submittedJob = FixtureGeneratedJob(apiJob: apiJob)

          if apiJob.status == "completed", let storyID = apiJob.storyId {
            let apiStory = try await client.story(id: storyID)
            try importCompletedStory(apiStory, draft: draft, jobID: apiJob.id)
            return
          }

          if apiJob.status == "failed" || apiJob.status == "canceled" {
            activeGenerationJobID = ""
            return
          }
        } catch {
          if submittedJob?.id == jobID {
            let message = transientGenerationInterruptionMessage(error)
            submittedJob = submittedJob?.interruptedForDisplay(message: message)
          }
        }
      }
    } catch {
      if submittedJob?.id == jobID {
        let failure = userFacingGenerationFailure(error)
        submittedJob = submittedJob?.failedForDisplay(message: failure.message, state: failure.state)
      }
    }
  }

  private func resumeActiveGenerationIfNeeded() {
    guard !activeGenerationJobID.isEmpty,
          submittedJob == nil,
          generationTask == nil else {
      return
    }

    let jobID = activeGenerationJobID
    submittedJob = FixtureGeneratedJob.resuming(jobID: jobID)
    generationTask = Task {
      await pollGenerationJob(id: jobID, draft: nil)
    }
  }

  private func cancelGenerationJob(_ job: FixtureGeneratedJob) {
    guard !job.isLocalOnly else {
      applyJob(job, state: .canceled)
      return
    }

    generationTask?.cancel()
    Task {
      do {
        let client = try apiClient()
        let apiJob = try await client.cancelGenerationJob(id: job.id)
        submittedJob = FixtureGeneratedJob(apiJob: apiJob)
        if activeGenerationJobID == job.id {
          activeGenerationJobID = ""
        }
      } catch {
        if submittedJob?.id == job.id {
          let failure = userFacingGenerationFailure(error)
          submittedJob = job.failedForDisplay(message: failure.message, state: failure.state)
        }
      }
    }
  }

  private func retryGenerationJob(_ job: FixtureGeneratedJob) {
    guard !job.isLocalOnly else {
      if let submittedJobDraft {
        submitCreateStory(submittedJobDraft)
      } else {
        submittedJob = job.failedForDisplay(message: "Open Create and start this story again.")
      }
      return
    }

    Task {
      do {
        let client = try apiClient()
        if let storyID = job.storyID {
          let apiStory = try await client.story(id: storyID)
          try importCompletedStory(apiStory, draft: nil, jobID: job.id)
          return
        }

        let currentJob = try await client.generationJob(id: job.id)
        switch GenerationRetryPolicy.disposition(for: currentJob) {
        case .importCompletedStory(let storyID):
          let apiStory = try await client.story(id: storyID)
          try importCompletedStory(apiStory, draft: nil, jobID: currentJob.id)
          return
        case .resumePolling:
          activeGenerationJobID = currentJob.id
          submittedJob = FixtureGeneratedJob(apiJob: currentJob)
          await pollGenerationJob(id: currentJob.id, draft: submittedJobDraft)
          return
        case .retryEndpoint:
          break
        }

        let apiJob = try await client.retryGenerationJob(id: currentJob.id)
        activeGenerationJobID = apiJob.id
        submittedJob = FixtureGeneratedJob(apiJob: apiJob)
        if FixtureGeneratedJobState(apiStatus: apiJob.status, progress: Double(apiJob.progress.percent) / 100, apiError: apiJob.error) == .running {
          await pollGenerationJob(id: apiJob.id, draft: submittedJobDraft)
        } else if activeGenerationJobID == apiJob.id {
          activeGenerationJobID = ""
        }
      } catch {
        if submittedJob?.id == job.id {
          let failure = userFacingGenerationFailure(error)
          submittedJob = job.failedForDisplay(message: failure.message, state: failure.state)
        }
      }
    }
  }

  private func deleteGenerationJob(_ job: FixtureGeneratedJob) {
    if job.isLocalOnly {
      mockGeneratedStories.removeAll { $0.id == job.storyID }
      if submittedJob?.id == job.id {
        submittedJob = nil
        submittedJobDraft = nil
      }
      return
    }

    generationTask?.cancel()
    Task {
      do {
        let client = try apiClient()
        _ = try await client.deleteGenerationJob(id: job.id)
        if let storyID = job.storyID {
          try deletePersistentStory(id: storyID)
        }
        if submittedJob?.id == job.id {
          submittedJob = nil
          submittedJobDraft = nil
        }
        if activeGenerationJobID == job.id {
          activeGenerationJobID = ""
        }
      } catch {
        if submittedJob?.id == job.id {
          let failure = userFacingGenerationFailure(error)
          submittedJob = job.failedForDisplay(message: failure.message, state: failure.state)
        }
      }
    }
  }

  @MainActor
  private func updateJobFromBackend(
    _ jobID: String,
    operation: (SleepyHistoryAPIClient) async throws -> APIGenerationJob
  ) async {
    do {
      let client = try apiClient()
      let apiJob = try await operation(client)
      submittedJob = FixtureGeneratedJob(apiJob: apiJob)
    } catch {
      if submittedJob?.id == jobID {
        let failure = userFacingGenerationFailure(error)
        submittedJob = submittedJob?.failedForDisplay(message: failure.message, state: failure.state)
      }
    }
  }

  private func apiClient() throws -> SleepyHistoryAPIClient {
    SleepyHistoryAPIClient(apiBaseURL: try AppConfiguration().apiBaseURL)
  }

  @MainActor
  private func importCompletedStory(_ apiStory: APIStory, draft: CreateStoryDraft?, jobID: String) throws {
    _ = try upsertPersistentStory(APIStoryPersistenceMapper.makePersistentStory(from: apiStory))
    submittedJob = nil
    activeGenerationJobID = ""
    selectedTab = .library
  }

  private func applyLaunchGenerationOverrideIfNeeded() {
    #if DEBUG
    guard let jobID = ProcessInfo.processInfo.arguments.value(after: "--resume-generation-job-id"),
          !jobID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return
    }
    activeGenerationJobID = jobID
    #endif
  }

  private func applyLaunchTabOverrideIfNeeded() {
    #if DEBUG
    guard let rawTab = ProcessInfo.processInfo.arguments.value(after: "--initial-tab"),
          let tab = AppTab(rawValue: rawTab) else {
      return
    }
    selectedTab = tab
    #endif
  }

  private func userFacingGenerationError(_ error: Error) -> String {
    if case let SleepyHistoryAPIClientError.api(apiError, _) = error {
      return apiError.userFacingGenerationMessage
    }
    if error is AppConfigurationError {
      return "Backend URL is not configured."
    }
    return "Generation could not continue. Check the backend connection and try again."
  }

  private func userFacingGenerationFailure(_ error: Error) -> (message: String, state: FixtureGeneratedJobState) {
    if case let SleepyHistoryAPIClientError.api(apiError, _) = error {
      return (
        apiError.userFacingGenerationMessage,
        apiError.isBudgetLimit ? .budgetLimit : .failed
      )
    }

    return (userFacingGenerationError(error), .failed)
  }

  private func transientGenerationInterruptionMessage(_ error: Error) -> String {
    if error is AppConfigurationError {
      return "Backend URL is not configured."
    }
    return "Backend connection interrupted. Reconnecting to the generation job."
  }

  private func upsertPersistentStory(_ mappedStory: PersistentStory) throws -> PersistentStory {
    if let existingStory = try fetchPersistentStory(id: mappedStory.id) {
      let refreshedStory = try updatePersistentStory(
        existingStory,
        from: mappedStory,
        in: modelContext
      )
      if refreshedStory.state == nil,
         let existingState = try fetchPersistentStoryState(storyID: mappedStory.id) {
        refreshedStory.state = existingState
        existingState.story = refreshedStory
      }

      try modelContext.save()
      return refreshedStory
    }

    if let existingState = try fetchPersistentStoryState(storyID: mappedStory.id) {
      mappedStory.state = existingState
      existingState.story = mappedStory
    }

    modelContext.insert(mappedStory)
    try modelContext.save()
    return mappedStory
  }

  private func fetchPersistentStory(id: String) throws -> PersistentStory? {
    var descriptor = FetchDescriptor<PersistentStory>(
      predicate: #Predicate { $0.id == id }
    )
    descriptor.fetchLimit = 1

    return try modelContext.fetch(descriptor).first
  }

  private func fetchPersistentStoryState(storyID: String) throws -> PersistentStoryState? {
    var descriptor = FetchDescriptor<PersistentStoryState>(
      predicate: #Predicate { $0.storyID == storyID }
    )
    descriptor.fetchLimit = 1

    return try modelContext.fetch(descriptor).first
  }

  private func deletePersistentStory(id storyID: String) throws {
    guard let story = try fetchPersistentStory(id: storyID) else {
      return
    }

    modelContext.delete(story)
    try modelContext.save()
  }

  private func applyJob(_ job: FixtureGeneratedJob, state: FixtureGeneratedJobState) {
    var updatedJob = job
    updatedJob.state = state
    switch state {
    case .running:
      updatedJob.progress = 0.12
      updatedJob.stage = "Retrying"
      updatedJob.message = "Restarting from the last quiet checkpoint"
      updatedJob.failureReason = nil
    case .canceled:
      updatedJob.progress = 1
      updatedJob.stage = "Canceled"
      updatedJob.message = "Generation was canceled"
    case .partial, .failed, .budgetLimit, .completed:
      break
    }

    if submittedJob?.id == job.id {
      submittedJob = updatedJob
    }
  }

  private func migrateLegacyFavoritesIfNeeded() {
    guard bookmarkedStoryIDsStorage.isEmpty,
          let legacyValue = UserDefaults.standard.string(forKey: "sleepy-history.favorite-story-ids") else {
      return
    }

    let validStoryIDs = Set(FixtureStory.catalog.map(\.id))
    let migratedIDs = Set(legacyValue.split(separator: ",").compactMap { rawID -> String? in
      let id = String(rawID)
      if id == "alexandria-harbor" {
        return FixtureStory.hostedStoryID
      }

      return validStoryIDs.contains(id) ? id : nil
    })

    if !migratedIDs.isEmpty {
      bookmarkedStoryIDsStorage = migratedIDs.sorted().joined(separator: ",")
    }
    UserDefaults.standard.removeObject(forKey: "sleepy-history.favorite-story-ids")
  }

  private static func localAssetsDirectory() throws -> URL {
    guard let baseURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      throw CocoaError(.fileNoSuchFile)
    }

    return baseURL.appendingPathComponent("MockModeAudio", isDirectory: true)
  }
}

enum AppTab: String, CaseIterable, Identifiable {
  case home
  case library
  case create
  case bookmarks
  case settings

  var id: String { rawValue }

  var title: String {
    switch self {
    case .home:
      return "Home"
    case .create:
      return "Create"
    case .library:
      return "Library"
    case .bookmarks:
      return "Bookmarks"
    case .settings:
      return "Settings"
    }
  }

  var systemImage: String {
    switch self {
    case .home:
      return "house.fill"
    case .create:
      return "plus.square.fill"
    case .library:
      return "books.vertical.fill"
    case .bookmarks:
      return "bookmark.fill"
    case .settings:
      return "gearshape.fill"
    }
  }

  var accessibilityIdentifier: String {
    "tab-\(rawValue)"
  }
}

enum FixtureStoryStatus: String, CaseIterable {
  case completed
  case inProgress
  case failed

  var label: String {
    switch self {
    case .completed:
      return "Completed"
    case .inProgress:
      return "In progress"
    case .failed:
      return "Failed"
    }
  }

  var systemImage: String {
    switch self {
    case .completed:
      return "checkmark.seal.fill"
    case .inProgress:
      return "hourglass"
    case .failed:
      return "exclamationmark.triangle.fill"
    }
  }
}

enum LibraryStoryFilter: String, CaseIterable, Identifiable {
  case all
  case downloaded
  case inProgress
  case completed
  case failed

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all:
      return "All"
    case .downloaded:
      return "Downloaded"
    case .completed:
      return "Completed"
    case .inProgress:
      return "In Progress"
    case .failed:
      return "Failed"
    }
  }

  var accessibilityIdentifier: String {
    "library-filter-\(rawValue)"
  }

  func includes(_ story: FixtureStory) -> Bool {
    switch self {
    case .all:
      return true
    case .downloaded:
      return story.isDownloaded
    case .completed:
      return story.status == .completed && story.progress >= 0.99
    case .inProgress:
      return story.status == .inProgress || (story.status == .completed && story.progress > 0 && story.progress < 0.99)
    case .failed:
      return story.status == .failed
    }
  }
}

struct FixtureStory: Identifiable, Equatable {
  let id: String
  let title: String
  let subtitle: String
  let synopsis: String
  let category: String
  let symbol: String
  let chapter: String
  let durationMinutes: Int
  let currentTime: String
  let remainingTime: String
  let progress: Double
  let status: FixtureStoryStatus
  let isDownloaded: Bool
  let isBookmarked: Bool
  let downloadDetail: String
  let failureReason: String?
  let transcriptSections: [FixtureTranscriptSection]
  let sourceLinks: [FixtureSourceLink]
  let coverRemoteURLString: String?
  let coverLocalFileName: String?
  let createdAt: Date?
  let updatedAt: Date?
  let lastPlayedAt: Date?

  static let hostedStoryID = "story_full_length_acceptance"
  static let defaultBookmarkedIDsStorage = ""

  init(
    id: String,
    title: String,
    subtitle: String,
    synopsis: String,
    category: String,
    symbol: String,
    chapter: String,
    durationMinutes: Int,
    currentTime: String,
    remainingTime: String,
    progress: Double,
    status: FixtureStoryStatus,
    isDownloaded: Bool,
    isBookmarked: Bool,
    downloadDetail: String,
    failureReason: String?,
    transcriptSections: [FixtureTranscriptSection]? = nil,
    sourceLinks: [FixtureSourceLink]? = nil,
    coverRemoteURLString: String? = nil,
    coverLocalFileName: String? = nil,
    createdAt: Date? = nil,
    updatedAt: Date? = nil,
    lastPlayedAt: Date? = nil
  ) {
    self.id = id
    self.title = title
    self.subtitle = subtitle
    self.synopsis = synopsis
    self.category = category
    self.symbol = symbol
    self.chapter = chapter
    self.durationMinutes = durationMinutes
    self.currentTime = currentTime
    self.remainingTime = remainingTime
    self.progress = progress
    self.status = status
    self.isDownloaded = isDownloaded
    self.isBookmarked = isBookmarked
    self.downloadDetail = downloadDetail
    self.failureReason = failureReason
    self.transcriptSections = transcriptSections ?? Self.fallbackTranscriptSections(
      category: category,
      synopsis: synopsis
    )
    self.sourceLinks = sourceLinks ?? Self.fallbackSourceLinks
    self.coverRemoteURLString = coverRemoteURLString
    self.coverLocalFileName = coverLocalFileName
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.lastPlayedAt = lastPlayedAt
  }

  var progressLabel: String {
    switch status {
    case .completed:
      if progress >= 0.99 {
        return "Finished"
      }
      if progress > 0 {
        return "\(Int(progress * 100))% listened"
      }
      return "Not started"
    case .inProgress:
      return "\(Int(progress * 100))% generated"
    case .failed:
      return failureReason ?? "Needs attention"
    }
  }

  var progressStatusLabel: String {
    switch status {
    case .completed:
      if progress >= 0.99 {
        return "Finished"
      }
      return progress > 0 ? "In progress" : "Not started"
    case .inProgress:
      return status.label
    case .failed:
      return status.label
    }
  }

  var progressStatusSystemImage: String {
    switch status {
    case .completed:
      if progress >= 0.99 {
        return "checkmark.seal.fill"
      }
      return progress > 0 ? "play.circle.fill" : "moon.zzz.fill"
    case .inProgress, .failed:
      return status.systemImage
    }
  }

  var durationLabel: String {
    "\(durationMinutes) min"
  }

  var totalTimeLabel: String {
    Self.timeLabel(for: TimeInterval(durationMinutes * 60))
  }

  var searchText: String {
    [
      title,
      subtitle,
      synopsis,
      category,
      status.label,
      failureReason ?? "",
      isDownloaded ? "downloaded" : ""
    ].joined(separator: " ").lowercased()
  }

  var lastListenedLabel: String {
    guard let lastPlayedAt else {
      return "Not listened yet"
    }

    return Self.lastListenedLabel(for: lastPlayedAt)
  }

  static let catalog: [FixtureStory] = [
    FixtureStory(
      id: Self.hostedStoryID,
      title: "The Library at Alexandria",
      subtitle: "A scribe closes the quiet halls",
      synopsis: "A calm original bedtime history following an ordinary library scribe through the end of a gentle workday in Ptolemaic Alexandria.",
      category: "Daily Life",
      symbol: "book.closed.fill",
      chapter: "Chapter 1: The Scribes Close Their Inkwells",
      durationMinutes: 59,
      currentTime: "00:00",
      remainingTime: "-59:08",
      progress: 0,
      status: .completed,
      isDownloaded: false,
      isBookmarked: false,
      downloadDetail: "Stream from hosted library",
      failureReason: nil,
      transcriptSections: [
        FixtureTranscriptSection(
          title: "Opening",
          text: "The lamps are lowered, the room settles, and the story begins in the quiet halls of Alexandria."
        ),
        FixtureTranscriptSection(
          title: "The Workday Softens",
          text: "A scribe puts away the day's last scrolls, listens to sandals on stone, and lets the library's routines slow toward evening."
        ),
        FixtureTranscriptSection(
          title: "Closing",
          text: "The final minutes return to small routines, soft footsteps, and the kind of quiet detail meant for sleep."
        )
      ],
      sourceLinks: [
        FixtureSourceLink(
          title: "Library of Alexandria background dossier",
          publisher: "Sleepy History Research",
          url: nil,
          notes: "Used for the setting, institutional roles, and gentle daily-life texture around Ptolemaic Alexandria."
        ),
        FixtureSourceLink(
          title: "Hellenistic scribal work notes",
          publisher: "Sleepy History Research",
          url: nil,
          notes: "Used for writing materials, closing routines, and low-drama work rhythms in the story."
        )
      ]
    )
  ]

  static var continueListening: FixtureStory {
    catalog[0]
  }

  static var recent: [FixtureStory] {
    Array(catalog.prefix(4))
  }

  static var bookmarks: [FixtureStory] {
    catalog.filter(\.isBookmarked)
  }

  static func bookmarks(in bookmarkedIDs: Set<String>) -> [FixtureStory] {
    catalog.filter { bookmarkedIDs.contains($0.id) }
  }

  static func bookmarks(in bookmarkedIDs: Set<String>, from stories: [FixtureStory]) -> [FixtureStory] {
    stories.filter { bookmarkedIDs.contains($0.id) }
  }

  static func library(
    matching filter: LibraryStoryFilter,
    searchText: String
  ) -> [FixtureStory] {
    library(in: catalog, matching: filter, searchText: searchText)
  }

  static func library(
    in stories: [FixtureStory],
    matching filter: LibraryStoryFilter,
    searchText: String
  ) -> [FixtureStory] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

    return stories.filter { story in
      filter.includes(story) && (query.isEmpty || story.searchText.contains(query))
    }
  }

  static func deduplicating(_ stories: [FixtureStory]) -> [FixtureStory] {
    var seenIDs: Set<String> = []
    return stories.filter { story in
      if seenIDs.contains(story.id) {
        return false
      }

      seenIDs.insert(story.id)
      return true
    }
  }

  static func upNext(in stories: [FixtureStory], fallback: FixtureStory) -> [FixtureStory] {
    let candidates = deduplicating(stories.isEmpty ? [fallback] : stories)
      .filter { $0.status != .failed }

    let sorted = candidates.sorted { lhs, rhs in
      if lhs.isActivelyListened != rhs.isActivelyListened {
        return lhs.isActivelyListened && !rhs.isActivelyListened
      }
      if lhs.status != rhs.status {
        return lhs.status == .inProgress
      }

      let lhsDate = lhs.lastPlayedAt ?? lhs.updatedAt ?? lhs.createdAt ?? .distantPast
      let rhsDate = rhs.lastPlayedAt ?? rhs.updatedAt ?? rhs.createdAt ?? .distantPast
      if lhsDate != rhsDate {
        return lhsDate > rhsDate
      }

      return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
    }

    return Array((sorted.isEmpty ? [fallback] : sorted).prefix(2))
  }

  init(persistentStory: PersistentStory) {
    let durationSeconds = max(persistentStory.durationSeconds, 60)
    let durationMinutes = max(Int((durationSeconds / 60).rounded()), 1)
    let status: FixtureStoryStatus
    let failureReason: String?
    let chapters = persistentStory.chapters.sorted { $0.index < $1.index }
    let sources = persistentStory.sources.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    let coverAsset = Self.preferredCoverAsset(from: persistentStory.assets)
    let normalizedKind = persistentStory.kind.replacingOccurrences(of: "-", with: "_")
    let isHistoricalFigure = normalizedKind == "historical_figure" || normalizedKind == "historicalFigure"
    let category = isHistoricalFigure ? "Historical Figure" : "Daily Life"

    switch persistentStory.generationStatus.lowercased() {
    case "completed":
      status = .completed
      failureReason = nil
    case "failed":
      status = .failed
      failureReason = "Generation failed"
    default:
      status = .inProgress
      failureReason = nil
    }

    self.init(
      id: persistentStory.id,
      title: persistentStory.title.sleepyDisplayTitle,
      subtitle: category,
      synopsis: persistentStory.synopsis,
      category: category,
      symbol: Self.symbol(forTitle: persistentStory.title, category: category),
      chapter: persistentStory.state?.playbackChapterID ?? chapters.first.map { "Chapter \($0.index): \($0.title)" } ?? "Generated story",
      durationMinutes: durationMinutes,
      currentTime: "0:00",
      remainingTime: "-\(Self.timeLabel(for: durationSeconds))",
      progress: status == .inProgress ? 0.18 : 0,
      status: status,
      isDownloaded: persistentStory.state?.isDownloaded ?? false,
      isBookmarked: persistentStory.state?.isFavorite ?? false,
      downloadDetail: persistentStory.state?.isDownloaded == true ? "Available offline" : "Stream from generated library",
      failureReason: failureReason,
      transcriptSections: Self.transcriptSections(
        from: chapters,
        category: category,
        synopsis: persistentStory.synopsis
      ),
      sourceLinks: Self.sourceLinks(from: sources),
      coverRemoteURLString: coverAsset?.remoteURLString,
      coverLocalFileName: coverAsset?.localFileName,
      createdAt: persistentStory.createdAt,
      updatedAt: persistentStory.updatedAt,
      lastPlayedAt: persistentStory.state?.lastPlayedAt
    )
  }

  var funFacts: [String] {
    [
      "The story keeps dates and daily routines deliberately low-drama.",
      "Pronunciation notes are prepared before narration.",
      "The chapter plan favors repeated, familiar settings over sudden scene changes."
    ]
  }

  private var isActivelyListened: Bool {
    status == .completed && progress > 0 && progress < 0.99
  }

  var aboutText: String {
    "\(title) is an original generated bedtime history story prepared as a long, calm listen for winding down."
  }

  func applying(playbackState: PersistentStoryState?) -> FixtureStory {
    guard let playbackState else {
      return self
    }

    let fallbackDuration = TimeInterval(durationMinutes * 60)
    let durationSeconds = playbackState.playbackDurationSeconds > 0 ? playbackState.playbackDurationSeconds : fallbackDuration
    let positionSeconds = min(max(playbackState.playbackPositionSeconds, 0), max(durationSeconds, 0))
    let derivedProgress = durationSeconds > 0 ? min(max(positionSeconds / durationSeconds, 0), 1) : progress

    return FixtureStory(
      id: id,
      title: title,
      subtitle: subtitle,
      synopsis: synopsis,
      category: category,
      symbol: symbol,
      chapter: playbackState.playbackChapterID ?? chapter,
      durationMinutes: max(Int((durationSeconds / 60).rounded()), durationMinutes),
      currentTime: Self.timeLabel(for: positionSeconds),
      remainingTime: "-\(Self.timeLabel(for: max(durationSeconds - positionSeconds, 0)))",
      progress: derivedProgress,
      status: status,
      isDownloaded: playbackState.isDownloaded || isDownloaded,
      isBookmarked: isBookmarked,
      downloadDetail: playbackState.isDownloaded ? "Available offline" : downloadDetail,
      failureReason: failureReason,
      transcriptSections: transcriptSections,
      sourceLinks: sourceLinks,
      coverRemoteURLString: coverRemoteURLString,
      coverLocalFileName: coverLocalFileName,
      createdAt: createdAt,
      updatedAt: updatedAt,
      lastPlayedAt: playbackState.lastPlayedAt ?? lastPlayedAt
    )
  }

  func applying(playbackState: PlaybackState) -> FixtureStory {
    guard playbackState.storyID == id else {
      return self
    }

    let fallbackDuration = TimeInterval(durationMinutes * 60)
    let durationSeconds = playbackState.durationSeconds > 0 ? playbackState.durationSeconds : fallbackDuration
    let positionSeconds = min(max(playbackState.positionSeconds, 0), max(durationSeconds, 0))
    let derivedProgress = durationSeconds > 0 ? min(max(positionSeconds / durationSeconds, 0), 1) : progress

    return FixtureStory(
      id: id,
      title: title,
      subtitle: subtitle,
      synopsis: synopsis,
      category: category,
      symbol: symbol,
      chapter: playbackState.chapterID ?? chapter,
      durationMinutes: max(Int((durationSeconds / 60).rounded()), durationMinutes),
      currentTime: Self.timeLabel(for: positionSeconds),
      remainingTime: "-\(Self.timeLabel(for: max(durationSeconds - positionSeconds, 0)))",
      progress: derivedProgress,
      status: status,
      isDownloaded: isDownloaded,
      isBookmarked: isBookmarked,
      downloadDetail: downloadDetail,
      failureReason: failureReason,
      transcriptSections: transcriptSections,
      sourceLinks: sourceLinks,
      coverRemoteURLString: coverRemoteURLString,
      coverLocalFileName: coverLocalFileName,
      createdAt: createdAt,
      updatedAt: updatedAt,
      lastPlayedAt: playbackState.positionSeconds > 0 ? Date() : lastPlayedAt
    )
  }

  func withDownloadState(isDownloaded: Bool, downloadDetail: String) -> FixtureStory {
    FixtureStory(
      id: id,
      title: title,
      subtitle: subtitle,
      synopsis: synopsis,
      category: category,
      symbol: symbol,
      chapter: chapter,
      durationMinutes: durationMinutes,
      currentTime: currentTime,
      remainingTime: remainingTime,
      progress: progress,
      status: status,
      isDownloaded: isDownloaded,
      isBookmarked: isBookmarked,
      downloadDetail: downloadDetail,
      failureReason: failureReason,
      transcriptSections: transcriptSections,
      sourceLinks: sourceLinks,
      coverRemoteURLString: coverRemoteURLString,
      coverLocalFileName: coverLocalFileName,
      createdAt: createdAt,
      updatedAt: updatedAt,
      lastPlayedAt: lastPlayedAt
    )
  }

  private static func transcriptSections(
    from chapters: [PersistentChapter],
    category: String,
    synopsis: String
  ) -> [FixtureTranscriptSection] {
    let sections = chapters
      .filter { !$0.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
      .map { chapter in
        FixtureTranscriptSection(title: "Chapter \(chapter.index): \(chapter.title)", text: chapter.transcript)
      }

    return sections.isEmpty ? fallbackTranscriptSections(category: category, synopsis: synopsis) : sections
  }

  private static func sourceLinks(from sources: [PersistentSource]) -> [FixtureSourceLink] {
    let links = sources.map { source in
      FixtureSourceLink(
        title: source.title,
        publisher: source.publisher ?? "Source",
        url: source.urlString.flatMap(URL.init(string:)),
        notes: source.notes,
        retrievedAt: source.retrievedAt
      )
    }

    return links.isEmpty ? fallbackSourceLinks : links
  }

  private static func preferredCoverAsset(from assets: [PersistentAsset]) -> PersistentAsset? {
    let preferredKinds = ["cover_thumbnail", "coverimage", "cover_full", "cover", "artwork", "placeholder"]
    return assets.sorted { lhs, rhs in
      let lhsKind = lhs.kind.lowercased()
      let rhsKind = rhs.kind.lowercased()
      let lhsRank = preferredKinds.firstIndex(of: lhsKind) ?? Int.max
      let rhsRank = preferredKinds.firstIndex(of: rhsKind) ?? Int.max
      if lhsRank == rhsRank {
        return lhs.localFileName != nil && rhs.localFileName == nil
      }
      return lhsRank < rhsRank
    }.first { asset in
      let kind = asset.kind.lowercased()
      let mimeType = asset.mimeType?.lowercased() ?? ""
      return kind.contains("cover") || kind.contains("image") || kind.contains("artwork") || mimeType.hasPrefix("image/")
    }
  }

  static func symbol(forTitle _: String, category _: String) -> String {
    "book.closed.fill"
  }

  private static func fallbackTranscriptSections(category: String, synopsis: String) -> [FixtureTranscriptSection] {
    [
      FixtureTranscriptSection(
        title: "Opening",
        text: "The lamps are lowered, the room settles, and the story begins with ordinary sounds from \(category.lowercased())."
      ),
      FixtureTranscriptSection(title: "Middle", text: synopsis),
      FixtureTranscriptSection(
        title: "Closing",
        text: "The final minutes return to small routines, soft footsteps, and the kind of quiet detail meant for sleep."
      )
    ]
  }

  private static var fallbackSourceLinks: [FixtureSourceLink] {
    [
      FixtureSourceLink(title: "Generated source dossier", publisher: "Sleepy History", url: nil)
    ]
  }

  static func timeLabel(for seconds: TimeInterval) -> String {
    let totalSeconds = max(Int(seconds.rounded()), 0)
    let hours = totalSeconds / 3_600
    let minutes = (totalSeconds % 3_600) / 60
    let seconds = totalSeconds % 60

    if hours > 0 {
      return "\(hours):\(String(format: "%02d", minutes)):\(String(format: "%02d", seconds))"
    }

    return "\(minutes):\(String(format: "%02d", seconds))"
  }

  static func lastListenedLabel(for date: Date, now: Date = Date()) -> String {
    let calendar = Calendar.current
    let startOfDate = calendar.startOfDay(for: date)
    let startOfNow = calendar.startOfDay(for: now)
    let dayDelta = calendar.dateComponents([.day], from: startOfDate, to: startOfNow).day ?? Int.max

    if dayDelta >= 0 && dayDelta < 7 {
      let formatter = DateFormatter()
      formatter.locale = Locale(identifier: "en_US_POSIX")
      formatter.dateFormat = "EEEE"
      return formatter.string(from: date)
    }

    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "MMM d, yyyy"
    return formatter.string(from: date)
  }
}

struct FixtureTranscriptSection: Identifiable, Equatable {
  let id: String
  let title: String
  let text: String

  init(title: String, text: String) {
    self.title = title
    self.text = text
    id = "\(title)-\(text.prefix(24))"
  }
}

struct FixtureSourceLink: Identifiable, Equatable {
  let title: String
  let publisher: String
  let url: URL?
  let notes: String?
  let retrievedAt: String?

  init(title: String, publisher: String, url: URL?, notes: String? = nil, retrievedAt: String? = nil) {
    self.title = title
    self.publisher = publisher
    self.url = url
    self.notes = notes
    self.retrievedAt = retrievedAt
  }

  var id: String { "\(title)-\(publisher)-\(url?.absoluteString ?? "local")" }

  var displayContext: String {
    if let notes = notes?.trimmingCharacters(in: .whitespacesAndNewlines),
       !notes.isEmpty {
      return notes
    }

    if let host = url?.host {
      return "Research citation from \(publisher) at \(host), used to ground historical details for this story."
    }

    return "Research note from \(publisher), used to ground historical details for this generated story."
  }

  var locationLabel: String {
    if let host = url?.host {
      return host
    }

    return "Dossier note"
  }

  var retrievalLabel: String? {
    guard let retrievedAt = retrievedAt?.trimmingCharacters(in: .whitespacesAndNewlines),
          !retrievedAt.isEmpty else {
      return nil
    }

    return "Retrieved \(retrievedAt)"
  }
}

enum CreateStoryKind: String, CaseIterable, Identifiable {
  case historicalFigure
  case dailyLife

  var id: String { rawValue }

  var title: String {
    switch self {
    case .historicalFigure:
      return "Historical Figure"
    case .dailyLife:
      return "Daily Life"
    }
  }

  var systemImage: String {
    switch self {
    case .historicalFigure:
      return "sleepy.ancient-bust"
    case .dailyLife:
      return "sleepy.sunrise"
    }
  }
}

struct CreateStoryDraft: Equatable {
  static let approvedVoices = ["Calm narrator"]

  var kind: CreateStoryKind = .dailyLife
  var subject = "A lantern maker in Ottoman Istanbul"
  var era = "Late 16th century"
  var location = "Istanbul"
  var perspective = "A calm ordinary craftsperson"
  var voice = "Calm narrator"
  var durationMinutes = 60

  var estimatedCost: String {
    GenerationEstimate(draft: self).costLabel
  }

  var estimatedTime: String {
    GenerationEstimate(draft: self).timeLabel
  }

  var displayTitle: String {
    subject.sleepyDisplayTitle
  }

  var apiRequest: APIStoryGenerationRequest {
    APIStoryGenerationRequest(
      kind: kind.apiValue,
      subject: subject,
      targetDurationMinutes: durationMinutes,
      era: era.isEmpty ? nil : era,
      location: location.isEmpty ? nil : location,
      perspective: perspective.isEmpty ? nil : perspective,
      voiceId: voice.apiVoiceID
    )
  }
}

private struct CreateStoryPresentation: Identifiable {
  let id = UUID()
  let draft: CreateStoryDraft
}

struct GenerationEstimate: Equatable {
  let researchUSD: Double
  let writingUSD: Double
  let narrationUSD: Double
  let imageUSD: Double
  let storageUSD: Double
  let lowerMinutes: Int
  let upperMinutes: Int

  init(draft: CreateStoryDraft) {
    let scale = max(Double(draft.durationMinutes), 5) / 65.0
    researchUSD = Self.roundUSD(0.48 * scale)
    writingUSD = Self.roundUSD(1.5 * scale)
    narrationUSD = Self.roundUSD(7.8 * scale)
    imageUSD = 0.5
    storageUSD = Self.roundUSD(0.02 + (Double(draft.durationMinutes) / 60.0) * 0.04)

    let filledDetailCount = [
      draft.subject,
      draft.era,
      draft.location,
      draft.perspective
    ].filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.count
    let detailPenalty = max(0, 4 - filledDetailCount) * 3
    lowerMinutes = max(18, Int((26.0 * scale).rounded()) + detailPenalty + 5)
    upperMinutes = max(lowerMinutes + 14, Int((62.0 * scale).rounded()) + detailPenalty + 8)
  }

  var totalUSD: Double {
    Self.roundUSD(researchUSD + writingUSD + narrationUSD + imageUSD)
  }

  var costLabel: String {
    "$\(Self.currency(totalUSD))"
  }

  var timeLabel: String {
    "\(lowerMinutes)-\(upperMinutes) min"
  }

  var detailLines: [String] {
    [
      "Research and writing: $\(Self.currency(researchUSD + writingUSD))",
      "Narration: $\(Self.currency(narrationUSD))",
      "Cover art: $\(Self.currency(imageUSD)); storage allowance about $\(Self.currency(storageUSD))"
    ]
  }

  private static func roundUSD(_ value: Double) -> Double {
    (value * 100).rounded() / 100
  }

  private static func currency(_ value: Double) -> String {
    String(format: "%.2f", value)
  }
}

struct StarterIdea: Identifiable, Equatable {
  let id: String
  let title: String
  let subtitle: String
  let systemImage: String
  let draft: CreateStoryDraft

  static let all: [StarterIdea] = [
    StarterIdea(
      id: "victorian-kitchen",
      title: "Victorian kitchen",
      subtitle: "Daily Life",
      systemImage: "house.and.flag.fill",
      draft: CreateStoryDraft(
        kind: .dailyLife,
        subject: "A talented assistant chef in Victorian England",
        era: "Victorian England",
        location: "England",
        perspective: "A calm narrator describing the assistant chef and house staff",
        voice: "Calm narrator",
        durationMinutes: 60
      )
    ),
    StarterIdea(
      id: "quiet-astronomer",
      title: "A quiet astronomer",
      subtitle: "Historical Figure",
      systemImage: "sparkles",
      draft: CreateStoryDraft(
        kind: .historicalFigure,
        subject: "Hypatia of Alexandria",
        era: "Late 4th century",
        location: "Alexandria",
        perspective: "A gentle biographical narrator",
        voice: "Calm narrator",
        durationMinutes: 60
      )
    ),
    StarterIdea(
      id: "market-before-dawn",
      title: "Market before dawn",
      subtitle: "Daily Life",
      systemImage: "sun.horizon.fill",
      draft: CreateStoryDraft(
        kind: .dailyLife,
        subject: "A market porter setting up before dawn",
        era: "Seventeenth century",
        location: "Amsterdam",
        perspective: "A calm narrator describing ordinary work before sunrise",
        voice: "Calm narrator",
        durationMinutes: 55
      )
    ),
    StarterIdea(
      id: "monastery-apothecary",
      title: "Monastery apothecary",
      subtitle: "Daily Life",
      systemImage: "leaf.fill",
      draft: CreateStoryDraft(
        kind: .dailyLife,
        subject: "An apothecary's assistant in a medieval monastery",
        era: "Twelfth century",
        location: "Northern France",
        perspective: "A calm narrator describing herb rooms, ledgers, and quiet work",
        voice: "Calm narrator",
        durationMinutes: 60
      )
    ),
    StarterIdea(
      id: "silk-road-caravanserai",
      title: "Caravanserai evening",
      subtitle: "Daily Life",
      systemImage: "moon.stars.fill",
      draft: CreateStoryDraft(
        kind: .dailyLife,
        subject: "A caretaker at a Silk Road caravanserai",
        era: "Thirteenth century",
        location: "Central Asia",
        perspective: "A calm narrator describing rooms, ledgers, travelers, and lamps",
        voice: "Calm narrator",
        durationMinutes: 60
      )
    )
  ]
}

private extension String {
  var apiVoiceID: String? {
    switch self {
    case "Calm narrator":
      return "calm_narrator_01"
    default:
      return nil
    }
  }

  var sleepyIdentifierSlug: String {
    let scalars = lowercased().unicodeScalars.map { scalar -> Character in
      CharacterSet.alphanumerics.contains(scalar) ? Character(String(scalar)) : "-"
    }
    let slug = String(scalars).split(separator: "-").joined(separator: "-")
    return slug.isEmpty ? "untitled" : slug
  }

  var sleepyDisplayTitle: String {
    split(separator: " ")
      .enumerated()
      .map { index, word in
        let lower = word.lowercased()
        if index > 0,
           ["a", "an", "and", "at", "for", "in", "of", "on", "the", "to", "with"].contains(lower) {
          return lower
        }
        return lower.prefix(1).uppercased() + String(lower.dropFirst())
      }
      .joined(separator: " ")
      .replacingOccurrences(of: "Ottoman istanbul", with: "Ottoman Istanbul")
      .replacingOccurrences(of: "Victorian england", with: "Victorian England")
  }
}

private extension [String] {
  func value(after flag: String) -> String? {
    guard let index = firstIndex(of: flag) else {
      return nil
    }
    let valueIndex = self.index(after: index)
    return indices.contains(valueIndex) ? self[valueIndex] : nil
  }
}

private extension CreateStoryKind {
  var apiValue: String {
    switch self {
    case .historicalFigure:
      return "historical_figure"
    case .dailyLife:
      return "daily_life"
    }
  }
}

enum AIProviderDisclosure {
  static let acceptedStorageKey = "sleepy-history.ai-provider-disclosure-accepted"
  static let title = "AI and provider disclosure"
  static let summary = "Sleepy History creates original AI-assisted bedtime history stories from historical sources and approved synthetic voices."
  static let providerRouting = "To generate a story, your story details are sent to the Sleepy History backend. The backend may send generation prompts, source-grounded story text, narration text, and cover-art prompts to configured AI providers: Gemini for research, Claude for writing, ElevenLabs for narration, and OpenAI for cover art."
  static let privacyBoundary = "The app sends the subject, era, location, perspective, target length, and selected voice. Do not include private personal information in story prompts. Provider keys stay on the backend and are never stored on your device."

  static var consentBullets: [String] {
    [
      "Stories, narration, and cover art may be AI-generated or AI-assisted.",
      providerRouting,
      privacyBoundary
    ]
  }

  static func shouldPresentConsent(hasAccepted: Bool) -> Bool {
    !hasAccepted
  }
}

enum PlaybackDefaults {
  static let speedKey = "sleepy-history.default-playback-speed"
  static let sleepTimerKey = "sleepy-history.default-sleep-timer"
  static let defaultSpeed = "1x"
  static let defaultSleepTimer = "30 min"
  static let speedOptions = ["0.8x", "1x", "1.2x", "1.5x"]
  static let sleepTimerOptions = ["15 min", "30 min", "45 min", "Off"]

  static func playbackRate(for label: String) -> Double? {
    Double(label.replacingOccurrences(of: "x", with: ""))
  }

  static func sleepTimerSeconds(for label: String) -> TimeInterval? {
    guard label != "Off",
          let minutes = Double(label.replacingOccurrences(of: " min", with: "")) else {
      return nil
    }

    return minutes * 60
  }
}

struct BackendHealthStatus: Decodable, Equatable {
  struct Worker: Decodable, Equatable {
    let ok: Bool
    let status: String
    let processedJobs: Int
  }

  struct ConsoleLink: Decodable, Equatable, Identifiable {
    let label: String
    let url: String

    var id: String { "\(label)-\(url)" }

    var destination: URL? {
      URL(string: url)
    }
  }

  struct Provider: Decodable, Equatable, Identifiable {
    let id: String
    let step: String
    let provider: String
    let model: String?
    let state: String
    let detail: String
    let consoleLinks: [ConsoleLink]

    enum CodingKeys: String, CodingKey {
      case id
      case step
      case provider
      case model
      case state
      case detail
      case consoleLinks
    }

    init(
      id: String,
      step: String,
      provider: String,
      model: String? = nil,
      state: String,
      detail: String,
      consoleLinks: [ConsoleLink] = []
    ) {
      self.id = id
      self.step = step
      self.provider = provider
      self.model = model
      self.state = state
      self.detail = detail
      self.consoleLinks = consoleLinks
    }

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      id = try container.decode(String.self, forKey: .id)
      step = try container.decode(String.self, forKey: .step)
      provider = try container.decode(String.self, forKey: .provider)
      model = try container.decodeIfPresent(String.self, forKey: .model)
      state = try container.decode(String.self, forKey: .state)
      detail = try container.decode(String.self, forKey: .detail)
      consoleLinks = try container.decodeIfPresent([ConsoleLink].self, forKey: .consoleLinks) ?? Provider.defaultConsoleLinks(for: id)
    }

    var label: String {
      switch state {
      case "online":
        return "Online"
      case "offline":
        return "Offline"
      case "credits_depleted":
        return "Credits depleted"
      default:
        return "Needs attention"
      }
    }

    var systemImage: String {
      switch state {
      case "online":
        return "checkmark.circle.fill"
      case "offline":
        return "xmark.circle.fill"
      case "credits_depleted":
        return "exclamationmark.circle.fill"
      default:
        return "exclamationmark.triangle.fill"
      }
    }

    var tint: Color {
      switch state {
      case "online":
        return Color(red: 0.42, green: 0.78, blue: 0.56)
      case "offline":
        return Color(red: 0.92, green: 0.34, blue: 0.28)
      case "credits_depleted":
        return SleepyTheme.ColorToken.gold
      default:
        return SleepyTheme.ColorToken.amber
      }
    }

    var providerLine: String {
      if let model, !model.isEmpty {
        return "\(provider) · \(model)"
      }
      return provider
    }

    static func defaultConsoleLinks(for id: String) -> [ConsoleLink] {
      switch id {
      case "railway-backend":
        return [
          ConsoleLink(label: "Dashboard", url: "https://railway.com/dashboard"),
          ConsoleLink(label: "Billing", url: "https://railway.com/account/billing")
        ]
      case "cloudflare-r2-storage":
        return [
          ConsoleLink(label: "R2", url: "https://dash.cloudflare.com/?to=/:account/r2"),
          ConsoleLink(label: "API Tokens", url: "https://dash.cloudflare.com/profile/api-tokens"),
          ConsoleLink(label: "Billing", url: "https://dash.cloudflare.com/?to=/:account/billing")
        ]
      case "gemini-research":
        return [
          ConsoleLink(label: "API Keys", url: "https://aistudio.google.com/app/apikey"),
          ConsoleLink(label: "Billing", url: "https://console.cloud.google.com/billing"),
          ConsoleLink(label: "AI Studio", url: "https://aistudio.google.com/")
        ]
      case "opus-writing":
        return [
          ConsoleLink(label: "API Keys", url: "https://console.anthropic.com/settings/keys"),
          ConsoleLink(label: "Billing", url: "https://console.anthropic.com/settings/billing"),
          ConsoleLink(label: "Usage", url: "https://console.anthropic.com/usage")
        ]
      case "elevenlabs-narration":
        return [
          ConsoleLink(label: "API Keys", url: "https://elevenlabs.io/app/settings/api-keys"),
          ConsoleLink(label: "Credits", url: "https://elevenlabs.io/app/subscription"),
          ConsoleLink(label: "Usage", url: "https://elevenlabs.io/app/usage")
        ]
      case "openai-cover-art":
        return [
          ConsoleLink(label: "API Keys", url: "https://platform.openai.com/api-keys"),
          ConsoleLink(label: "Billing", url: "https://platform.openai.com/settings/organization/billing/overview"),
          ConsoleLink(label: "Usage", url: "https://platform.openai.com/usage")
        ]
      default:
        return []
      }
    }
  }

  let ok: Bool
  let service: String
  let mode: String
  let providerKillSwitch: Bool
  let providers: [Provider]?
  let worker: Worker?

  static let uiTestMock = BackendHealthStatus(
    ok: true,
    service: "sleepy-history-server",
    mode: "ui-test",
    providerKillSwitch: false,
    providers: [
      Provider(
        id: "railway-backend",
        step: "Backend hosting",
        provider: "Railway",
        state: "online",
        detail: "Backend is reachable and ready to coordinate generation jobs.",
        consoleLinks: Provider.defaultConsoleLinks(for: "railway-backend")
      ),
      Provider(
        id: "cloudflare-r2-storage",
        step: "Object storage",
        provider: "Cloudflare R2",
        state: "online",
        detail: "R2 storage is configured for generated audio, artwork, transcripts, and sources.",
        consoleLinks: Provider.defaultConsoleLinks(for: "cloudflare-r2-storage")
      ),
      Provider(
        id: "gemini-research",
        step: "Research dossier",
        provider: "Google Gemini",
        model: "gemini-3.1-pro-preview",
        state: "online",
        detail: "Ready to build grounded historical dossiers.",
        consoleLinks: Provider.defaultConsoleLinks(for: "gemini-research")
      ),
      Provider(
        id: "opus-writing",
        step: "Story writing",
        provider: "Anthropic Claude",
        model: "claude-opus-4-6",
        state: "online",
        detail: "Ready to write and review the chaptered script.",
        consoleLinks: Provider.defaultConsoleLinks(for: "opus-writing")
      ),
      Provider(
        id: "elevenlabs-narration",
        step: "Narration",
        provider: "ElevenLabs",
        model: "eleven_multilingual_v2 · pcm_24000",
        state: "credits_depleted",
        detail: "Credits are depleted or the latest narration attempt exceeded available credits.",
        consoleLinks: Provider.defaultConsoleLinks(for: "elevenlabs-narration")
      ),
      Provider(
        id: "openai-cover-art",
        step: "Cover art",
        provider: "OpenAI Images",
        model: "gpt-image-2",
        state: "warning",
        detail: "Cover art reported a recent provider issue.",
        consoleLinks: Provider.defaultConsoleLinks(for: "openai-cover-art")
      )
    ],
    worker: Worker(ok: true, status: "idle", processedJobs: 2)
  )

  var backendSummary: String {
    ok ? "Backend online" : "Backend needs attention"
  }

  var providerSummary: String {
    providerKillSwitch ? "Providers paused by kill switch" : "Provider steps visible below"
  }

  var providerRows: [Provider] {
    if let providers, !providers.isEmpty {
      return providers
    }

    return [
      Provider(
        id: "railway-backend",
        step: "Backend hosting",
        provider: "Railway",
        state: ok ? "online" : "offline",
        detail: ok ? "Backend responded, but detailed hosting status is unavailable." : "Backend did not report a healthy response.",
        consoleLinks: Provider.defaultConsoleLinks(for: "railway-backend")
      ),
      Provider(
        id: "cloudflare-r2-storage",
        step: "Object storage",
        provider: "Cloudflare R2",
        state: ok ? "warning" : "offline",
        detail: ok ? "Storage status is not included in this backend response." : "Backend did not report storage status.",
        consoleLinks: Provider.defaultConsoleLinks(for: "cloudflare-r2-storage")
      ),
      Provider(
        id: "gemini-research",
        step: "Research dossier",
        provider: "Google Gemini",
        model: "gemini-3.1-pro-preview",
        state: providerKillSwitch ? "offline" : "warning",
        detail: providerSummary,
        consoleLinks: Provider.defaultConsoleLinks(for: "gemini-research")
      ),
      Provider(
        id: "opus-writing",
        step: "Story writing",
        provider: "Anthropic Claude",
        model: "claude-opus-4-6",
        state: providerKillSwitch ? "offline" : "warning",
        detail: providerSummary,
        consoleLinks: Provider.defaultConsoleLinks(for: "opus-writing")
      ),
      Provider(
        id: "elevenlabs-narration",
        step: "Narration",
        provider: "ElevenLabs",
        model: "eleven_multilingual_v2 · pcm_24000",
        state: providerKillSwitch ? "offline" : "warning",
        detail: providerSummary,
        consoleLinks: Provider.defaultConsoleLinks(for: "elevenlabs-narration")
      ),
      Provider(
        id: "openai-cover-art",
        step: "Cover art",
        provider: "OpenAI Images",
        model: "gpt-image-2",
        state: providerKillSwitch ? "offline" : "warning",
        detail: providerSummary,
        consoleLinks: Provider.defaultConsoleLinks(for: "openai-cover-art")
      )
    ]
  }

  var workerSummary: String {
    guard let worker else {
      return "Worker status unavailable"
    }

    return worker.ok ? "Worker \(worker.status)" : "Worker needs attention"
  }
}

struct BackendHealthClient {
  let apiBaseURL: URL

  func fetch() async throws -> BackendHealthStatus {
    let (data, response) = try await URLSession.shared.data(from: apiBaseURL.appendingPathComponent("health"))
    if let httpResponse = response as? HTTPURLResponse,
       !(200..<300).contains(httpResponse.statusCode) {
      throw URLError(.badServerResponse)
    }

    return try JSONDecoder().decode(BackendHealthStatus.self, from: data)
  }
}

struct FixtureGeneratedJob: Identifiable, Equatable {
  let id: String
  let title: String
  let detail: String
  let storyID: String?
  var progress: Double
  var stage: String
  var message: String
  var state: FixtureGeneratedJobState
  var failureReason: String?

  var isLocalOnly: Bool {
    id.hasPrefix("mock-") || id.hasPrefix("completed-mock-")
  }

  init(draft: CreateStoryDraft) {
    id = "mock-\(draft.kind.rawValue)-\(draft.subject.lowercased().replacingOccurrences(of: " ", with: "-"))"
    title = draft.displayTitle
    detail = "\(draft.kind.title), \(draft.durationMinutes) minutes, \(draft.voice)"
    storyID = nil
    progress = 0.18
    stage = "Researching"
    message = "Building a quiet fact dossier"
    state = .running
    failureReason = nil
  }

  static let partial = FixtureGeneratedJob(
    id: "mock-partial-marie-curie",
    title: "Marie Curie's Late Laboratory",
    detail: "Historical Figure, 60 minutes, Calm narrator",
    progress: 0.62,
    stage: "Voicing",
    message: "Narrating chapter 5 of 10",
    state: .partial,
    failureReason: nil
  )

  static let failed = FixtureGeneratedJob(
    id: "mock-failed-inca-road",
    title: "Messengers on the Inca Road",
    detail: "Daily Life, 55 minutes, Calm narrator",
    progress: 0.84,
    stage: "Cover Art",
    message: "Fallback artwork is ready",
    state: .failed,
    failureReason: "Cover art retry needed"
  )

  static let mockServer = FixtureGeneratedJob(apiJob: APIGenerationJob.mockServerFixture)

  init(completedStory story: FixtureStory, draft: CreateStoryDraft) {
    id = "completed-\(story.id)"
    title = story.title
    detail = "\(draft.kind.title), \(draft.durationMinutes) minutes, \(draft.voice)"
    storyID = story.id
    progress = 1
    stage = "Ready"
    message = "Story and audio are ready"
    state = .completed
    failureReason = nil
  }

  init(completedStory story: FixtureStory, draft: CreateStoryDraft?) {
    id = "completed-\(story.id)"
    title = story.title
    detail = draft.map { "\($0.kind.title), \($0.durationMinutes) minutes, \($0.voice)" }
      ?? "\(story.category), \(story.durationMinutes) minutes, Calm narrator"
    storyID = story.id
    progress = 1
    stage = "Ready"
    message = "Story and audio are ready"
    state = .completed
    failureReason = nil
  }

  init(completedStory story: FixtureStory, draft: CreateStoryDraft?, jobID: String) {
    id = jobID
    title = story.title
    detail = draft.map { "\($0.kind.title), \($0.durationMinutes) minutes, \($0.voice)" }
      ?? "\(story.category), \(story.durationMinutes) minutes, Calm narrator"
    storyID = story.id
    progress = 1
    stage = "Ready"
    message = "Story and audio are ready"
    state = .completed
    failureReason = nil
  }

  static func resuming(jobID: String) -> FixtureGeneratedJob {
    FixtureGeneratedJob(
      id: jobID,
      title: "Resuming story generation",
      detail: "Hosted generation",
      progress: 0.05,
      stage: "Checking Status",
      message: "Reconnecting to the backend",
      state: .running,
      failureReason: nil
    )
  }

  init(createdJob job: APICreatedJob, draft: CreateStoryDraft) {
    id = job.id
    title = draft.displayTitle
    detail = "\(draft.kind.title), \(draft.durationMinutes) minutes, \(draft.voice)"
    storyID = nil
    progress = min(max(Double(job.progress.percent) / 100, 0), 1)
    stage = job.progress.stage.replacingOccurrences(of: "_", with: " ").capitalized
    message = job.progress.message ?? "Queued on the backend"
    state = FixtureGeneratedJobState(apiStatus: job.status, progress: progress, apiError: nil)
    failureReason = nil
  }

  init(apiJob: APIGenerationJob) {
    id = apiJob.id
    title = apiJob.request.subject.sleepyDisplayTitle
    detail = "\(Self.title(for: apiJob.request.kind)), \(apiJob.request.targetDurationMinutes) minutes, \(apiJob.request.voiceId ?? "Calm narrator")"
    storyID = apiJob.storyId
    progress = min(max(Double(apiJob.progress.percent) / 100, 0), 1)
    stage = apiJob.progress.stage.replacingOccurrences(of: "_", with: " ").capitalized
    message = apiJob.progress.message ?? "Waiting for the backend"
    state = FixtureGeneratedJobState(apiStatus: apiJob.status, progress: progress, apiError: apiJob.error)
    failureReason = apiJob.error?.userFacingGenerationMessage
  }

  private init(
    id: String,
    title: String,
    detail: String,
    storyID: String? = nil,
    progress: Double,
    stage: String,
    message: String,
    state: FixtureGeneratedJobState,
    failureReason: String?
  ) {
    self.id = id
    self.title = title
    self.detail = detail
    self.storyID = storyID
    self.progress = progress
    self.stage = stage
    self.message = message
    self.state = state
    self.failureReason = failureReason
  }

  private static func title(for kind: String) -> String {
    switch kind {
    case "historical_figure":
      return "Historical Figure"
    case "daily_life":
      return "Daily Life"
    default:
      return kind.replacingOccurrences(of: "_", with: " ").capitalized
    }
  }

  func failedForDisplay(message: String, state: FixtureGeneratedJobState = .failed) -> FixtureGeneratedJob {
    var failedJob = self
    failedJob.state = state
    failedJob.failureReason = message
    failedJob.message = message
    failedJob.stage = state == .budgetLimit ? "Budget Limit" : "Needs Attention"
    return failedJob
  }

  func interruptedForDisplay(message: String) -> FixtureGeneratedJob {
    var interruptedJob = self
    interruptedJob.failureReason = message
    interruptedJob.message = message
    if interruptedJob.state == .running || interruptedJob.state == .partial {
      interruptedJob.stage = "Reconnecting"
      interruptedJob.state = .running
    }
    return interruptedJob
  }
}

struct FixtureJobShowcase: Equatable {
  var partial = FixtureGeneratedJob.partial
  var failed = FixtureGeneratedJob.failed
  var mockServer = FixtureGeneratedJob.mockServer

  var jobs: [FixtureGeneratedJob] {
    []
  }

  mutating func update(_ job: FixtureGeneratedJob) {
    if job.id == mockServer.id {
      mockServer = job
    }
    if job.id == partial.id {
      partial = job
    }
    if job.id == failed.id {
      failed = job
    }
  }
}

extension APIGenerationJob {
  static let mockServerFixture = APIGenerationJob(
    id: "job_mock_server_research",
    status: "researching",
    request: APIStoryGenerationRequest(
      kind: "daily_life",
      subject: "A Baker's Quiet Morning in Pompeii",
      targetDurationMinutes: 60,
      era: "first century",
      location: "Pompeii",
      perspective: "ordinary baker",
      voiceId: "Calm narrator"
    ),
    progress: APIJobProgress(
      stage: "researching",
      percent: 28,
      message: "Mock server is gathering grounded daily-life details"
    ),
    createdAt: "2026-05-10T16:20:00Z",
    updatedAt: "2026-05-10T16:22:00Z",
    storyId: nil,
    error: nil
  )
}

enum GenerationRetryDisposition: Equatable {
  case retryEndpoint
  case resumePolling
  case importCompletedStory(String)
}

struct GenerationRetryPolicy {
  static func disposition(for job: APIGenerationJob) -> GenerationRetryDisposition {
    if job.status == "completed", let storyID = job.storyId {
      return .importCompletedStory(storyID)
    }

    let state = FixtureGeneratedJobState(
      apiStatus: job.status,
      progress: Double(job.progress.percent) / 100,
      apiError: job.error
    )
    if state == .failed || state == .budgetLimit || state == .canceled {
      return .retryEndpoint
    }
    return .resumePolling
  }
}

enum FixtureGeneratedJobState: Equatable {
  case running
  case partial
  case failed
  case budgetLimit
  case canceled
  case completed

  var label: String {
    switch self {
    case .running:
      return "Generating"
    case .partial:
      return "Partial"
    case .failed:
      return "Needs Retry"
    case .budgetLimit:
      return "Budget Limit"
    case .canceled:
      return "Canceled"
    case .completed:
      return "Ready"
    }
  }

  var systemImage: String {
    switch self {
    case .running:
      return "sparkles"
    case .partial:
      return "clock.badge.checkmark"
    case .failed:
      return "exclamationmark.triangle.fill"
    case .budgetLimit:
      return "exclamationmark.triangle.fill"
    case .canceled:
      return "xmark.circle.fill"
    case .completed:
      return "checkmark.seal.fill"
    }
  }

  init(apiStatus: String, progress: Double, apiError: APIError?) {
    let normalizedStatus = apiStatus.lowercased()
    if apiError?.isBudgetLimit == true {
      self = .budgetLimit
    } else if apiError != nil || normalizedStatus == "failed" {
      self = .failed
    } else if normalizedStatus == "canceled" {
      self = .canceled
    } else if normalizedStatus == "completed" || progress >= 1 {
      self = .completed
    } else {
      self = .running
    }
  }
}

private struct AppTabScreen: View {
  @State private var selectedDetailStory: FixtureStory?

  let tab: AppTab
  let bookmarkedStoryIDs: Set<String>
  let storyCatalog: [FixtureStory]
  let continueListeningStory: FixtureStory
  let upNextStories: [FixtureStory]
  let submittedJob: FixtureGeneratedJob?
  let openCreateStory: (CreateStoryDraft?) -> Void
  let playStory: (FixtureStory) -> Void
  let toggleBookmark: (FixtureStory) -> Void
  let clearBookmarks: () -> Void
  let clearGeneratedDownloads: () -> Void
  @Binding var hasAcceptedAIProviderDisclosure: Bool
  let submitCreateStory: (CreateStoryDraft) -> Void
  let cancelJob: (FixtureGeneratedJob) -> Void
  let retryJob: (FixtureGeneratedJob) -> Void
  let deleteJob: (FixtureGeneratedJob) -> Void

  var body: some View {
    ZStack {
      SleepyTheme.eveningGradient
        .ignoresSafeArea()

      ScrollView {
        VStack(alignment: .leading, spacing: 28) {
          header
          content
        }
        .padding(.horizontal, SleepyTheme.Spacing.lg)
        .padding(.top, SleepyTheme.Spacing.lg)
        .padding(.bottom, 132)
        .frame(maxWidth: 560, alignment: .leading)
      }
      .scrollIndicators(.hidden)
    }
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .navigationDestination(
      isPresented: Binding(
        get: { selectedDetailStory != nil },
        set: { isPresented in
          if !isPresented {
            selectedDetailStory = nil
          }
        }
      )
    ) {
      if let selectedDetailStory {
        StoryDetailView(story: selectedDetailStory)
      }
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xs) {
      Text(headerTitle)
        .font(.system(size: 42, weight: .bold, design: .default))
        .foregroundStyle(SleepyTheme.ColorToken.parchment)
        .lineLimit(2)
        .minimumScaleFactor(0.78)

      if !headerSubtitle.isEmpty {
        Text(headerSubtitle)
          .font(SleepyTheme.Typography.callout)
          .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }

  private var headerSubtitle: String {
    switch tab {
    case .home:
      return "Good evening. Settle in with a quiet story from the past."
    case .create:
      return "Shape a long-form story for sleep."
    case .library:
      return "Your generated stories, downloads, and progress."
    case .bookmarks:
      return "Stories saved for another night."
    case .settings:
      return "Enrollment, playback defaults, and app controls."
    }
  }

  @ViewBuilder
  private var content: some View {
    switch tab {
    case .home:
      HomeTabContent(
        continueListeningStory: continueListeningStory,
        upNextStories: upNextStories,
        stories: storyCatalog,
        openCreateStory: openCreateStory,
        playStory: playStory
      )
    case .create:
      CreateTabContent(openCreateStory: openCreateStory)
    case .library:
      LibraryTabContent(
        storyCatalog: storyCatalog,
        submittedJob: submittedJob,
        bookmarkedStoryIDs: bookmarkedStoryIDs,
        playStory: playStory,
        openDetail: { selectedDetailStory = $0 },
        toggleBookmark: toggleBookmark,
        cancelJob: cancelJob,
        retryJob: retryJob,
        deleteJob: deleteJob
      )
    case .bookmarks:
      BookmarksTabContent(
        bookmarkedStoryIDs: bookmarkedStoryIDs,
        stories: storyCatalog,
        playStory: playStory,
        openDetail: { selectedDetailStory = $0 },
        toggleBookmark: toggleBookmark
      )
    case .settings:
      ProfileTabContent(
        bookmarkedStoryIDs: bookmarkedStoryIDs,
        stories: storyCatalog,
        hasAcceptedAIProviderDisclosure: $hasAcceptedAIProviderDisclosure,
        clearBookmarks: clearBookmarks,
        clearGeneratedDownloads: clearGeneratedDownloads,
        playStory: playStory,
        openDetail: { selectedDetailStory = $0 },
        toggleBookmark: toggleBookmark
      )
    }
  }

  private var headerTitle: String {
    switch tab {
    case .home:
      return "Home"
    case .create:
      return "Create"
    case .library:
      return "Library"
    case .bookmarks:
      return "Bookmarks"
    case .settings:
      return "Settings"
    }
  }
}

private struct ScreenSectionHeader: View {
  let title: String
  let subtitle: String?
  let trailingTitle: String?
  let action: (() -> Void)?

  init(
    _ title: String,
    subtitle: String? = nil,
    trailingTitle: String? = nil,
    action: (() -> Void)? = nil
  ) {
    self.title = title
    self.subtitle = subtitle
    self.trailingTitle = trailingTitle
    self.action = action
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
        Text(title)
          .font(SleepyTheme.Typography.title)
          .foregroundStyle(SleepyTheme.ColorToken.parchment)

        if let subtitle {
          Text(subtitle)
            .font(SleepyTheme.Typography.caption)
            .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
        }
      }

      Spacer(minLength: SleepyTheme.Spacing.sm)

      if let trailingTitle, let action {
        Button(trailingTitle, action: action)
          .font(SleepyTheme.Typography.callout.weight(.semibold))
          .foregroundStyle(SleepyTheme.ColorToken.gold)
          .buttonStyle(.plain)
      }
    }
  }
}

private struct ListSurface<Content: View>: View {
  @ViewBuilder let content: Content

  var body: some View {
    VStack(spacing: 0) {
      content
    }
    .background {
      RoundedRectangle(cornerRadius: SleepyTheme.Radius.lg, style: .continuous)
        .fill(SleepyTheme.ColorToken.card.opacity(0.88))
        .overlay {
          RoundedRectangle(cornerRadius: SleepyTheme.Radius.lg, style: .continuous)
            .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 0.75)
        }
    }
    .accessibilityElement(children: .contain)
  }
}

private struct RowSeparator: View {
  var body: some View {
    Rectangle()
      .fill(SleepyTheme.ColorToken.separator)
      .frame(height: 0.5)
  }
}

private struct InlineMetricRow: View {
  let items: [(String, String)]

  var body: some View {
    HStack(spacing: SleepyTheme.Spacing.xs) {
      ForEach(items, id: \.1) { item in
        VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
          Text(item.0)
            .font(.system(.title3, design: .default, weight: .bold))
            .foregroundStyle(SleepyTheme.ColorToken.parchment)
            .lineLimit(1)
            .minimumScaleFactor(0.78)

          Text(item.1)
            .font(SleepyTheme.Typography.label)
            .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(SleepyTheme.Spacing.sm)
        .background {
          RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
            .fill(SleepyTheme.ColorToken.cardRaised.opacity(0.55))
        }
      }
    }
  }
}

private struct HomeTabContent: View {
  let continueListeningStory: FixtureStory
  let upNextStories: [FixtureStory]
  let stories: [FixtureStory]
  let openCreateStory: (CreateStoryDraft?) -> Void
  let playStory: (FixtureStory) -> Void

  private var shelfStories: [FixtureStory] {
    stories.isEmpty ? [continueListeningStory] : stories
  }

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xl) {
      UpNextSection(stories: upNextStories.isEmpty ? [continueListeningStory] : upNextStories, playStory: playStory)
      CreateStoryEntryCard(action: { openCreateStory(nil) })

      StoryStrip(
        title: "Recently Updated",
        stories: shelfStories,
        playStory: playStory
      )

      StarterIdeasSection(openCreateStory: openCreateStory)
    }
    .accessibilityIdentifier("home-screen")
  }
}

private struct CreateTabContent: View {
  let openCreateStory: (CreateStoryDraft?) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xl) {
      Button {
        openCreateStory(nil)
      } label: {
        VStack(alignment: .leading, spacing: SleepyTheme.Spacing.lg) {
          HStack(alignment: .top) {
            CreateHeroArtwork(size: 96)

            Spacer()

            Text("Start")
              .font(SleepyTheme.Typography.callout.weight(.semibold))
              .foregroundStyle(SleepyTheme.ColorToken.gold)
              .padding(.horizontal, SleepyTheme.Spacing.sm)
              .frame(height: 38)
              .background {
                Capsule().fill(SleepyTheme.ColorToken.cardRaised.opacity(0.72))
              }
          }

          VStack(alignment: .leading, spacing: SleepyTheme.Spacing.sm) {
            Text("Generate an hour-long bedtime story")
              .font(SleepyTheme.Typography.title)
              .foregroundStyle(SleepyTheme.ColorToken.parchment)
              .lineLimit(3)
              .minimumScaleFactor(0.82)

            Text("Research, script writing, narration, cover art, transcripts, and sources are prepared as one story package.")
              .font(SleepyTheme.Typography.callout)
              .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      .buttonStyle(SleepyCardButtonStyle())
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Start a new bedtime story")
      .accessibilityIdentifier("create-tab-primary-entry")

      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
        ScreenSectionHeader("What you can make")

        ListSurface {
          CompactCapabilityRow(systemName: "building.columns.fill", title: "Historical figures", detail: "Slow biographies with sourced context")
          RowSeparator()
          CompactCapabilityRow(systemName: "door.left.hand.open", title: "Daily life", detail: "Ordinary work, rituals, rooms, and household rhythms")
        }
      }

      StarterIdeasSection(openCreateStory: openCreateStory)
    }
    .accessibilityIdentifier("create-screen")
  }
}

private struct CreateHeroArtwork: View {
  let size: CGFloat

  var body: some View {
    ZStack(alignment: .topLeading) {
      RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
        .fill(SleepyTheme.artworkGradient)

      Text("New")
        .font(SleepyTheme.Typography.label)
        .foregroundStyle(SleepyTheme.ColorToken.ink)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background {
          Capsule().fill(SleepyTheme.ColorToken.gold)
        }
        .padding(10)

      Image(systemName: "book.closed.fill")
        .symbolRenderingMode(SleepyTheme.Icon.symbolRenderingMode)
        .font(.system(size: size * 0.28, weight: .semibold))
        .foregroundStyle(SleepyTheme.ColorToken.parchment)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
        .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 1)
    }
    .accessibilityHidden(true)
  }
}

private struct StarterIdeasSection: View {
  let openCreateStory: (CreateStoryDraft?) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
      ScreenSectionHeader("Starter Ideas", subtitle: "Open the generator and customize from there")

      ScrollView(.horizontal) {
        HStack(spacing: SleepyTheme.Spacing.sm) {
          ForEach(StarterIdea.all) { idea in
            Button {
              openCreateStory(idea.draft)
            } label: {
              VStack(alignment: .leading, spacing: SleepyTheme.Spacing.sm) {
                Image(systemName: idea.systemImage)
                  .font(.title3.weight(.semibold))
                  .foregroundStyle(SleepyTheme.ColorToken.gold)

                VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
                  Text(idea.title)
                    .font(SleepyTheme.Typography.callout.weight(.semibold))
                    .foregroundStyle(SleepyTheme.ColorToken.parchment)
                    .lineLimit(2)
                    .minimumScaleFactor(0.82)

                  Text(idea.subtitle)
                    .font(SleepyTheme.Typography.label)
                    .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
                    .lineLimit(1)
                }
              }
              .padding(SleepyTheme.Spacing.md)
              .frame(width: 148, height: 126, alignment: .leading)
              .background {
                RoundedRectangle(cornerRadius: SleepyTheme.Radius.lg, style: .continuous)
                  .fill(SleepyTheme.ColorToken.card.opacity(0.86))
                  .overlay {
                    RoundedRectangle(cornerRadius: SleepyTheme.Radius.lg, style: .continuous)
                      .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 0.75)
                  }
              }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Create story from \(idea.title)")
            .accessibilityIdentifier("starter-idea-\(idea.id)")
          }
        }
      }
      .scrollIndicators(.hidden)
    }
    .accessibilityIdentifier("starter-ideas-section")
  }
}

private struct LibraryTabContent: View {
  @State private var selectedFilter: LibraryStoryFilter = .all
  @State private var searchText = ""

  let storyCatalog: [FixtureStory]
  let submittedJob: FixtureGeneratedJob?
  let bookmarkedStoryIDs: Set<String>
  let playStory: (FixtureStory) -> Void
  let openDetail: (FixtureStory) -> Void
  let toggleBookmark: (FixtureStory) -> Void
  let cancelJob: (FixtureGeneratedJob) -> Void
  let retryJob: (FixtureGeneratedJob) -> Void
  let deleteJob: (FixtureGeneratedJob) -> Void

  private var filteredStories: [FixtureStory] {
    FixtureStory.library(in: storyCatalog, matching: selectedFilter, searchText: searchText)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.lg) {
      LibrarySearchField(searchText: $searchText)

      if let submittedJob {
        GenerationProgressSection(
          jobs: [submittedJob],
          cancelJob: cancelJob,
          retryJob: retryJob,
          deleteJob: deleteJob
        )
      }

      InlineMetricRow(items: [
        ("\(storyCatalog.count)", "Stories"),
        ("\(storyCatalog.filter(\.isDownloaded).count)", "Downloaded"),
        ("\(bookmarkedStoryIDs.count)", "Bookmarks")
      ])

      ScrollView(.horizontal) {
        HStack(spacing: SleepyTheme.Spacing.sm) {
          ForEach(LibraryStoryFilter.allCases) { filter in
            FilterButton(
              filter: filter,
              isSelected: selectedFilter == filter,
              count: FixtureStory.library(in: storyCatalog, matching: filter, searchText: searchText).count
            ) {
              selectedFilter = filter
            }
          }
        }
        .padding(.vertical, 2)
      }
      .scrollIndicators(.hidden)
      .accessibilityIdentifier("library-filter-strip")

      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
        ScreenSectionHeader("Stories", subtitle: selectedFilter.title)

        if filteredStories.isEmpty {
          EmptyDetailState(
            title: "No matching stories",
            message: "Generated stories and completed imports will appear here."
          )
        } else {
          ListSurface {
            ForEach(Array(filteredStories.enumerated()), id: \.element.id) { index, story in
              StoryRow(
                story: story,
                isBookmarked: bookmarkedStoryIDs.contains(story.id),
                playStory: playStory,
                toggleBookmark: toggleBookmark,
                openDetail: openDetail
              )

              if index != filteredStories.count - 1 {
                RowSeparator()
              }
            }
          }
          .accessibilityIdentifier("library-story-list")
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("library-screen")
  }
}

private struct BookmarksTabContent: View {
  let bookmarkedStoryIDs: Set<String>
  let stories: [FixtureStory]
  let playStory: (FixtureStory) -> Void
  let openDetail: (FixtureStory) -> Void
  let toggleBookmark: (FixtureStory) -> Void

  private var bookmarks: [FixtureStory] {
    FixtureStory.bookmarks(in: bookmarkedStoryIDs, from: stories)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.lg) {
      if bookmarks.isEmpty {
        EmptyBookmarkState()
      } else {
        ScreenSectionHeader("\(bookmarks.count) Bookmarked", subtitle: "Saved for another night")

        ListSurface {
          ForEach(Array(bookmarks.enumerated()), id: \.element.id) { index, story in
            SwipeRemovableBookmarkRow(
              story: story,
              playStory: playStory,
              openDetail: openDetail,
              removeBookmark: toggleBookmark
            )

            if index != bookmarks.count - 1 {
              RowSeparator()
            }
          }
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("bookmarks-screen")
  }
}

private struct ProfileTabContent: View {
  @Environment(\.modelContext) private var modelContext
  @Query(sort: \PersistentStoryState.updatedAt, order: .reverse) private var playbackStates: [PersistentStoryState]
  @State private var selectedDestination: ProfileDestination?

  let bookmarkedStoryIDs: Set<String>
  let stories: [FixtureStory]
  @Binding var hasAcceptedAIProviderDisclosure: Bool
  let clearBookmarks: () -> Void
  let clearGeneratedDownloads: () -> Void
  let playStory: (FixtureStory) -> Void
  let openDetail: (FixtureStory) -> Void
  let toggleBookmark: (FixtureStory) -> Void

  private var downloadedCount: Int {
    stories.filter(\.isDownloaded).count
  }

  private var completedCount: Int {
    stories.filter { $0.progress >= 0.99 }.count
  }

  private var inProgressCount: Int {
    stories.filter { $0.progress > 0 && $0.progress < 0.99 }.count
  }

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xl) {
      InlineMetricRow(items: [
        ("\(stories.count)", "Stories"),
        ("\(inProgressCount)", "Active"),
        ("\(bookmarkedStoryIDs.count)", "Bookmarks")
      ])

      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
        ScreenSectionHeader("Controls", subtitle: "Manage downloads, enrollment, privacy, and defaults")

        ListSurface {
          ForEach(Array(ProfileDestination.allCases.enumerated()), id: \.element.id) { index, destination in
            ProfileLinkRow(
              destination: destination,
              detail: detail(for: destination)
            ) {
              selectedDestination = destination
            }

            if index != ProfileDestination.allCases.count - 1 {
              RowSeparator()
            }
          }
        }
      }
    }
    .navigationDestination(item: $selectedDestination) { destination in
      ProfileDestinationScreen(
        destination: destination,
        stories: stories,
        bookmarkedStoryIDs: bookmarkedStoryIDs,
        playbackStates: playbackStates,
        hasAcceptedAIProviderDisclosure: $hasAcceptedAIProviderDisclosure,
        clearBookmarks: clearBookmarks,
        clearGeneratedDownloads: clearGeneratedDownloads,
        playStory: playStory,
        openDetail: openDetail,
        toggleBookmark: toggleBookmark
      )
    }
  }

  private func detail(for destination: ProfileDestination) -> String {
    switch destination {
    case .downloads:
      return "\(downloadedCount) saved"
    case .listeningHistory:
      return "\(inProgressCount) active"
    case .bookmarks:
      return "\(bookmarkedStoryIDs.count) saved"
    case .providerStatus:
      return "Backend and AI providers"
    case .privacy:
      return "Keys stay on backend"
    case .settings:
      return "Backend, providers, reset"
    }
  }
}

enum ProfileDestination: String, CaseIterable, Identifiable, Hashable {
  case downloads
  case listeningHistory
  case bookmarks
  case providerStatus
  case privacy
  case settings

  static var allCases: [ProfileDestination] {
    [.downloads, .listeningHistory, .providerStatus, .privacy, .settings]
  }

  var id: String { rawValue }

  var title: String {
    switch self {
    case .downloads:
      return "Downloads"
    case .listeningHistory:
      return "Listening History"
    case .bookmarks:
      return "Bookmarks"
    case .providerStatus:
      return "Provider Status"
    case .privacy:
      return "Privacy"
    case .settings:
      return "Enrollment"
    }
  }

  var systemName: String {
    switch self {
    case .downloads:
      return "arrow.down.circle.fill"
    case .listeningHistory:
      return "clock.arrow.circlepath"
    case .bookmarks:
      return "bookmark.fill"
    case .providerStatus:
      return "server.rack"
    case .privacy:
      return "lock.shield.fill"
    case .settings:
      return "key.fill"
    }
  }

  var accessibilityIdentifier: String {
    "profile-row-\(rawValue)"
  }
}

private struct ProfileDestinationScreen: View {
  let destination: ProfileDestination
  let stories: [FixtureStory]
  let bookmarkedStoryIDs: Set<String>
  let playbackStates: [PersistentStoryState]
  @Binding var hasAcceptedAIProviderDisclosure: Bool
  let clearBookmarks: () -> Void
  let clearGeneratedDownloads: () -> Void
  let playStory: (FixtureStory) -> Void
  let openDetail: (FixtureStory) -> Void
  let toggleBookmark: (FixtureStory) -> Void

  var body: some View {
    SleepyDetailScaffold(title: destination.title, systemName: destination.systemName) {
      switch destination {
      case .downloads:
        DownloadsDetailScreen(stories: stories)
      case .listeningHistory:
        ListeningHistoryDetailScreen(stories: stories)
      case .bookmarks:
        BookmarksDetailScreen(
          bookmarkedStoryIDs: bookmarkedStoryIDs,
          stories: stories,
          playStory: playStory,
          openDetail: openDetail,
          toggleBookmark: toggleBookmark
        )
      case .providerStatus:
        ProviderStatusDetailScreen()
      case .privacy:
        PrivacyDetailScreen(hasAcceptedAIProviderDisclosure: $hasAcceptedAIProviderDisclosure)
      case .settings:
        SettingsDetailScreen(
          playbackStates: playbackStates,
          hasAcceptedAIProviderDisclosure: $hasAcceptedAIProviderDisclosure,
          clearBookmarks: clearBookmarks,
          clearGeneratedDownloads: clearGeneratedDownloads
        )
      }
    }
    .accessibilityIdentifier("profile-destination-\(destination.rawValue)")
  }
}

private struct SleepyDetailScaffold<Content: View>: View {
  let title: String
  let systemName: String
  @ViewBuilder let content: Content

  var body: some View {
    ZStack {
      SleepyTheme.eveningGradient
        .ignoresSafeArea()

      ScrollView {
        VStack(alignment: .leading, spacing: SleepyTheme.Spacing.lg) {
          Text(title)
            .font(SleepyTheme.Typography.display)
            .foregroundStyle(SleepyTheme.ColorToken.parchment)
            .lineLimit(2)
            .minimumScaleFactor(0.82)

          content
        }
        .padding(SleepyTheme.Spacing.lg)
        .padding(.bottom, 184)
        .frame(maxWidth: 560, alignment: .leading)
      }
      .scrollIndicators(.hidden)
    }
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.visible, for: .navigationBar)
  }
}

private struct DownloadsDetailScreen: View {
  let stories: [FixtureStory]

  private var downloadedStories: [FixtureStory] {
    stories.filter(\.isDownloaded)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
      StatusInfoCard(
        systemName: "externaldrive.fill",
        title: downloadedStories.isEmpty ? "No downloads yet" : "\(downloadedStories.count) downloaded",
        message: "Downloaded stories are kept on this iPhone for offline listening and can be cleared from Settings."
      )

      if downloadedStories.isEmpty {
        EmptyDetailState(
          title: "Nothing saved offline",
          message: "Stories you download will appear here."
        )
      } else {
        ForEach(downloadedStories) { story in
          CompactStorySummary(story: story, trailing: story.downloadDetail)
        }
      }
    }
  }
}

private struct ListeningHistoryDetailScreen: View {
  let stories: [FixtureStory]

  private var listenedStories: [FixtureStory] {
    stories
      .filter { $0.lastPlayedAt != nil || $0.progress > 0 }
      .sorted {
        ($0.lastPlayedAt ?? .distantPast) > ($1.lastPlayedAt ?? .distantPast)
      }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
      if listenedStories.isEmpty {
        EmptyDetailState(
          title: "No listening history yet",
          message: "Stories appear here once playback begins."
        )
      } else {
        ForEach(listenedStories) { story in
          CompactStorySummary(
            story: story,
            trailing: "\(story.currentTime) listened - \(story.lastListenedLabel)"
          )
        }
      }
    }
  }
}

private struct BookmarksDetailScreen: View {
  let bookmarkedStoryIDs: Set<String>
  let stories: [FixtureStory]
  let playStory: (FixtureStory) -> Void
  let openDetail: (FixtureStory) -> Void
  let toggleBookmark: (FixtureStory) -> Void

  private var bookmarks: [FixtureStory] {
    FixtureStory.bookmarks(in: bookmarkedStoryIDs, from: stories)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
      if bookmarks.isEmpty {
        EmptyBookmarkState()
      } else {
        ListSurface {
          ForEach(Array(bookmarks.enumerated()), id: \.element.id) { index, story in
            SwipeRemovableBookmarkRow(
              story: story,
              playStory: playStory,
              openDetail: openDetail,
              removeBookmark: toggleBookmark
            )

            if index != bookmarks.count - 1 {
              RowSeparator()
            }
          }
        }
      }
    }
  }
}

private struct ProviderStatusDetailScreen: View {
  @State private var health: BackendHealthStatus?
  @State private var statusMessage = "Checking backend..."
  @State private var lastUpdatedAt: Date?

  private var apiBaseURL: URL? {
    try? AppConfiguration().apiBaseURL
  }

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
      StatusInfoCard(
        systemName: "network",
        title: health?.backendSummary ?? statusMessage,
        message: apiBaseURL?.absoluteString ?? "Backend URL is not configured."
      )

      if let health {
        VStack(alignment: .leading, spacing: SleepyTheme.Spacing.sm) {
          ForEach(health.providerRows) { provider in
            ProviderStatusRow(provider: provider)
          }
        }
        .accessibilityIdentifier("provider-status-provider-list")
      } else {
        StatusInfoCard(
          systemName: "sparkles",
          title: "Provider status pending",
          message: "Refresh to check backend, storage, research, writing, narration, and cover art status."
        )
      }

      StatusInfoCard(
        systemName: "gearshape.2.fill",
        title: health?.workerSummary ?? "Worker status pending",
        message: health.map { "Mode: \($0.mode). \(lastUpdatedLabel)" }
          ?? "Worker details will appear once the backend responds."
      )

      Button {
        Task {
          await loadHealth()
        }
      } label: {
        Label("Refresh Status", systemImage: "arrow.clockwise")
          .frame(maxWidth: .infinity, minHeight: 48)
      }
      .buttonStyle(SleepyPrimaryButtonStyle())
      .accessibilityIdentifier("provider-status-refresh")
    }
    .task {
      await loadHealth()
      await refreshHealthWhileVisible()
    }
  }

  private func loadHealth() async {
    if ProcessInfo.processInfo.arguments.contains("--use-mock-generation") {
      health = .uiTestMock
      statusMessage = health?.backendSummary ?? "Backend online"
      lastUpdatedAt = Date()
      return
    }

    guard let apiBaseURL else {
      statusMessage = "Backend URL missing"
      return
    }

    do {
      health = try await BackendHealthClient(apiBaseURL: apiBaseURL).fetch()
      statusMessage = health?.backendSummary ?? "Backend online"
      lastUpdatedAt = Date()
    } catch {
      health = nil
      statusMessage = "Backend unavailable"
    }
  }

  private var lastUpdatedLabel: String {
    guard let lastUpdatedAt else {
      return "Auto-refresh is active."
    }

    return "Last checked \(lastUpdatedAt.formatted(date: .omitted, time: .shortened)); auto-refreshing."
  }

  private func refreshHealthWhileVisible() async {
    while !Task.isCancelled {
      try? await Task.sleep(nanoseconds: 15_000_000_000)
      if Task.isCancelled {
        return
      }
      await loadHealth()
    }
  }
}

private struct ProviderStatusRow: View {
  let provider: BackendHealthStatus.Provider

  var body: some View {
    SleepyCard(padding: SleepyTheme.Spacing.sm) {
      HStack(alignment: .top, spacing: SleepyTheme.Spacing.sm) {
        Image(systemName: provider.systemImage)
          .symbolRenderingMode(.hierarchical)
          .foregroundStyle(provider.tint)
          .font(.system(size: 20, weight: .semibold))
          .frame(width: 30, height: 30)

        VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
          HStack(alignment: .firstTextBaseline, spacing: SleepyTheme.Spacing.xs) {
            Text(provider.step)
              .font(SleepyTheme.Typography.callout.weight(.semibold))
              .foregroundStyle(SleepyTheme.ColorToken.parchment)
              .fixedSize(horizontal: false, vertical: true)
              .accessibilityIdentifier("provider-status-\(provider.id)")

            Spacer(minLength: SleepyTheme.Spacing.xs)

            Text(provider.label)
              .font(SleepyTheme.Typography.label)
              .foregroundStyle(provider.tint)
              .lineLimit(1)
              .minimumScaleFactor(0.75)
              .accessibilityIdentifier("provider-status-\(provider.id)-state")
          }

          Text(provider.providerLine)
            .font(SleepyTheme.Typography.caption)
            .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
            .lineLimit(2)
            .minimumScaleFactor(0.78)

          Text(provider.detail)
            .font(SleepyTheme.Typography.caption)
            .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
            .fixedSize(horizontal: false, vertical: true)

          if !provider.consoleLinks.isEmpty {
            LazyVGrid(
              columns: [GridItem(.adaptive(minimum: 94), spacing: SleepyTheme.Spacing.xs)],
              alignment: .leading,
              spacing: SleepyTheme.Spacing.xs
            ) {
              ForEach(provider.consoleLinks) { link in
                if let destination = link.destination {
                  Link(destination: destination) {
                    HStack(spacing: 4) {
                      Text(link.label)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                      Image(systemName: "arrow.up.right")
                        .font(.system(size: 10, weight: .bold))
                    }
                    .font(SleepyTheme.Typography.label)
                    .foregroundStyle(SleepyTheme.ColorToken.gold)
                    .frame(maxWidth: .infinity, minHeight: 30)
                    .padding(.horizontal, SleepyTheme.Spacing.xs)
                    .background {
                      RoundedRectangle(cornerRadius: SleepyTheme.Radius.sm, style: .continuous)
                        .fill(SleepyTheme.ColorToken.gold.opacity(0.10))
                        .overlay {
                          RoundedRectangle(cornerRadius: SleepyTheme.Radius.sm, style: .continuous)
                            .stroke(SleepyTheme.ColorToken.gold.opacity(0.24), lineWidth: 0.75)
                        }
                    }
                  }
                  .accessibilityLabel("\(provider.provider) \(link.label)")
                }
              }
            }
            .padding(.top, SleepyTheme.Spacing.xxs)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

private struct PrivacyDetailScreen: View {
  @Binding var hasAcceptedAIProviderDisclosure: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
      StatusInfoCard(
        systemName: "lock.shield.fill",
        title: AIProviderDisclosure.title,
        message: AIProviderDisclosure.summary
      )

      ForEach(AIProviderDisclosure.consentBullets, id: \.self) { bullet in
        Label {
          Text(bullet)
            .font(SleepyTheme.Typography.callout)
            .foregroundStyle(SleepyTheme.ColorToken.parchment)
            .fixedSize(horizontal: false, vertical: true)
        } icon: {
          Image(systemName: "checkmark.seal.fill")
            .foregroundStyle(SleepyTheme.ColorToken.gold)
        }
      }

      SettingsStatusRow(
        title: "Disclosure consent",
        value: hasAcceptedAIProviderDisclosure ? "Accepted" : "Will ask before generation",
        systemName: "doc.text.magnifyingglass"
      )
    }
  }
}

private struct SettingsDetailScreen: View {
  @Environment(\.modelContext) private var modelContext
  @Query(sort: \PersistentStory.updatedAt, order: .reverse) private var persistentStories: [PersistentStory]
  @AppStorage(PlaybackDefaults.speedKey) private var defaultSpeed = PlaybackDefaults.defaultSpeed
  @AppStorage(PlaybackDefaults.sleepTimerKey) private var defaultSleepTimer = PlaybackDefaults.defaultSleepTimer

  let playbackStates: [PersistentStoryState]
  @Binding var hasAcceptedAIProviderDisclosure: Bool
  let clearBookmarks: () -> Void
  let clearGeneratedDownloads: () -> Void

  @State private var enrollmentCode = ""
  @State private var enrollmentStatus = "Checking enrollment..."
  @State private var actionMessage = ""
  @State private var pendingDestructiveAction: SettingsDestructiveAction?

  private let tokenStore = KeychainTokenStore()

  private var apiBaseURL: URL? {
    try? AppConfiguration().apiBaseURL
  }

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.lg) {
      enrollmentSection
      playbackDefaultsSection
      localDataSection
    }
    .onAppear(perform: refreshEnrollmentStatus)
    .confirmationDialog(
      pendingDestructiveAction?.title ?? "Confirm",
      isPresented: Binding(
        get: { pendingDestructiveAction != nil },
        set: { isPresented in
          if !isPresented {
            pendingDestructiveAction = nil
          }
        }
      ),
      titleVisibility: .visible
    ) {
      if let action = pendingDestructiveAction {
        Button(action.confirmationTitle, role: .destructive) {
          performDestructiveAction(action)
          pendingDestructiveAction = nil
        }
      }

      Button("Cancel", role: .cancel) {
        pendingDestructiveAction = nil
      }
    } message: {
      if let action = pendingDestructiveAction {
        Text(action.message)
      }
    }
  }

  private var enrollmentSection: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
      SettingsSectionHeader(title: "Owner Enrollment", systemName: "key.fill")

      SettingsStatusRow(title: "Enrollment", value: enrollmentStatus, systemName: "checkmark.shield.fill")
      SettingsStatusRow(title: "Backend", value: apiBaseURL?.absoluteString ?? "Missing URL", systemName: "server.rack")
      SettingsStatusRow(title: "Providers", value: "Backend-managed", systemName: "sparkles")

      StyledTextField(title: "Enrollment code", text: $enrollmentCode)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .accessibilityIdentifier("settings-enrollment-code")

      Button {
        Task {
          await enrollDevice()
        }
      } label: {
        Label("Enroll This iPhone", systemImage: "iphone.gen3")
          .frame(maxWidth: .infinity, minHeight: 48)
      }
      .buttonStyle(SleepyPrimaryButtonStyle())
      .disabled(enrollmentCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || apiBaseURL == nil)
      .accessibilityIdentifier("settings-enroll-device")

    }
  }

  private var playbackDefaultsSection: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
      SettingsSectionHeader(title: "Playback Defaults", systemName: "slider.horizontal.3")

      Picker("Default speed", selection: $defaultSpeed) {
        ForEach(PlaybackDefaults.speedOptions, id: \.self) { speed in
          Text(speed).tag(speed)
        }
      }
      .pickerStyle(.segmented)
      .accessibilityIdentifier("settings-default-speed")

      Picker("Default sleep timer", selection: $defaultSleepTimer) {
        ForEach(PlaybackDefaults.sleepTimerOptions, id: \.self) { timer in
          Text(timer).tag(timer)
        }
      }
      .pickerStyle(.segmented)
      .accessibilityIdentifier("settings-default-sleep-timer")
    }
  }

  private var localDataSection: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
      SettingsSectionHeader(title: "Local Data", systemName: "internaldrive.fill")

      Button {
        hasAcceptedAIProviderDisclosure = false
        actionMessage = "AI disclosure will appear before the next generation."
      } label: {
        SettingsActionLabel(title: "Reset AI Disclosure", systemName: "doc.badge.clock")
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Reset AI Disclosure")
      .accessibilityIdentifier("settings-reset-disclosure")
      .accessibilityValue(actionMessage)

      if !actionMessage.isEmpty {
        Text(actionMessage)
          .font(SleepyTheme.Typography.caption)
          .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("settings-action-message")
      }

      Button {
        pendingDestructiveAction = .clearListeningHistory
      } label: {
        SettingsActionLabel(title: "Clear Listening History", systemName: "clock.badge.xmark")
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Clear Listening History")
      .accessibilityIdentifier("settings-clear-listening-history")

      Button {
        pendingDestructiveAction = .clearDownloads
      } label: {
        SettingsActionLabel(title: "Clear Downloads", systemName: "arrow.down.circle.dotted")
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("settings-clear-downloads")

      Button(role: .destructive) {
        pendingDestructiveAction = .forgetEnrollment
      } label: {
        SettingsActionLabel(title: "Forget Enrollment", systemName: "key.slash", isDestructive: true)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("settings-forget-enrollment")
    }
  }

  private func refreshEnrollmentStatus() {
    do {
      enrollmentStatus = try tokenStore.readToken() == nil ? "Not enrolled" : "Enrolled"
    } catch {
      enrollmentStatus = "Could not read enrollment"
    }
  }

  private func enrollDevice() async {
    guard let apiBaseURL else {
      actionMessage = "Backend URL is missing."
      return
    }

    do {
      _ = try await DeviceEnrollmentClient(apiBaseURL: apiBaseURL, tokenStore: tokenStore)
        .enrollOnce(code: enrollmentCode.trimmingCharacters(in: .whitespacesAndNewlines), deviceLabel: UIDevice.current.name)
      enrollmentCode = ""
      enrollmentStatus = "Enrolled"
      actionMessage = "This iPhone is enrolled."
    } catch {
      refreshEnrollmentStatus()
      actionMessage = "Enrollment failed. Check the code and try again."
    }
  }

  private func forgetEnrollment() {
    do {
      try tokenStore.deleteToken()
      refreshEnrollmentStatus()
      actionMessage = "Enrollment removed from this iPhone."
    } catch {
      actionMessage = "Enrollment could not be removed."
    }
  }

  private func performDestructiveAction(_ action: SettingsDestructiveAction) {
    switch action {
    case .clearListeningHistory:
      clearListeningHistory()
    case .clearDownloads:
      clearDownloads()
    case .forgetEnrollment:
      forgetEnrollment()
    }
  }

  private func clearListeningHistory() {
    for state in playbackStates {
      state.playbackPositionSeconds = 0
      state.playbackChapterID = nil
      state.lastPlayedAt = nil
      state.updatedAt = Date()
    }

    do {
      try modelContext.save()
      actionMessage = "Listening history cleared."
    } catch {
      actionMessage = "Listening history could not be cleared."
    }
  }

  private func clearDownloads() {
    do {
      let service = try StoryDownloadService(context: modelContext)
      for story in persistentStories where story.state?.isDownloaded == true {
        try service.deleteDownloads(for: story)
      }
      clearGeneratedDownloads()
      actionMessage = "Downloads cleared."
    } catch {
      actionMessage = "Downloads could not be cleared."
    }
  }
}

private enum SettingsDestructiveAction: Identifiable {
  case clearListeningHistory
  case clearDownloads
  case forgetEnrollment

  var id: String {
    switch self {
    case .clearListeningHistory:
      return "clear-listening-history"
    case .clearDownloads:
      return "clear-downloads"
    case .forgetEnrollment:
      return "forget-enrollment"
    }
  }

  var title: String {
    switch self {
    case .clearListeningHistory:
      return "Clear Listening History?"
    case .clearDownloads:
      return "Clear Downloads?"
    case .forgetEnrollment:
      return "Forget Enrollment?"
    }
  }

  var message: String {
    switch self {
    case .clearListeningHistory:
      return "Playback positions and recent listening timestamps will reset on this iPhone."
    case .clearDownloads:
      return "Downloaded audio and artwork files will be removed from this iPhone."
    case .forgetEnrollment:
      return "This iPhone will need a new enrollment code before hosted story generation works again."
    }
  }

  var confirmationTitle: String {
    switch self {
    case .clearListeningHistory:
      return "Clear Listening History"
    case .clearDownloads:
      return "Clear Downloads"
    case .forgetEnrollment:
      return "Forget Enrollment"
    }
  }
}

private struct SettingsSectionHeader: View {
  let title: String
  let systemName: String

  var body: some View {
    SleepyPill(title, systemName: systemName)
  }
}

private struct SettingsStatusRow: View {
  let title: String
  let value: String
  let systemName: String

  var body: some View {
    HStack(alignment: .center, spacing: SleepyTheme.Spacing.sm) {
      Image(systemName: systemName)
        .symbolRenderingMode(SleepyTheme.Icon.symbolRenderingMode)
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(SleepyTheme.ColorToken.gold)
        .frame(width: 34, height: 34)
        .background {
          RoundedRectangle(cornerRadius: SleepyTheme.Radius.sm, style: .continuous)
            .fill(SleepyTheme.ColorToken.gold.opacity(0.12))
        }

      Text(title)
        .font(SleepyTheme.Typography.callout.weight(.semibold))
        .foregroundStyle(SleepyTheme.ColorToken.parchment)
        .lineLimit(1)

      Spacer(minLength: SleepyTheme.Spacing.sm)

      Text(value)
        .font(SleepyTheme.Typography.caption)
        .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
        .multilineTextAlignment(.trailing)
        .lineLimit(2)
        .minimumScaleFactor(0.78)
    }
    .padding(SleepyTheme.Spacing.md)
    .background {
      RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
        .fill(SleepyTheme.ColorToken.card.opacity(0.58))
        .overlay {
          RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
            .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 1)
        }
    }
  }
}

private struct SettingsActionLabel: View {
  let title: String
  let systemName: String
  var isDestructive = false

  var body: some View {
    HStack(alignment: .center, spacing: SleepyTheme.Spacing.sm) {
      Image(systemName: systemName)
        .symbolRenderingMode(SleepyTheme.Icon.symbolRenderingMode)
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(isDestructive ? SleepyTheme.ColorToken.amber : SleepyTheme.ColorToken.gold)
        .frame(width: 34, height: 34)
        .background {
          RoundedRectangle(cornerRadius: SleepyTheme.Radius.sm, style: .continuous)
            .fill((isDestructive ? SleepyTheme.ColorToken.amber : SleepyTheme.ColorToken.gold).opacity(0.12))
        }

      Text(title)
        .font(SleepyTheme.Typography.callout.weight(.semibold))
        .foregroundStyle(isDestructive ? SleepyTheme.ColorToken.amber : SleepyTheme.ColorToken.parchment)
        .lineLimit(1)
        .minimumScaleFactor(0.82)

      Spacer(minLength: 0)
    }
    .padding(SleepyTheme.Spacing.md)
    .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
    .background {
      RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
        .fill(SleepyTheme.ColorToken.card.opacity(0.62))
        .overlay {
          RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
            .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 1)
        }
    }
  }
}

private struct StatusInfoCard: View {
  let systemName: String
  let title: String
  let message: String

  var body: some View {
    return SleepyCard {
      HStack(alignment: .top, spacing: SleepyTheme.Spacing.sm) {
        Image(systemName: systemName)
          .symbolRenderingMode(SleepyTheme.Icon.symbolRenderingMode)
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(SleepyTheme.ColorToken.gold)
          .frame(width: 34, height: 34)

        VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xs) {
          Text(title)
            .font(SleepyTheme.Typography.cardTitle)
            .foregroundStyle(SleepyTheme.ColorToken.parchment)
            .fixedSize(horizontal: false, vertical: true)

          Text(message)
            .font(SleepyTheme.Typography.caption)
            .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
            .fixedSize(horizontal: false, vertical: true)
        }

        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct EmptyDetailState: View {
  let title: String
  let message: String

  var body: some View {
    StatusInfoCard(systemName: "moon.zzz.fill", title: title, message: message)
  }
}

private struct CompactCapabilityRow: View {
  let systemName: String
  let title: String
  let detail: String

  var body: some View {
    HStack(spacing: SleepyTheme.Spacing.md) {
      SleepyIconBadge(systemName: systemName)

      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
        Text(title)
          .font(SleepyTheme.Typography.callout.weight(.semibold))
          .foregroundStyle(SleepyTheme.ColorToken.parchment)

        Text(detail)
          .font(SleepyTheme.Typography.caption)
          .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
          .lineLimit(2)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, SleepyTheme.Spacing.md)
    .padding(.vertical, SleepyTheme.Spacing.xs)
  }
}

private struct MiniPlayerBar: View {
  let story: FixtureStory
  let playbackState: PlaybackState
  let openAction: () -> Void
  let togglePlayback: () -> Void

  private var isCurrentStoryPlaying: Bool {
    playbackState.storyID == story.id && playbackState.status == .playing
  }

  var body: some View {
    HStack(spacing: SleepyTheme.Spacing.xs) {
      Button(action: openAction) {
        HStack(spacing: SleepyTheme.Spacing.sm) {
          StoryArtwork(
            size: CGSize(width: 42, height: 42),
            systemName: story.symbol,
            storyTitle: story.title,
            category: story.category,
            coverRemoteURLString: story.coverRemoteURLString,
            coverLocalFileName: story.coverLocalFileName
          )

          VStack(alignment: .leading, spacing: 6) {
            Text(story.title)
              .font(SleepyTheme.Typography.callout.weight(.semibold))
              .foregroundStyle(SleepyTheme.ColorToken.parchment)
              .lineLimit(1)

            Text("\(story.currentTime) / \(story.totalTimeLabel)")
              .font(SleepyTheme.Typography.label)
              .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
              .lineLimit(1)

            ProgressView(value: story.progress)
              .tint(SleepyTheme.ColorToken.gold)
              .accessibilityHidden(true)
              .padding(.top, 1)
          }

          Spacer(minLength: SleepyTheme.Spacing.xs)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Open now playing for \(story.title)")
      .accessibilityValue(isCurrentStoryPlaying ? "Playing" : "\(story.currentTime) / \(story.totalTimeLabel)")
      .accessibilityIdentifier("mini-player-bar")

      Button(action: togglePlayback) {
        Image(systemName: isCurrentStoryPlaying ? "pause.fill" : "play.fill")
          .font(.headline.weight(.bold))
          .foregroundStyle(SleepyTheme.ColorToken.ink)
          .frame(width: 42, height: 42)
          .background {
            Circle()
              .fill(SleepyTheme.ColorToken.gold)
              .shadow(color: SleepyTheme.Shadow.glowColor, radius: 10, x: 0, y: 5)
          }
      }
      .buttonStyle(.plain)
      .accessibilityLabel(isCurrentStoryPlaying ? "Pause minimized story" : "Play minimized story")
      .accessibilityValue(isCurrentStoryPlaying ? "Playing" : "\(story.currentTime) / \(story.totalTimeLabel)")
      .accessibilityIdentifier("mini-player-play-pause")
    }
    .padding(.horizontal, SleepyTheme.Spacing.sm)
    .padding(.vertical, SleepyTheme.Spacing.xs)
    .frame(maxWidth: 560, minHeight: 72)
    .background {
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .fill(SleepyTheme.ColorToken.tabBar.opacity(0.96))
        .overlay {
          RoundedRectangle(cornerRadius: 22, style: .continuous)
            .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 0.75)
        }
        .shadow(color: Color.black.opacity(0.24), radius: 18, x: 0, y: 10)
    }
  }
}

private struct CompactStorySummary: View {
  let story: FixtureStory
  let trailing: String

  var body: some View {
    HStack(spacing: SleepyTheme.Spacing.md) {
      StoryArtwork(
        size: CGSize(width: 58, height: 58),
        systemName: story.symbol,
        storyTitle: story.title,
        category: story.category,
        coverRemoteURLString: story.coverRemoteURLString,
        coverLocalFileName: story.coverLocalFileName
      )

      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
        Text(story.title)
          .font(SleepyTheme.Typography.callout.weight(.semibold))
          .foregroundStyle(SleepyTheme.ColorToken.parchment)
          .lineLimit(2)

        Text(story.progressLabel)
          .font(SleepyTheme.Typography.caption)
          .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
      }

      Spacer(minLength: SleepyTheme.Spacing.sm)

      Text(trailing)
        .font(SleepyTheme.Typography.label)
        .foregroundStyle(SleepyTheme.ColorToken.gold)
        .multilineTextAlignment(.trailing)
    }
    .padding(SleepyTheme.Spacing.md)
    .background {
      RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
        .fill(SleepyTheme.ColorToken.card.opacity(0.58))
        .overlay {
          RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
            .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 1)
        }
    }
  }
}

private struct CreateStoryEntryCard: View {
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(alignment: .center, spacing: SleepyTheme.Spacing.sm) {
        Image(systemName: "plus")
          .font(.system(size: 19, weight: .bold))
          .foregroundStyle(SleepyTheme.ColorToken.ink)
          .frame(width: 46, height: 46)
          .background {
            Circle().fill(SleepyTheme.ColorToken.gold)
          }

        VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xs) {
          Text("Make a new bedtime story")
            .font(SleepyTheme.Typography.cardTitle)
            .foregroundStyle(SleepyTheme.ColorToken.parchment)
            .lineLimit(2)
            .minimumScaleFactor(0.85)

          Text("Choose a figure, place, or quiet daily-life scene and let the app prepare a long listen.")
            .font(SleepyTheme.Typography.caption)
            .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
            .lineLimit(3)
            .fixedSize(horizontal: false, vertical: true)
        }

        Spacer(minLength: SleepyTheme.Spacing.xs)

        Image(systemName: "chevron.right")
          .font(.callout.weight(.semibold))
          .foregroundStyle(SleepyTheme.ColorToken.tertiaryText)
      }
      .padding(SleepyTheme.Spacing.md)
      .background {
        RoundedRectangle(cornerRadius: SleepyTheme.Radius.lg, style: .continuous)
          .fill(SleepyTheme.ColorToken.card.opacity(0.88))
          .overlay {
            RoundedRectangle(cornerRadius: SleepyTheme.Radius.lg, style: .continuous)
              .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 0.75)
          }
      }
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Create a new bedtime story")
    .accessibilityIdentifier("home-create-story-entry")
  }
}

private struct UpNextSection: View {
  let stories: [FixtureStory]
  let playStory: (FixtureStory) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
      ScreenSectionHeader("Up Next", subtitle: "Newest, in progress, and ready to resume")

      VStack(spacing: SleepyTheme.Spacing.sm) {
        ForEach(stories.prefix(2)) { story in
          UpNextCard(story: story, playStory: playStory)
        }
      }
    }
    .accessibilityIdentifier("home-up-next-section")
  }
}

private struct UpNextCard: View {
  let story: FixtureStory
  let playStory: (FixtureStory) -> Void

  var body: some View {
      Button {
        playStory(story)
      } label: {
        VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
          HStack(alignment: .center, spacing: SleepyTheme.Spacing.md) {
            StoryArtwork(
              size: CGSize(width: 94, height: 94),
              systemName: story.symbol,
              storyTitle: story.title,
              category: story.category,
              coverRemoteURLString: story.coverRemoteURLString,
              coverLocalFileName: story.coverLocalFileName
            )

            VStack(alignment: .leading, spacing: SleepyTheme.Spacing.sm) {
              Text(story.title)
                .font(SleepyTheme.Typography.title)
                .foregroundStyle(SleepyTheme.ColorToken.parchment)
                .lineLimit(2)
                .minimumScaleFactor(0.72)
                .layoutPriority(1)

              Text(story.synopsis)
                .font(SleepyTheme.Typography.caption)
                .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

              HStack(spacing: SleepyTheme.Spacing.xs) {
                Label(story.durationLabel, systemImage: "play.fill")
                  .foregroundStyle(SleepyTheme.ColorToken.gold)

                Circle()
                  .fill(SleepyTheme.ColorToken.tertiaryText)
                  .frame(width: 3, height: 3)

                Text(story.lastPlayedAt == nil ? story.progressLabel : story.lastListenedLabel)
                  .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
              }
              .font(SleepyTheme.Typography.label)
              .lineLimit(1)
              .minimumScaleFactor(0.76)
            }

            Spacer(minLength: 0)
          }

          ProgressSummary(story: story)
        }
        .padding(SleepyTheme.Spacing.md)
        .background {
          RoundedRectangle(cornerRadius: SleepyTheme.Radius.lg, style: .continuous)
            .fill(SleepyTheme.ColorToken.card.opacity(0.88))
            .overlay {
              RoundedRectangle(cornerRadius: SleepyTheme.Radius.lg, style: .continuous)
                .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 0.75)
            }
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Open now playing for \(story.title)")
      .accessibilityIdentifier("home-continue-play")
  }
}

private struct CreateStoryFlowView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var draft: CreateStoryDraft
  @State private var isDisclosurePresented = false

  @Binding var hasAcceptedAIProviderDisclosure: Bool
  let submit: (CreateStoryDraft) -> Void

  init(
    initialDraft: CreateStoryDraft = CreateStoryDraft(),
    hasAcceptedAIProviderDisclosure: Binding<Bool>,
    submit: @escaping (CreateStoryDraft) -> Void
  ) {
    _draft = State(initialValue: initialDraft)
    _hasAcceptedAIProviderDisclosure = hasAcceptedAIProviderDisclosure
    self.submit = submit
  }

  var body: some View {
    ZStack {
      SleepyTheme.eveningGradient
        .ignoresSafeArea()

      ScrollView {
        VStack(alignment: .leading, spacing: SleepyTheme.Spacing.lg) {
          kindPicker
          storyFields
          voiceAndLength
          estimateCard

          Button {
            submitAfterDisclosure()
          } label: {
            Label("Start Generation", systemImage: "sparkles")
              .font(SleepyTheme.Typography.callout.weight(.semibold))
              .foregroundStyle(SleepyTheme.ColorToken.ink)
              .frame(maxWidth: .infinity, minHeight: 52)
              .background {
                RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
                  .fill(SleepyTheme.ColorToken.gold)
              }
          }
          .buttonStyle(.plain)
          .disabled(draft.subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityIdentifier("create-story-submit")
        }
        .padding(SleepyTheme.Spacing.lg)
        .frame(maxWidth: 560, alignment: .leading)
      }
      .scrollIndicators(.hidden)
    }
    .navigationTitle("Create Story")
    .navigationBarTitleDisplayMode(.inline)
    .sheet(isPresented: $isDisclosurePresented) {
      AIProviderDisclosureConsentView(
        continueAction: {
          hasAcceptedAIProviderDisclosure = true
          isDisclosurePresented = false
          submit(draft)
        }
      )
      .presentationDetents([.medium, .large])
      .presentationDragIndicator(.visible)
    }
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          dismiss()
        } label: {
          Image(systemName: "xmark")
            .font(.callout.weight(.semibold))
            .foregroundStyle(SleepyTheme.ColorToken.parchment)
        }
        .accessibilityLabel("Close")
      }
    }
    .accessibilityIdentifier("create-story-flow")
  }

  private func submitAfterDisclosure() {
    if AIProviderDisclosure.shouldPresentConsent(hasAccepted: hasAcceptedAIProviderDisclosure) {
      isDisclosurePresented = true
    } else {
      submit(draft)
    }
  }

  private var kindPicker: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
      Text("Story type")
        .font(SleepyTheme.Typography.cardTitle)
        .foregroundStyle(SleepyTheme.ColorToken.parchment)

      LazyVGrid(
        columns: Array(repeating: GridItem(.flexible(), spacing: SleepyTheme.Spacing.sm), count: 2),
        spacing: SleepyTheme.Spacing.sm
      ) {
        ForEach(CreateStoryKind.allCases) { kind in
          Button {
            draft.kind = kind
            if kind == .historicalFigure {
              draft.subject = "Hypatia of Alexandria"
              draft.era = "Late 4th century"
              draft.location = "Alexandria"
              draft.perspective = "A gentle biographical narrator"
            } else {
              draft.subject = "A lantern maker in Ottoman Istanbul"
              draft.era = "Late 16th century"
              draft.location = "Istanbul"
              draft.perspective = "A calm ordinary craftsperson"
            }
          } label: {
            StoryKindChoiceCard(
              systemName: kind.systemImage,
              title: kind.title,
              subtitle: kind == .historicalFigure ? "A quiet life told through sourced biographical context" : "Ordinary work, meals, rooms, routines, and small tensions",
              isSelected: draft.kind == kind
            )
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("create-story-kind-\(kind.rawValue)")
        }
      }
    }
  }

  private var storyFields: some View {
    SleepyCard {
      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
        CreateSectionHeader(
          title: "Story Details",
          subtitle: "Give the writer enough grounding to build a calm, specific scene."
        )
        StyledTextField(title: "Subject", text: $draft.subject)
        StyledTextField(title: "Era", text: $draft.era)
        StyledTextField(title: "Location", text: $draft.location)
        StyledTextField(title: "Perspective", text: $draft.perspective)
      }
    }
  }

  private var voiceAndLength: some View {
    SleepyCard {
      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
        CreateSectionHeader(
          title: "Narration",
          subtitle: "Set the voice and approximate listening length before generation."
        )

        Picker("Voice", selection: $draft.voice) {
          ForEach(CreateStoryDraft.approvedVoices, id: \.self) { voice in
            Text(voice).tag(voice)
          }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("create-story-voice-picker")

        VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xs) {
          HStack {
            Text("Length")
            Spacer()
            Text("\(draft.durationMinutes) min")
              .foregroundStyle(SleepyTheme.ColorToken.gold)
          }
          .font(SleepyTheme.Typography.callout)
          .foregroundStyle(SleepyTheme.ColorToken.parchment)

          Slider(value: Binding(
            get: { Double(draft.durationMinutes) },
            set: { draft.durationMinutes = Int($0.rounded()) }
          ), in: 30...65, step: 5)
          .tint(SleepyTheme.ColorToken.gold)
          .accessibilityIdentifier("create-story-duration-slider")
        }
      }
    }
  }

  private var estimateCard: some View {
    let estimate = GenerationEstimate(draft: draft)

    return SleepyCard {
      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
        CreateSectionHeader(
          title: "Generation",
          subtitle: "The backend prepares research, writing, narration, artwork, transcript, and sources."
        )

        HStack(spacing: SleepyTheme.Spacing.sm) {
          StatTile(value: estimate.costLabel, label: "Estimate")
          StatTile(value: estimate.timeLabel, label: "Generation time")
        }

        VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
          ForEach(estimate.detailLines, id: \.self) { line in
            Text(line)
              .font(SleepyTheme.Typography.label)
              .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
              .lineLimit(1)
              .minimumScaleFactor(0.78)
          }
        }
      }
    }
    .accessibilityIdentifier("create-story-estimate")
  }
}

private struct AIProviderDisclosureConsentView: View {
  @Environment(\.dismiss) private var dismiss

  let continueAction: () -> Void

  var body: some View {
    ZStack {
      SleepyTheme.eveningGradient
        .ignoresSafeArea()

      ScrollView {
        VStack(alignment: .leading, spacing: SleepyTheme.Spacing.lg) {
          VStack(alignment: .leading, spacing: SleepyTheme.Spacing.sm) {
            SleepyPill("Privacy", systemName: "sparkles")

            Text(AIProviderDisclosure.title)
              .font(SleepyTheme.Typography.title)
              .foregroundStyle(SleepyTheme.ColorToken.parchment)
              .fixedSize(horizontal: false, vertical: true)

            Text(AIProviderDisclosure.summary)
              .font(SleepyTheme.Typography.callout)
              .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
              .fixedSize(horizontal: false, vertical: true)
          }

          VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
            ForEach(AIProviderDisclosure.consentBullets, id: \.self) { bullet in
              Label {
                Text(bullet)
                  .font(SleepyTheme.Typography.callout)
                  .foregroundStyle(SleepyTheme.ColorToken.parchment)
                  .fixedSize(horizontal: false, vertical: true)
              } icon: {
                Image(systemName: "checkmark.seal.fill")
                  .symbolRenderingMode(SleepyTheme.Icon.symbolRenderingMode)
                  .foregroundStyle(SleepyTheme.ColorToken.gold)
              }
            }
          }

          VStack(spacing: SleepyTheme.Spacing.sm) {
            Button {
              dismiss()
              continueAction()
            } label: {
              Label("Continue and Start Generation", systemImage: "checkmark")
                .font(SleepyTheme.Typography.callout.weight(.semibold))
                .foregroundStyle(SleepyTheme.ColorToken.ink)
                .frame(maxWidth: .infinity, minHeight: 52)
                .background {
                  RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
                    .fill(SleepyTheme.ColorToken.gold)
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("ai-provider-disclosure-continue")

            Button {
              dismiss()
            } label: {
              Text("Not Now")
                .font(SleepyTheme.Typography.callout.weight(.semibold))
                .foregroundStyle(SleepyTheme.ColorToken.parchment)
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("ai-provider-disclosure-cancel")
          }
        }
        .padding(SleepyTheme.Spacing.lg)
        .frame(maxWidth: 560, alignment: .leading)
      }
      .scrollIndicators(.hidden)
    }
    .accessibilityIdentifier("ai-provider-disclosure-consent")
  }
}

private struct CreateSectionHeader: View {
  let title: String
  let subtitle: String
  let systemName: String?

  init(title: String, subtitle: String, systemName: String? = nil) {
    self.title = title
    self.subtitle = subtitle
    self.systemName = systemName
  }

  var body: some View {
    HStack(alignment: .top, spacing: SleepyTheme.Spacing.sm) {
      if let systemName {
        SleepyIconBadge(systemName: systemName)
      }

      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
        Text(title)
          .font(SleepyTheme.Typography.cardTitle)
          .foregroundStyle(SleepyTheme.ColorToken.parchment)

        Text(subtitle)
          .font(SleepyTheme.Typography.caption)
          .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

private struct StoryKindChoiceCard: View {
  let systemName: String
  let title: String
  let subtitle: String
  let isSelected: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.sm) {
      StoryKindIcon(systemName: systemName, isSelected: isSelected)

      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
        Text(title)
          .font(SleepyTheme.Typography.callout.weight(.semibold))
          .foregroundStyle(SleepyTheme.ColorToken.parchment)
          .lineLimit(2)
          .minimumScaleFactor(0.82)

        Text(subtitle)
          .font(SleepyTheme.Typography.caption)
          .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
          .lineLimit(3)
          .fixedSize(horizontal: false, vertical: true)
      }

      Spacer(minLength: 0)
    }
    .padding(SleepyTheme.Spacing.md)
    .frame(maxWidth: .infinity, minHeight: 166, alignment: .topLeading)
    .background {
      RoundedRectangle(cornerRadius: SleepyTheme.Radius.lg, style: .continuous)
        .fill(isSelected ? SleepyTheme.ColorToken.cardRaised.opacity(0.88) : SleepyTheme.ColorToken.card.opacity(0.64))
        .overlay {
          RoundedRectangle(cornerRadius: SleepyTheme.Radius.lg, style: .continuous)
            .stroke(isSelected ? SleepyTheme.ColorToken.gold.opacity(0.7) : SleepyTheme.ColorToken.stroke, lineWidth: isSelected ? 1.25 : 0.75)
        }
    }
  }
}

private struct StoryKindIcon: View {
  let systemName: String
  let isSelected: Bool

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
        .fill(isSelected ? SleepyTheme.ColorToken.gold : SleepyTheme.ColorToken.gold.opacity(0.12))

      switch systemName {
      case "sleepy.ancient-bust":
        AncientBustGlyph(color: isSelected ? SleepyTheme.ColorToken.ink : SleepyTheme.ColorToken.gold)
          .padding(8)
      case "sleepy.sunrise":
        SunriseGlyph(color: isSelected ? SleepyTheme.ColorToken.ink : SleepyTheme.ColorToken.gold)
          .padding(8)
      default:
        Image(systemName: systemName)
          .symbolRenderingMode(SleepyTheme.Icon.symbolRenderingMode)
          .font(.system(size: 23, weight: .semibold))
          .foregroundStyle(isSelected ? SleepyTheme.ColorToken.ink : SleepyTheme.ColorToken.gold)
      }
    }
    .frame(width: 42, height: 42)
  }
}

private struct AncientBustGlyph: View {
  let color: Color

  var body: some View {
    ZStack {
      AncientBustSilhouette()
        .fill(color)

      AncientBustCurls()
        .fill(color.opacity(0.64))

      AncientBustProfileLine()
        .stroke(color.opacity(0.72), style: StrokeStyle(lineWidth: 1.45, lineCap: .round, lineJoin: .round))
    }
    .aspectRatio(1, contentMode: .fit)
    .accessibilityHidden(true)
  }
}

private struct AncientBustSilhouette: Shape {
  func path(in rect: CGRect) -> Path {
    let width = rect.width
    let height = rect.height
    func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
      CGPoint(x: rect.minX + width * x, y: rect.minY + height * y)
    }

    var path = Path()

    path.move(to: point(0.36, 0.17))
    path.addCurve(to: point(0.63, 0.18), control1: point(0.42, 0.08), control2: point(0.57, 0.08))
    path.addCurve(to: point(0.69, 0.33), control1: point(0.68, 0.22), control2: point(0.69, 0.28))
    path.addLine(to: point(0.79, 0.38))
    path.addLine(to: point(0.68, 0.43))
    path.addCurve(to: point(0.61, 0.58), control1: point(0.67, 0.51), control2: point(0.65, 0.56))
    path.addCurve(to: point(0.46, 0.60), control1: point(0.56, 0.62), control2: point(0.50, 0.62))
    path.addCurve(to: point(0.33, 0.48), control1: point(0.38, 0.56), control2: point(0.33, 0.53))
    path.addCurve(to: point(0.36, 0.17), control1: point(0.27, 0.35), control2: point(0.29, 0.24))
    path.closeSubpath()

    path.addRoundedRect(
      in: CGRect(
        x: rect.minX + width * 0.42,
        y: rect.minY + height * 0.57,
        width: width * 0.20,
        height: height * 0.17
      ),
      cornerSize: CGSize(width: width * 0.04, height: height * 0.04)
    )

    path.move(to: point(0.18, 0.96))
    path.addLine(to: point(0.26, 0.80))
    path.addCurve(to: point(0.74, 0.80), control1: point(0.34, 0.68), control2: point(0.66, 0.68))
    path.addLine(to: point(0.84, 0.96))
    path.closeSubpath()

    path.move(to: point(0.28, 0.84))
    path.addLine(to: point(0.74, 0.84))
    path.addLine(to: point(0.80, 0.96))
    path.addLine(to: point(0.22, 0.96))
    path.closeSubpath()

    return path
  }
}

private struct AncientBustCurls: Shape {
  func path(in rect: CGRect) -> Path {
    let width = rect.width
    let height = rect.height
    func ellipse(_ x: CGFloat, _ y: CGFloat, _ size: CGFloat) -> CGRect {
      CGRect(
        x: rect.minX + width * x,
        y: rect.minY + height * y,
        width: width * size,
        height: height * size
      )
    }

    var path = Path()
    path.addEllipse(in: ellipse(0.29, 0.17, 0.16))
    path.addEllipse(in: ellipse(0.37, 0.09, 0.15))
    path.addEllipse(in: ellipse(0.49, 0.10, 0.14))
    path.addEllipse(in: ellipse(0.58, 0.18, 0.12))
    path.addEllipse(in: ellipse(0.30, 0.31, 0.12))
    path.addEllipse(in: ellipse(0.35, 0.45, 0.12))
    path.addEllipse(in: ellipse(0.47, 0.56, 0.10))
    path.addEllipse(in: ellipse(0.56, 0.52, 0.09))
    return path
  }
}

private struct AncientBustProfileLine: Shape {
  func path(in rect: CGRect) -> Path {
    let width = rect.width
    let height = rect.height
    func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
      CGPoint(x: rect.minX + width * x, y: rect.minY + height * y)
    }

    var path = Path()
    path.move(to: point(0.59, 0.27))
    path.addLine(to: point(0.64, 0.37))
    path.addLine(to: point(0.59, 0.42))

    path.move(to: point(0.52, 0.33))
    path.addLine(to: point(0.57, 0.32))

    path.move(to: point(0.52, 0.48))
    path.addCurve(to: point(0.63, 0.50), control1: point(0.56, 0.52), control2: point(0.60, 0.52))

    path.move(to: point(0.38, 0.84))
    path.addCurve(to: point(0.65, 0.83), control1: point(0.46, 0.78), control2: point(0.57, 0.78))

    return path
  }
}

private struct SunriseGlyph: View {
  let color: Color

  var body: some View {
    ZStack {
      SunriseSun()
        .fill(color.opacity(0.94))

      SunriseRays()
        .stroke(color, style: StrokeStyle(lineWidth: 1.55, lineCap: .round, lineJoin: .round))

      SunriseHorizon()
        .stroke(color, style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
    }
    .aspectRatio(1, contentMode: .fit)
    .accessibilityHidden(true)
  }
}

private struct SunriseSun: Shape {
  func path(in rect: CGRect) -> Path {
    let width = rect.width
    let height = rect.height
    let center = CGPoint(x: rect.midX, y: rect.minY + height * 0.66)
    let radius = min(width, height) * 0.20
    var path = Path()
    path.move(to: CGPoint(x: center.x - radius, y: center.y))
    path.addArc(center: center, radius: radius, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
    path.addLine(to: CGPoint(x: center.x - radius, y: center.y))
    path.closeSubpath()
    return path
  }
}

private struct SunriseRays: Shape {
  func path(in rect: CGRect) -> Path {
    let width = rect.width
    let height = rect.height
    func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
      CGPoint(x: rect.minX + width * x, y: rect.minY + height * y)
    }

    var path = Path()
    path.move(to: point(0.50, 0.18))
    path.addLine(to: point(0.50, 0.32))

    path.move(to: point(0.27, 0.29))
    path.addLine(to: point(0.36, 0.39))

    path.move(to: point(0.73, 0.29))
    path.addLine(to: point(0.64, 0.39))

    path.move(to: point(0.17, 0.51))
    path.addLine(to: point(0.31, 0.55))

    path.move(to: point(0.83, 0.51))
    path.addLine(to: point(0.69, 0.55))

    return path
  }
}

private struct SunriseHorizon: Shape {
  func path(in rect: CGRect) -> Path {
    let width = rect.width
    let height = rect.height
    func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
      CGPoint(x: rect.minX + width * x, y: rect.minY + height * y)
    }

    var path = Path()
    path.move(to: point(0.15, 0.66))
    path.addLine(to: point(0.85, 0.66))

    path.move(to: point(0.24, 0.79))
    path.addCurve(to: point(0.76, 0.79), control1: point(0.38, 0.74), control2: point(0.62, 0.74))
    return path
  }
}

private struct StyledTextField: View {
  let title: String
  @Binding var text: String

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
      Text(title)
        .font(SleepyTheme.Typography.label)
        .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)

      TextField(title, text: $text)
        .textInputAutocapitalization(.sentences)
        .font(SleepyTheme.Typography.callout)
        .foregroundStyle(SleepyTheme.ColorToken.parchment)
        .padding(SleepyTheme.Spacing.sm)
        .background {
          RoundedRectangle(cornerRadius: SleepyTheme.Radius.sm, style: .continuous)
            .fill(SleepyTheme.ColorToken.cardRaised.opacity(0.64))
            .overlay {
              RoundedRectangle(cornerRadius: SleepyTheme.Radius.sm, style: .continuous)
                .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 1)
            }
        }
        .accessibilityIdentifier("create-story-field-\(title.lowercased())")
    }
  }
}

private struct StoryStrip: View {
  let title: String
  let stories: [FixtureStory]
  let playStory: (FixtureStory) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
      ScreenSectionHeader(title, subtitle: "Fresh stories and imports")

      ScrollView(.horizontal) {
        HStack(spacing: SleepyTheme.Spacing.md) {
          ForEach(stories) { story in
            Button {
              playStory(story)
            } label: {
              VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xs) {
                StoryArtwork(
                  size: CGSize(width: 136, height: 136),
                  systemName: story.symbol,
                  storyTitle: story.title,
                  category: story.category,
                  coverRemoteURLString: story.coverRemoteURLString,
                  coverLocalFileName: story.coverLocalFileName
                )

                Text(story.title)
                  .font(SleepyTheme.Typography.caption)
                  .foregroundStyle(SleepyTheme.ColorToken.parchment)
                  .lineLimit(2)
                  .minimumScaleFactor(0.82)
                  .frame(width: 136, alignment: .leading)

                Text(story.category)
                  .font(SleepyTheme.Typography.label)
                  .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
                  .lineLimit(1)
                  .frame(width: 136, alignment: .leading)
              }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open \(story.title)")
            .accessibilityIdentifier("recent-story-\(story.id)")
          }
        }
      }
      .scrollIndicators(.hidden)
      .accessibilityIdentifier("home-recent-stories")
    }
  }
}

private struct LibrarySearchField: View {
  @Binding var searchText: String

  var body: some View {
    HStack(spacing: SleepyTheme.Spacing.sm) {
      Image(systemName: "magnifyingglass")
        .foregroundStyle(SleepyTheme.ColorToken.gold)

      TextField("Search stories", text: $searchText)
        .textInputAutocapitalization(.never)
        .disableAutocorrection(true)
        .foregroundStyle(SleepyTheme.ColorToken.parchment)
        .accessibilityIdentifier("library-search-field")

      if !searchText.isEmpty {
        Button {
          searchText = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear library search")
      }
    }
    .font(SleepyTheme.Typography.callout)
    .padding(.horizontal, SleepyTheme.Spacing.md)
    .padding(.vertical, SleepyTheme.Spacing.sm)
    .background {
      RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
        .fill(SleepyTheme.ColorToken.card.opacity(0.68))
        .overlay {
          RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
            .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 1)
        }
    }
    .accessibilityElement(children: .contain)
  }
}

private struct FilterButton: View {
  let filter: LibraryStoryFilter
  let isSelected: Bool
  let count: Int
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: SleepyTheme.Spacing.xs) {
        Text(filter.title)
          .lineLimit(1)

        Text("\(count)")
          .font(SleepyTheme.Typography.label)
          .foregroundStyle(isSelected ? SleepyTheme.ColorToken.ink : SleepyTheme.ColorToken.gold)
          .padding(.horizontal, 7)
          .padding(.vertical, 3)
          .background {
            Capsule()
              .fill(isSelected ? SleepyTheme.ColorToken.parchment.opacity(0.72) : SleepyTheme.ColorToken.gold.opacity(0.14))
          }
      }
      .font(SleepyTheme.Typography.label)
      .foregroundStyle(isSelected ? SleepyTheme.ColorToken.ink : SleepyTheme.ColorToken.parchment)
      .padding(.horizontal, SleepyTheme.Spacing.sm)
      .frame(height: 36)
      .background {
        Capsule()
          .fill(isSelected ? SleepyTheme.ColorToken.gold : SleepyTheme.ColorToken.cardRaised.opacity(0.72))
          .overlay {
            Capsule()
              .stroke(isSelected ? SleepyTheme.ColorToken.gold.opacity(0.55) : SleepyTheme.ColorToken.stroke, lineWidth: 1)
          }
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(filter.title), \(count) stories")
    .accessibilityIdentifier(filter.accessibilityIdentifier)
  }
}

private struct StoryRow: View {
  let story: FixtureStory
  let isBookmarked: Bool
  let playStory: (FixtureStory) -> Void
  let toggleBookmark: (FixtureStory) -> Void
  let openDetail: (FixtureStory) -> Void

  var body: some View {
    HStack(alignment: .center, spacing: SleepyTheme.Spacing.md) {
      Button {
        openDetail(story)
      } label: {
        HStack(alignment: .center, spacing: SleepyTheme.Spacing.md) {
          StoryArtwork(
            size: CGSize(width: 88, height: 88),
            systemName: story.symbol,
            storyTitle: story.title,
            category: story.category,
            coverRemoteURLString: story.coverRemoteURLString,
            coverLocalFileName: story.coverLocalFileName
          )

          VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xs) {
            Text(story.title)
              .font(SleepyTheme.Typography.callout.weight(.semibold))
              .foregroundStyle(SleepyTheme.ColorToken.parchment)
              .lineLimit(2)
              .minimumScaleFactor(0.82)

            Text(story.subtitle)
              .font(SleepyTheme.Typography.caption)
              .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
              .lineLimit(2)

            HStack(spacing: SleepyTheme.Spacing.xs) {
              Text(story.progressLabel)
                .font(SleepyTheme.Typography.label)
                .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
                .lineLimit(1)
                .minimumScaleFactor(0.78)

              Circle()
                .fill(SleepyTheme.ColorToken.tertiaryText)
                .frame(width: 3, height: 3)

              Text(story.durationLabel)
                .font(SleepyTheme.Typography.label)
                .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
                .lineLimit(1)

              DownloadIndicator(story: story)
            }

            ProgressView(value: story.progress)
              .tint(story.status == .failed ? SleepyTheme.ColorToken.amber : SleepyTheme.ColorToken.gold)
              .accessibilityHidden(true)
          }

          Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Open details for \(story.title)")
      .accessibilityIdentifier("story-row-\(story.id)")

      VStack(spacing: SleepyTheme.Spacing.sm) {
        Button {
          playStory(story)
        } label: {
          Image(systemName: story.status == .failed ? "arrow.clockwise" : "play.fill")
            .font(.callout.weight(.bold))
            .foregroundStyle(SleepyTheme.ColorToken.ink)
            .frame(width: 38, height: 38)
            .background {
              Circle().fill(SleepyTheme.ColorToken.gold)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(story.status == .failed ? "Review \(story.title)" : "Play \(story.title)")

        Button {
          toggleBookmark(story)
        } label: {
          Image(systemName: isBookmarked ? "bookmark.fill" : "bookmark")
            .font(.callout.weight(.semibold))
            .foregroundStyle(isBookmarked ? SleepyTheme.ColorToken.gold : SleepyTheme.ColorToken.tertiaryText)
            .frame(width: 32, height: 32)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isBookmarked ? "Remove \(story.title) from bookmarks" : "Add \(story.title) to bookmarks")
        .accessibilityIdentifier("bookmark-toggle-\(story.id)")
      }
    }
    .padding(SleepyTheme.Spacing.md)
    .accessibilityElement(children: .contain)
  }
}

private struct SwipeRemovableBookmarkRow: View {
  let story: FixtureStory
  let playStory: (FixtureStory) -> Void
  let openDetail: (FixtureStory) -> Void
  let removeBookmark: (FixtureStory) -> Void

  @State private var horizontalOffset: CGFloat = 0
  @State private var isRevealed = false

  private let revealWidth: CGFloat = 88

  var body: some View {
    ZStack(alignment: .trailing) {
      Button {
        withAnimation(.easeOut(duration: 0.18)) {
          removeBookmark(story)
          isRevealed = false
          horizontalOffset = 0
        }
      } label: {
        VStack(spacing: SleepyTheme.Spacing.xxs) {
          Image(systemName: "bookmark.slash.fill")
            .font(.callout.weight(.bold))
          Text("Remove")
            .font(SleepyTheme.Typography.label)
        }
        .foregroundStyle(SleepyTheme.ColorToken.parchment)
        .frame(width: revealWidth)
        .frame(maxHeight: .infinity)
        .background(SleepyTheme.ColorToken.amber.opacity(0.72))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Swipe delete \(story.title) bookmark")
      .accessibilityIdentifier("bookmark-swipe-delete-\(story.id)")

      StoryRow(
        story: story,
        isBookmarked: true,
        playStory: playStory,
        toggleBookmark: removeBookmark,
        openDetail: openDetail
      )
      .background(SleepyTheme.ColorToken.card.opacity(0.98))
      .offset(x: horizontalOffset)
      .highPriorityGesture(
        DragGesture(minimumDistance: 18)
          .onChanged { value in
            let base = isRevealed ? -revealWidth : 0
            horizontalOffset = min(max(base + value.translation.width, -revealWidth), 0)
          }
          .onEnded { value in
            let shouldReveal = horizontalOffset < -revealWidth * 0.45 || value.predictedEndTranslation.width < -revealWidth
            withAnimation(.easeOut(duration: 0.18)) {
              isRevealed = shouldReveal
              horizontalOffset = shouldReveal ? -revealWidth : 0
            }
          }
      )
    }
    .clipped()
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("bookmark-swipe-row-\(story.id)")
  }
}

private struct GenerationProgressSection: View {
  let jobs: [FixtureGeneratedJob]
  let cancelJob: (FixtureGeneratedJob) -> Void
  let retryJob: (FixtureGeneratedJob) -> Void
  let deleteJob: (FixtureGeneratedJob) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
      Text("Generation Queue")
        .font(SleepyTheme.Typography.cardTitle)
        .foregroundStyle(SleepyTheme.ColorToken.parchment)
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)

      ForEach(jobs) { job in
        GenerationProgressCard(
          job: job,
          cancelJob: cancelJob,
          retryJob: retryJob,
          deleteJob: deleteJob
        )
      }
    }
    .accessibilityIdentifier("generation-progress-section")
  }
}

private struct GenerationProgressCard: View {
  let job: FixtureGeneratedJob
  let cancelJob: (FixtureGeneratedJob) -> Void
  let retryJob: (FixtureGeneratedJob) -> Void
  let deleteJob: (FixtureGeneratedJob) -> Void

  var body: some View {
    SleepyCard {
      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.sm) {
        HStack(spacing: SleepyTheme.Spacing.sm) {
          SleepyIconBadge(systemName: job.state.systemImage)

          VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
            Text(job.title)
              .font(SleepyTheme.Typography.cardTitle)
              .foregroundStyle(SleepyTheme.ColorToken.parchment)
              .lineLimit(2)

            Text("\(job.state.label) - \(job.detail)")
              .font(SleepyTheme.Typography.caption)
              .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
              .lineLimit(2)
          }
        }

        ProgressView(value: job.progress)
          .tint(tint)
          .accessibilityLabel("Generation progress")
          .accessibilityValue("\(Int(job.progress * 100)) percent")

        VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
          Text(job.stage)
            .font(SleepyTheme.Typography.label)
            .foregroundStyle(tint)
            .accessibilityIdentifier("generation-job-stage-\(job.id)")

          Text(job.failureReason ?? job.message)
            .font(SleepyTheme.Typography.caption)
            .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("generation-job-message-\(job.id)")
        }

        HStack(spacing: SleepyTheme.Spacing.sm) {
          if job.state == .running || job.state == .partial {
            Button {
              cancelJob(job)
            } label: {
              Label("Cancel", systemImage: "xmark.circle")
            }
            .disabled(job.state == .canceled)
          }

          if job.state == .failed || job.state == .budgetLimit || job.state == .canceled {
            Button {
              retryJob(job)
            } label: {
              Label("Retry", systemImage: "arrow.clockwise")
            }
          }

          if job.state == .completed || job.state == .failed || job.state == .budgetLimit || job.state == .canceled {
            Button(role: .destructive) {
              deleteJob(job)
            } label: {
              Label("Delete", systemImage: "trash")
            }
          }
        }
        .font(SleepyTheme.Typography.label)
        .buttonStyle(.bordered)
        .tint(SleepyTheme.ColorToken.gold)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("generation-job-\(job.id)")
  }

  private var tint: Color {
    switch job.state {
    case .running:
      return SleepyTheme.ColorToken.moon
    case .partial:
      return SleepyTheme.ColorToken.gold
    case .failed, .budgetLimit:
      return SleepyTheme.ColorToken.amber
    case .canceled:
      return SleepyTheme.ColorToken.parchmentMuted
    case .completed:
      return SleepyTheme.ColorToken.gold
    }
  }
}

private struct EmptyBookmarkState: View {
  var body: some View {
    SleepyCard {
      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.sm) {
        SleepyIconBadge(systemName: "bookmark")

        Text("No bookmarks yet")
          .font(SleepyTheme.Typography.cardTitle)
          .foregroundStyle(SleepyTheme.ColorToken.parchment)

        Text("Tap the bookmark beside any story to keep it on this shelf.")
          .font(SleepyTheme.Typography.caption)
          .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, minHeight: 112, alignment: .topLeading)
    }
    .frame(maxWidth: .infinity)
    .accessibilityIdentifier("bookmarks-empty-state")
  }
}

private enum StoryDetailFocus: Hashable, Identifiable {
  case overview
  case transcript
  case sources
  case notes

  var id: Self { self }
}

private struct StoryDetailView: View {
  @Environment(\.dismiss) private var dismiss

  let story: FixtureStory
  let initialFocus: StoryDetailFocus

  init(story: FixtureStory, initialFocus: StoryDetailFocus = .overview) {
    self.story = story
    self.initialFocus = initialFocus
  }

  var body: some View {
    ZStack {
      SleepyTheme.eveningGradient
        .ignoresSafeArea()

      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: SleepyTheme.Spacing.lg) {
            detailHero
            sectionNavigation(proxy: proxy)
            overviewSection
              .id(StoryDetailFocus.overview)
            transcriptSection
              .id(StoryDetailFocus.transcript)
            sourcesSection
              .id(StoryDetailFocus.sources)
            notesSection
              .id(StoryDetailFocus.notes)
          }
          .padding(SleepyTheme.Spacing.lg)
          .padding(.bottom, 156)
          .frame(maxWidth: 560, alignment: .leading)
        }
        .scrollIndicators(.hidden)
        .accessibilityIdentifier("story-detail-screen")
        .task(id: initialFocus) {
          guard initialFocus != .overview else {
            return
          }

          await Task.yield()
          withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo(initialFocus, anchor: .top)
          }
        }
      }
    }
    .navigationTitle(story.title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          dismiss()
        } label: {
          Image(systemName: "xmark")
            .font(.callout.weight(.semibold))
            .foregroundStyle(SleepyTheme.ColorToken.parchment)
        }
        .accessibilityLabel("Close story details")
        .accessibilityIdentifier("story-detail-close")
      }
    }
  }

  private var detailHero: some View {
    SleepyCard {
      HStack(alignment: .center, spacing: SleepyTheme.Spacing.md) {
        StoryArtwork(
          size: CGSize(width: 88, height: 88),
          systemName: story.symbol,
          storyTitle: story.title,
          category: story.category,
          coverRemoteURLString: story.coverRemoteURLString,
          coverLocalFileName: story.coverLocalFileName
        )

        VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xs) {
          SleepyPill(story.category, systemName: story.status.systemImage)
          Text(story.title)
            .font(SleepyTheme.Typography.title)
            .foregroundStyle(SleepyTheme.ColorToken.parchment)
            .lineLimit(2)
            .minimumScaleFactor(0.78)
            .dynamicTypeSize(...DynamicTypeSize.accessibility2)
          Text(story.synopsis)
            .font(SleepyTheme.Typography.caption)
            .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
            .lineLimit(3)
        }
      }
    }
  }

  private func sectionNavigation(proxy: ScrollViewProxy) -> some View {
    ScrollView(.horizontal) {
      HStack(spacing: SleepyTheme.Spacing.sm) {
        StoryDetailJumpButton(title: "Overview", systemName: "info.circle") {
          scroll(to: .overview, proxy: proxy)
        }
        .accessibilityIdentifier("story-detail-jump-overview")

        StoryDetailJumpButton(title: "Transcript", systemName: "text.alignleft") {
          scroll(to: .transcript, proxy: proxy)
        }
        .accessibilityIdentifier("story-detail-jump-transcript")

        StoryDetailJumpButton(title: "Sources", systemName: "link") {
          scroll(to: .sources, proxy: proxy)
        }
        .accessibilityIdentifier("story-detail-jump-sources")

        StoryDetailJumpButton(title: "Notes", systemName: "sparkles") {
          scroll(to: .notes, proxy: proxy)
        }
        .accessibilityIdentifier("story-detail-jump-notes")
      }
      .padding(.vertical, 1)
    }
    .scrollIndicators(.hidden)
    .accessibilityIdentifier("story-detail-section-navigation")
  }

  private func scroll(to focus: StoryDetailFocus, proxy: ScrollViewProxy) {
    withAnimation(.easeOut(duration: 0.22)) {
      proxy.scrollTo(focus, anchor: .top)
    }
  }

  private var overviewSection: some View {
    StoryDetailSection(
      title: "Overview",
      subtitle: "\(story.durationLabel) listen",
      systemName: "info.circle"
    ) {
      DetailTextBlock(title: "About this story", text: story.aboutText)
      ProgressSummary(story: story)
    }
    .accessibilityIdentifier("story-detail-overview-section")
  }

  private var transcriptSection: some View {
    StoryDetailSection(
      title: "Transcript",
      subtitle: "\(story.transcriptSections.count) sections",
      systemName: "text.alignleft"
    ) {
      ForEach(story.transcriptSections) { section in
        DetailTextBlock(title: section.title, text: section.text)
      }
    }
    .accessibilityIdentifier("story-detail-transcript-section")
  }

  private var sourcesSection: some View {
    StoryDetailSection(
      title: "Sources",
      subtitle: "\(story.sourceLinks.count) references",
      systemName: "link"
    ) {
      ForEach(story.sourceLinks) { source in
        SourceRow(source: source)
      }
    }
    .accessibilityIdentifier("story-detail-sources-section")
  }

  private var notesSection: some View {
    StoryDetailSection(
      title: "Story Notes",
      subtitle: "Generation context",
      systemName: "sparkles"
    ) {
      ForEach(story.funFacts, id: \.self) { fact in
        Label(fact, systemImage: "moon.stars.fill")
          .font(SleepyTheme.Typography.callout)
          .foregroundStyle(SleepyTheme.ColorToken.parchment)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityIdentifier("story-detail-notes-section")
  }
}

private struct StoryDetailJumpButton: View {
  let title: String
  let systemName: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label(title, systemImage: systemName)
        .font(SleepyTheme.Typography.caption.weight(.semibold))
        .foregroundStyle(SleepyTheme.ColorToken.parchment)
        .lineLimit(1)
        .padding(.horizontal, SleepyTheme.Spacing.sm)
        .frame(height: 38)
        .background {
          Capsule()
            .fill(SleepyTheme.ColorToken.cardRaised.opacity(0.78))
            .overlay {
              Capsule()
                .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 1)
            }
        }
    }
    .buttonStyle(.plain)
  }
}

private struct SourceRow: View {
  let source: FixtureSourceLink

  var body: some View {
    if let url = source.url {
      Link(destination: url) {
        content(showsExternalIndicator: true)
      }
      .buttonStyle(.plain)
      .foregroundStyle(SleepyTheme.ColorToken.parchment)
      .accessibilityLabel("Open source \(source.title)")
    } else {
      content(showsExternalIndicator: false)
        .foregroundStyle(SleepyTheme.ColorToken.parchment)
        .accessibilityElement(children: .combine)
    }
  }

  private func content(showsExternalIndicator: Bool) -> some View {
    HStack(alignment: .top, spacing: SleepyTheme.Spacing.sm) {
      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
        Text(source.title)
          .font(SleepyTheme.Typography.callout)

        Text("\(source.publisher) / \(source.locationLabel)")
          .font(SleepyTheme.Typography.label)
          .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)

        Text(source.displayContext)
          .font(SleepyTheme.Typography.caption)
          .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
          .fixedSize(horizontal: false, vertical: true)

        if let retrievalLabel = source.retrievalLabel {
          Text(retrievalLabel)
            .font(SleepyTheme.Typography.label)
            .foregroundStyle(SleepyTheme.ColorToken.tertiaryText)
        }
      }

      Spacer()

      if showsExternalIndicator {
        Image(systemName: "arrow.up.right")
      }
    }
  }
}

private struct StoryDetailSection<Content: View>: View {
  let title: String
  let subtitle: String
  let systemName: String
  @ViewBuilder let content: Content

  var body: some View {
    SleepyCard {
      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.md) {
        HStack(alignment: .firstTextBaseline) {
          SleepyPill(title, systemName: systemName)

          Spacer(minLength: SleepyTheme.Spacing.sm)

          Text(subtitle)
            .font(SleepyTheme.Typography.label)
            .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
        }
        content
      }
    }
    .accessibilityElement(children: .contain)
  }
}

private struct DetailTextBlock: View {
  let title: String
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xs) {
      Text(title)
        .font(SleepyTheme.Typography.cardTitle)
        .foregroundStyle(SleepyTheme.ColorToken.parchment)

      Text(text)
        .font(SleepyTheme.Typography.callout)
        .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

private struct ProgressSummary: View {
  let story: FixtureStory

  var body: some View {
    VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
      ProgressView(value: story.progress)
        .tint(progressTint)
        .accessibilityLabel("Progress")
        .accessibilityValue(story.progressLabel)

      HStack(spacing: SleepyTheme.Spacing.xs) {
        Label(story.progressStatusLabel, systemImage: story.progressStatusSystemImage)
          .foregroundStyle(progressTint)

        Spacer(minLength: SleepyTheme.Spacing.xs)

        Text(story.progressLabel)
          .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
      }
      .font(SleepyTheme.Typography.label)
      .lineLimit(1)
      .minimumScaleFactor(0.78)
    }
  }

  private var progressTint: Color {
    switch story.status {
    case .completed:
      return SleepyTheme.ColorToken.gold
    case .inProgress:
      return SleepyTheme.ColorToken.moon
    case .failed:
      return SleepyTheme.ColorToken.amber
    }
  }
}

private struct DownloadIndicator: View {
  let story: FixtureStory

  var body: some View {
    Group {
      if story.isDownloaded {
        Image(systemName: "arrow.down.circle.fill")
          .foregroundStyle(SleepyTheme.ColorToken.moon)
      } else if story.status == .inProgress {
        Label("Generating", systemImage: "clock")
          .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
      } else {
        Text("Streaming")
          .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
      }
    }
    .font(SleepyTheme.Typography.label)
    .lineLimit(1)
    .accessibilityLabel(story.downloadDetail)
  }
}

enum StoryArtworkScene: Equatable {
  case alexandria
  case warmKitchen
  case lanternMaker
  case copperAndFlame
  case copperAndCoal

  static func scene(for title: String, category _: String) -> StoryArtworkScene? {
    let normalized = title.lowercased()
    if normalized.contains("library at alexandria") {
      return .alexandria
    }
    if normalized.contains("warm kitchen") {
      return .warmKitchen
    }
    if normalized.contains("lantern maker") || normalized.contains("ottoman istanbul") {
      return .lanternMaker
    }
    if normalized.contains("copper and the flame") {
      return .copperAndFlame
    }
    if normalized.contains("copper and the coal") {
      return .copperAndCoal
    }
    return nil
  }
}

private struct StoryArtwork: View {
  let size: CGSize
  let systemName: String
  let storyTitle: String
  let category: String
  let coverRemoteURLString: String?
  let coverLocalFileName: String?

  init(
    size: CGSize,
    systemName: String,
    storyTitle: String = "Sleepy History",
    category: String = "Story",
    coverRemoteURLString: String? = nil,
    coverLocalFileName: String? = nil
  ) {
    self.size = size
    self.systemName = systemName
    self.storyTitle = storyTitle
    self.category = category
    self.coverRemoteURLString = coverRemoteURLString
    self.coverLocalFileName = coverLocalFileName
  }

  var body: some View {
    artworkContent
      .frame(width: size.width, height: size.height)
      .clipShape(RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
          .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 1)
      }
      .shadow(color: SleepyTheme.Shadow.glowColor, radius: 14, x: 0, y: 8)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Artwork for \(storyTitle)")
      .accessibilityIdentifier("story-artwork-\(storyTitle.sleepyIdentifierSlug)")
  }

  @ViewBuilder
  private var artworkContent: some View {
    if let storyScene {
      StorySpecificArtwork(scene: storyScene, size: size)
    } else if let localImage = localCoverImage {
      Image(uiImage: localImage)
        .resizable()
        .scaledToFill()
    } else if let remoteURL {
      AsyncImage(url: remoteURL) { phase in
        switch phase {
        case .success(let image):
          image
            .resizable()
            .scaledToFill()
        case .failure, .empty:
          placeholder
        @unknown default:
          placeholder
        }
      }
    } else {
      placeholder
    }
  }

  private var placeholder: some View {
    GeneratedArtworkFallback(
      title: storyTitle,
      category: category,
      size: size
    )
  }

  private var remoteURL: URL? {
    coverRemoteURLString.flatMap(URL.init(string:))
  }

  private var storyScene: StoryArtworkScene? {
    StoryArtworkScene.scene(for: storyTitle, category: category)
  }

  private var localCoverImage: UIImage? {
    guard let coverLocalFileName,
          let fileStore = try? DownloadFileStore(),
          let image = UIImage(contentsOfFile: fileStore.fileURL(fileName: coverLocalFileName).path(percentEncoded: false)) else {
      return nil
    }

    return image
  }
}

private struct StorySpecificArtwork: View {
  let scene: StoryArtworkScene
  let size: CGSize

  var body: some View {
    switch scene {
    case .alexandria:
      AlexandriaArtwork(size: size)
    case .warmKitchen:
      WarmKitchenArtwork(size: size)
    case .lanternMaker:
      LanternMakerArtwork(size: size)
    case .copperAndFlame:
      CopperHearthArtwork(size: size, emberColor: Color(red: 0.98, green: 0.42, blue: 0.20))
    case .copperAndCoal:
      CopperHearthArtwork(size: size, emberColor: Color(red: 0.82, green: 0.30, blue: 0.16))
    }
  }
}

private struct AlexandriaArtwork: View {
  let size: CGSize

  var body: some View {
    GeometryReader { proxy in
      let width = proxy.size.width
      let height = proxy.size.height
      let amber = Color(red: 0.96, green: 0.61, blue: 0.28)
      let papyrus = Color(red: 0.95, green: 0.82, blue: 0.58)
      let shadow = Color(red: 0.08, green: 0.13, blue: 0.14)

      ZStack {
        LinearGradient(
          colors: [
            Color(red: 0.22, green: 0.29, blue: 0.31),
            Color(red: 0.13, green: 0.18, blue: 0.18),
            SleepyTheme.ColorToken.midnight
          ],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        )

        Circle()
          .fill(amber.opacity(0.22))
          .frame(width: width * 0.72, height: width * 0.72)
          .offset(x: width * 0.38, y: -height * 0.28)

        ForEach(0..<4, id: \.self) { index in
          RoundedRectangle(cornerRadius: width * 0.018, style: .continuous)
            .fill(papyrus.opacity(0.34))
            .frame(width: max(width * 0.055, 3), height: height * 0.58)
            .overlay(alignment: .top) {
              Capsule()
                .fill(papyrus.opacity(0.52))
                .frame(width: width * 0.11, height: max(width * 0.03, 2))
                .offset(y: -width * 0.025)
            }
            .offset(x: -width * 0.30 + CGFloat(index) * width * 0.18, y: height * 0.05)
        }

        RoundedRectangle(cornerRadius: width * 0.035, style: .continuous)
          .fill(shadow.opacity(0.50))
          .frame(width: width * 0.72, height: height * 0.18)
          .offset(y: height * 0.33)

        ForEach(0..<3, id: \.self) { index in
          Capsule()
            .fill(papyrus.opacity(0.66))
            .frame(width: width * 0.36, height: max(width * 0.04, 3))
            .overlay {
              Capsule()
                .stroke(shadow.opacity(0.26), lineWidth: max(width * 0.01, 1))
            }
            .rotationEffect(.degrees(index == 1 ? -8 : 6))
            .offset(x: width * (-0.12 + CGFloat(index) * 0.10), y: height * (0.16 + CGFloat(index) * 0.04))
        }

        Path { path in
          path.move(to: CGPoint(x: width * 0.12, y: height * 0.79))
          path.addCurve(
            to: CGPoint(x: width * 0.88, y: height * 0.76),
            control1: CGPoint(x: width * 0.32, y: height * 0.70),
            control2: CGPoint(x: width * 0.62, y: height * 0.86)
          )
        }
        .stroke(amber.opacity(0.42), lineWidth: max(width * 0.018, 1))
      }
    }
    .frame(width: size.width, height: size.height)
  }
}

private struct WarmKitchenArtwork: View {
  let size: CGSize

  var body: some View {
    GeometryReader { proxy in
      let width = proxy.size.width
      let height = proxy.size.height
      let inset = width * 0.11
      let copper = Color(red: 0.93, green: 0.48, blue: 0.22)
      let ember = Color(red: 0.99, green: 0.68, blue: 0.31)
      let shadow = Color(red: 0.13, green: 0.08, blue: 0.06)

      ZStack {
        LinearGradient(
          colors: [
            Color(red: 0.87, green: 0.42, blue: 0.20),
            Color(red: 0.37, green: 0.16, blue: 0.12),
            SleepyTheme.ColorToken.midnight
          ],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        )

        Circle()
          .fill(ember.opacity(0.24))
          .frame(width: width * 0.72, height: width * 0.72)
          .offset(x: width * 0.34, y: -height * 0.28)

        RoundedRectangle(cornerRadius: width * 0.2, style: .continuous)
          .fill(shadow.opacity(0.38))
          .frame(width: width * 0.36, height: height * 0.52)
          .overlay {
            RoundedRectangle(cornerRadius: width * 0.2, style: .continuous)
              .stroke(SleepyTheme.ColorToken.parchment.opacity(0.16), lineWidth: max(width * 0.012, 1))
          }
          .offset(x: -width * 0.22, y: -height * 0.08)

        ForEach(0..<3, id: \.self) { index in
          Capsule()
            .fill(SleepyTheme.ColorToken.parchment.opacity(0.16))
            .frame(width: width * 0.58, height: max(width * 0.025, 2))
            .offset(x: width * 0.11, y: -height * 0.23 + CGFloat(index) * height * 0.13)
        }

        ForEach(0..<3, id: \.self) { index in
          Circle()
            .stroke(copper.opacity(0.82), lineWidth: max(width * 0.025, 2))
            .background(Circle().fill(shadow.opacity(0.32)))
            .frame(width: width * 0.18, height: width * 0.18)
            .offset(x: width * (0.03 + CGFloat(index) * 0.16), y: -height * 0.24)
        }

        RoundedRectangle(cornerRadius: width * 0.06, style: .continuous)
          .fill(shadow.opacity(0.55))
          .frame(width: width * 0.72, height: height * 0.18)
          .overlay(alignment: .top) {
            Capsule()
              .fill(copper.opacity(0.72))
              .frame(width: width * 0.6, height: max(width * 0.025, 2))
              .offset(y: -width * 0.012)
          }
          .offset(y: height * 0.26)

        Circle()
          .fill(copper.opacity(0.88))
          .frame(width: width * 0.23, height: width * 0.23)
          .overlay {
            Circle()
              .stroke(ember.opacity(0.62), lineWidth: max(width * 0.015, 1))
          }
          .offset(x: -width * 0.15, y: height * 0.16)

        Capsule()
          .fill(copper.opacity(0.84))
          .frame(width: width * 0.24, height: max(width * 0.035, 3))
          .rotationEffect(.degrees(-8))
          .offset(x: width * 0.04, y: height * 0.15)

        Path { path in
          path.move(to: CGPoint(x: inset, y: height - inset * 0.9))
          path.addCurve(
            to: CGPoint(x: width - inset, y: height - inset * 1.2),
            control1: CGPoint(x: width * 0.34, y: height - inset * 1.7),
            control2: CGPoint(x: width * 0.67, y: height - inset * 0.4)
          )
        }
        .stroke(ember.opacity(0.42), lineWidth: max(width * 0.015, 1))
      }
    }
    .frame(width: size.width, height: size.height)
  }
}

private struct LanternMakerArtwork: View {
  let size: CGSize

  var body: some View {
    GeometryReader { proxy in
      let width = proxy.size.width
      let height = proxy.size.height
      let brass = Color(red: 0.96, green: 0.62, blue: 0.28)
      let flame = Color(red: 1.0, green: 0.78, blue: 0.42)
      let shadow = Color(red: 0.10, green: 0.12, blue: 0.12)

      ZStack {
        LinearGradient(
          colors: [
            Color(red: 0.75, green: 0.39, blue: 0.18),
            Color(red: 0.28, green: 0.16, blue: 0.12),
            SleepyTheme.ColorToken.midnight
          ],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        )

        Circle()
          .fill(flame.opacity(0.26))
          .frame(width: width * 0.78, height: width * 0.78)
          .offset(x: width * 0.28, y: -height * 0.20)

        RoundedRectangle(cornerRadius: width * 0.22, style: .continuous)
          .stroke(brass.opacity(0.76), lineWidth: max(width * 0.025, 2))
          .frame(width: width * 0.43, height: height * 0.56)
          .background {
            RoundedRectangle(cornerRadius: width * 0.22, style: .continuous)
              .fill(shadow.opacity(0.48))
          }
          .offset(y: height * 0.08)

        Capsule()
          .fill(brass.opacity(0.82))
          .frame(width: width * 0.25, height: max(width * 0.035, 3))
          .offset(y: -height * 0.24)

        Path { path in
          path.move(to: CGPoint(x: width * 0.50, y: height * 0.20))
          path.addCurve(
            to: CGPoint(x: width * 0.50, y: height * 0.34),
            control1: CGPoint(x: width * 0.40, y: height * 0.24),
            control2: CGPoint(x: width * 0.60, y: height * 0.30)
          )
        }
        .stroke(brass.opacity(0.78), lineWidth: max(width * 0.018, 1.5))

        Circle()
          .fill(flame.opacity(0.42))
          .frame(width: width * 0.23, height: width * 0.23)
          .blur(radius: width * 0.025)
          .offset(y: height * 0.13)

        RoundedRectangle(cornerRadius: width * 0.04, style: .continuous)
          .fill(brass.opacity(0.60))
          .frame(width: width * 0.60, height: max(width * 0.03, 2))
          .offset(y: height * 0.36)

        ForEach(0..<3, id: \.self) { index in
          Capsule()
            .fill(SleepyTheme.ColorToken.parchment.opacity(0.12))
            .frame(width: width * 0.22, height: max(width * 0.018, 1))
            .rotationEffect(.degrees(-18))
            .offset(x: -width * 0.28, y: -height * 0.16 + CGFloat(index) * height * 0.09)
        }
      }
    }
    .frame(width: size.width, height: size.height)
  }
}

private struct CopperHearthArtwork: View {
  let size: CGSize
  let emberColor: Color

  var body: some View {
    GeometryReader { proxy in
      let width = proxy.size.width
      let height = proxy.size.height
      let copper = Color(red: 0.92, green: 0.47, blue: 0.22)
      let shadow = Color(red: 0.11, green: 0.08, blue: 0.07)

      ZStack {
        LinearGradient(
          colors: [
            Color(red: 0.84, green: 0.43, blue: 0.20),
            Color(red: 0.31, green: 0.15, blue: 0.12),
            SleepyTheme.ColorToken.midnight
          ],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        )

        Circle()
          .fill(emberColor.opacity(0.24))
          .frame(width: width * 0.78, height: width * 0.78)
          .offset(x: width * 0.30, y: -height * 0.27)

        RoundedRectangle(cornerRadius: width * 0.09, style: .continuous)
          .fill(shadow.opacity(0.58))
          .frame(width: width * 0.70, height: height * 0.25)
          .offset(y: height * 0.27)

        Ellipse()
          .fill(copper.opacity(0.90))
          .frame(width: width * 0.48, height: height * 0.24)
          .overlay {
            Ellipse()
              .stroke(emberColor.opacity(0.70), lineWidth: max(width * 0.018, 1.5))
          }
          .offset(y: height * 0.08)

        Capsule()
          .fill(copper.opacity(0.78))
          .frame(width: width * 0.55, height: max(width * 0.035, 3))
          .rotationEffect(.degrees(-7))
          .offset(y: height * 0.03)

        ForEach(0..<4, id: \.self) { index in
          RoundedRectangle(cornerRadius: width * 0.018, style: .continuous)
            .fill(SleepyTheme.ColorToken.parchment.opacity(0.16))
            .frame(width: width * 0.12, height: height * 0.36)
            .rotationEffect(.degrees(-18 + Double(index) * 9))
            .offset(x: -width * 0.24 + CGFloat(index) * width * 0.15, y: -height * 0.20)
        }

        Circle()
          .fill(emberColor.opacity(0.34))
          .frame(width: width * 0.16, height: width * 0.16)
          .blur(radius: width * 0.018)
          .offset(x: width * 0.20, y: height * 0.30)
      }
    }
    .frame(width: size.width, height: size.height)
  }
}

private struct GeneratedArtworkFallback: View {
  let title: String
  let category: String
  let size: CGSize

  private var palette: ArtworkPalette {
    ArtworkPalette()
  }

  var body: some View {
    ZStack(alignment: .bottomLeading) {
      LinearGradient(
        colors: [palette.top, palette.middle, palette.bottom],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )

      GeometryReader { proxy in
        let width = proxy.size.width
        let height = proxy.size.height
        let iconSide = max(width * 0.32, 28)
        let iconSize = max(min(width, height) * 0.22, 16)
        let iconPadding = max(width * 0.09, 8)
        let glowRadius = max(width * 0.05, 5)
        let shadowY = max(width * 0.025, 2)

        Circle()
          .fill(palette.glow.opacity(0.28))
          .frame(width: width * 0.62, height: width * 0.62)
          .offset(x: width * 0.58, y: -width * 0.24)

        Circle()
          .stroke(SleepyTheme.ColorToken.parchment.opacity(0.13), lineWidth: max(width * 0.018, 1))
          .frame(width: width * 0.82, height: width * 0.82)
          .offset(x: -width * 0.32, y: height * 0.34)

        Image(systemName: "book.closed.fill")
          .symbolRenderingMode(SleepyTheme.Icon.symbolRenderingMode)
          .font(.system(size: iconSize, weight: .semibold))
          .foregroundStyle(SleepyTheme.ColorToken.parchment.opacity(0.82))
          .frame(width: iconSide, height: iconSide, alignment: .leading)
          .shadow(color: palette.glow.opacity(0.36), radius: glowRadius, x: 0, y: shadowY)
          .padding(iconPadding)
          .frame(width: width, height: height, alignment: .bottomLeading)
      }
    }
  }
}

private struct ArtworkPalette {
  let top: Color
  let middle: Color
  let bottom: Color
  let glow: Color

  init() {
    top = Color(red: 0.94, green: 0.56, blue: 0.23)
    middle = Color(red: 0.45, green: 0.22, blue: 0.16)
    bottom = SleepyTheme.ColorToken.midnight
    glow = Color(red: 0.99, green: 0.74, blue: 0.36)
  }
}

private struct NowPlayingSheet: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.modelContext) private var modelContext

  let story: FixtureStory
  @ObservedObject var playbackService: PlaybackService
  @Binding var isBookmarked: Bool

  @AppStorage(PlaybackDefaults.speedKey) private var defaultSpeed = PlaybackDefaults.defaultSpeed
  @AppStorage(PlaybackDefaults.sleepTimerKey) private var defaultSleepTimer = PlaybackDefaults.defaultSleepTimer
  @State private var speed = "1x"
  @State private var sleepTimer = "30 min"
  @State private var playbackError: String?
  @State private var isPreparingPlayback = false
  @State private var scrubProgress: Double?
  @State private var storyDetailFocus: StoryDetailFocus?
  @State private var isDownloadedInSession = false
  @State private var playbackBookmarkStatus = "Save spot"
  @State private var refreshedPresentationStory: FixtureStory?

  private var displayStory: FixtureStory {
    (refreshedPresentationStory ?? story).applying(playbackState: playbackService.state)
  }

  var body: some View {
    ZStack {
      SleepyTheme.eveningGradient
        .ignoresSafeArea()

      ScrollView {
        VStack(spacing: SleepyTheme.Spacing.lg) {
          sheetHeader
          StoryArtwork(
            size: CGSize(width: 244, height: 244),
            systemName: displayStory.symbol,
            storyTitle: displayStory.title,
            category: displayStory.category,
            coverRemoteURLString: displayStory.coverRemoteURLString,
            coverLocalFileName: displayStory.coverLocalFileName
          )
            .accessibilityIdentifier("now-playing-artwork")
          storyText
          playbackProgress
          if let playbackError {
            Text(playbackError)
              .font(SleepyTheme.Typography.caption)
              .foregroundStyle(SleepyTheme.ColorToken.amber)
              .fixedSize(horizontal: false, vertical: true)
              .accessibilityIdentifier("now-playing-playback-error")
          }
          transportControls
          playerQuickActions
          playerTools
        }
        .padding(SleepyTheme.Spacing.lg)
        .frame(maxWidth: 560)
      }
      .scrollIndicators(.hidden)
    }
    .accessibilityIdentifier("now-playing-sheet")
    .task(id: story.id) {
      refreshedPresentationStory = nil
      speed = defaultSpeed
      sleepTimer = defaultSleepTimer
      isDownloadedInSession = story.isDownloaded
      playbackService.setPositionStore(SwiftDataPlaybackPositionStore(context: modelContext))
      playbackService.setBookmarkStore(SwiftDataPlaybackBookmarkStore(context: modelContext))
      if playbackService.state.storyID == story.id ||
        (story.id == FixtureStory.continueListening.id && playbackService.state.storyID == Self.fullLengthAcceptanceStoryID) {
        await preparePlaybackForDisplay()
      }
    }
    .sheet(item: $storyDetailFocus) { focus in
      NavigationStack {
        StoryDetailView(story: displayStory, initialFocus: focus)
      }
    }
  }

  private var sheetHeader: some View {
    ZStack {
      Text("Now Playing")
        .font(SleepyTheme.Typography.callout.weight(.semibold))
        .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
        .frame(maxWidth: .infinity, alignment: .center)

      HStack {
        Spacer()

        Button {
          dismiss()
        } label: {
          Image(systemName: "xmark")
            .font(.caption.weight(.bold))
            .foregroundStyle(SleepyTheme.ColorToken.parchment)
            .frame(width: 34, height: 34)
            .background {
              Circle()
                .fill(SleepyTheme.ColorToken.cardRaised.opacity(0.74))
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close now playing")
        .accessibilityIdentifier("now-playing-close")
      }
    }
  }

  private var storyText: some View {
    VStack(spacing: SleepyTheme.Spacing.xs) {
      Text(displayStory.title)
        .font(SleepyTheme.Typography.title)
        .foregroundStyle(SleepyTheme.ColorToken.parchment)
        .multilineTextAlignment(.center)
        .lineLimit(2)
        .minimumScaleFactor(0.78)
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)

      Text(displayStory.chapter)
        .font(SleepyTheme.Typography.callout)
        .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
        .multilineTextAlignment(.center)
        .lineLimit(2)
        .minimumScaleFactor(0.82)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("now-playing-story-text")
  }

  private var playbackProgress: some View {
    VStack(spacing: SleepyTheme.Spacing.xs) {
      Slider(
        value: Binding(
          get: { displayedProgress },
          set: { newValue in
            scrubProgress = min(max(newValue, 0), 1)
          }
        ),
        in: 0...1,
        onEditingChanged: { isEditing in
          if isEditing {
            scrubProgress = displayedProgress
          } else if let scrubProgress {
            commitSeek(toProgress: scrubProgress)
          }
        }
      )
        .tint(SleepyTheme.ColorToken.gold)
        .accessibilityLabel("Playback position")
        .accessibilityValue("\(Int(displayedProgress * 100)) percent")
        .accessibilityIdentifier("now-playing-progress-slider")

      HStack {
        Text(currentTimeLabel)
        Spacer()
        Text(remainingTimeLabel)
      }
      .font(SleepyTheme.Typography.label)
      .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
    }
  }

  private var transportControls: some View {
    HStack(spacing: SleepyTheme.Spacing.lg) {
      PlayerCircleButton(
        systemName: "gobackward.15",
        label: "Skip back 15 seconds",
        size: 46
      ) {
        runPlaybackTask {
          try await preparePlaybackIfNeeded()
          try playbackService.skipBackward()
        }
      }

      Button {
        togglePlayback()
      } label: {
        Image(systemName: isPlaying ? "pause.fill" : "play.fill")
          .font(.system(size: 26, weight: .bold))
          .foregroundStyle(SleepyTheme.ColorToken.ink)
          .frame(width: 66, height: 66)
          .background {
            Circle()
              .fill(SleepyTheme.ColorToken.gold)
              .shadow(color: SleepyTheme.Shadow.glowColor, radius: 18, x: 0, y: 10)
          }
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(isPlaying ? "Pause" : "Play")
      .accessibilityIdentifier("now-playing-play-pause")

      PlayerCircleButton(
        systemName: "goforward.15",
        label: "Skip forward 15 seconds",
        size: 46
      ) {
        runPlaybackTask {
          try await preparePlaybackIfNeeded()
          try playbackService.skipForward()
        }
      }
    }
    .accessibilityIdentifier("now-playing-transport-controls")
  }

  private var playerQuickActions: some View {
    LazyVGrid(
      columns: Array(repeating: GridItem(.flexible(), spacing: SleepyTheme.Spacing.sm), count: 3),
      spacing: SleepyTheme.Spacing.sm
    ) {
      Button {
        storyDetailFocus = .transcript
      } label: {
        PlayerActionButtonLabel(systemName: "text.alignleft", title: "Transcript")
          .accessibilityIdentifier("now-playing-transcript-action-label")
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("View transcript")
      .accessibilityIdentifier("now-playing-transcript-action")

      Button {
        storyDetailFocus = .sources
      } label: {
        PlayerActionButtonLabel(systemName: "link", title: "Sources")
          .accessibilityIdentifier("now-playing-sources-action-label")
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("View sources")
      .accessibilityIdentifier("now-playing-sources-action")

      Button {
        toggleDownload()
      } label: {
        PlayerActionButtonLabel(systemName: downloadActionSystemName, title: downloadActionTitle)
          .accessibilityIdentifier("now-playing-download-action-label")
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(isDownloadedInSession ? "Remove download" : "Download for offline listening")
      .accessibilityIdentifier("now-playing-download-action")
    }
  }

  private var playerTools: some View {
    LazyVGrid(
      columns: Array(repeating: GridItem(.flexible(), spacing: SleepyTheme.Spacing.sm), count: 2),
      spacing: SleepyTheme.Spacing.sm
    ) {
      Menu {
        ForEach(PlaybackDefaults.speedOptions, id: \.self) { value in
          Button(value) {
            speed = value
            setPlaybackSpeed(value)
          }
        }
      } label: {
        ToolTile(systemName: "speedometer", title: "Speed", value: speed)
      }
      .accessibilityIdentifier("now-playing-speed-menu")

      Menu {
        ForEach(PlaybackDefaults.sleepTimerOptions, id: \.self) { value in
          Button(value) {
            sleepTimer = value
            setSleepTimer(value)
          }
        }
      } label: {
        ToolTile(systemName: "timer", title: "Timer", value: sleepTimer)
      }
      .accessibilityIdentifier("now-playing-timer-menu")

      Button {
        createPlaybackBookmark()
      } label: {
        ToolTile(
          systemName: "bookmark.fill",
          title: "Bookmark",
          value: playbackBookmarkStatus
        )
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Add playback bookmark")
      .accessibilityIdentifier("now-playing-bookmark")

      Menu {
        Button("View transcript") {
          storyDetailFocus = .transcript
        }
        Button("Story details") {
          storyDetailFocus = .overview
        }
        if isDownloadedInSession {
          Button("Remove download", role: .destructive) {
            removeDownload()
          }
        } else {
          Button("Download") {
            downloadStory()
          }
        }
      } label: {
        ToolTile(systemName: "ellipsis.circle", title: "More", value: "Options")
      }
      .accessibilityIdentifier("now-playing-more-menu")
    }
  }

  private var isPlaying: Bool {
    playbackService.state.status == .playing
  }

  private var downloadActionTitle: String {
    isDownloadedInSession ? "Remove" : "Download"
  }

  private var downloadActionSystemName: String {
    isDownloadedInSession ? "trash" : "arrow.down.circle"
  }

  private var currentProgress: Double {
    playbackService.state.storyID == nil ? 0 : playbackService.state.progress
  }

  private var displayedProgress: Double {
    scrubProgress ?? currentProgress
  }

  private var currentTimeLabel: String {
    guard let displayedPositionSeconds else {
      return Self.timeLabel(for: 0)
    }

    return Self.timeLabel(for: displayedPositionSeconds)
  }

  private var remainingTimeLabel: String {
    guard let displayedPositionSeconds else {
      return "-\(Self.timeLabel(for: displayedDurationSeconds))"
    }

    let remaining = max(displayedDurationSeconds - displayedPositionSeconds, 0)
    return "-\(Self.timeLabel(for: remaining))"
  }

  private var displayedPositionSeconds: TimeInterval? {
    guard playbackService.state.storyID != nil else {
      return nil
    }

    if let scrubProgress {
      return displayedDurationSeconds * scrubProgress
    }

    return playbackService.state.positionSeconds
  }

  private var displayedDurationSeconds: TimeInterval {
    if playbackService.state.storyID != nil, playbackService.state.durationSeconds > 0 {
      return playbackService.state.durationSeconds
    }

    return TimeInterval(displayStory.durationMinutes * 60)
  }

  private func preparePlaybackForDisplay() async {
    guard !isPreparingPlayback else {
      return
    }

    isPreparingPlayback = true
    do {
      try await preparePlaybackIfNeeded()
      if let rate = PlaybackDefaults.playbackRate(for: speed) {
        try playbackService.setPlaybackRate(rate)
      }
      playbackError = nil
    } catch {
      playbackError = "Playback could not start: \(error.localizedDescription)"
    }
    isPreparingPlayback = false
  }

  private func togglePlayback() {
    runPlaybackTask {
      try await preparePlaybackIfNeeded()
      if playbackService.state.status == .playing {
        try playbackService.pause()
      } else {
        try playbackService.play()
      }
    }
  }

  private func preparePlaybackIfNeeded() async throws {
    if playbackService.state.storyID == story.id ||
      (story.id == FixtureStory.continueListening.id && playbackService.state.storyID == Self.fullLengthAcceptanceStoryID) {
      if refreshedPresentationStory == nil,
         let persistentStory = try fetchPersistentStory(id: story.id) {
        refreshedPresentationStory = FixtureStory(persistentStory: persistentStory)
      }
      return
    }

    if let persistentStory = try fetchPersistentStory(id: story.id) {
      let storyForPlayback = try await refreshedStoryForPlayback(persistentStory)
      let localAssetsDirectory = try await localAssetsDirectoryForPlayback(storyForPlayback)
      refreshedPresentationStory = FixtureStory(persistentStory: storyForPlayback)
      try playbackService.load(
        story: storyForPlayback,
        localAssetsDirectory: localAssetsDirectory
      )
      return
    }

    if story.id == FixtureStory.continueListening.id {
      let apiStory = try await SleepyHistoryAPIClient(
        apiBaseURL: AppConfiguration().apiBaseURL
      ).demoStory(id: Self.fullLengthAcceptanceStoryID)
      let persistentStory = try upsertPersistentStory(APIStoryPersistenceMapper.makePersistentStory(from: apiStory))
      let localAssetsDirectory = try await localAssetsDirectoryForPlayback(persistentStory)
      refreshedPresentationStory = FixtureStory(persistentStory: persistentStory)
      try playbackService.load(story: persistentStory, localAssetsDirectory: localAssetsDirectory)
      return
    }

    let localAssetsDirectory = try Self.localAssetsDirectory()
    let persistentStory = try upsertPersistentStory(FullMockMode.makePersistentStory(
      from: story,
      localAssetsDirectory: localAssetsDirectory
    ))
    let playbackAssetsDirectory = try await localAssetsDirectoryForPlayback(persistentStory)
    refreshedPresentationStory = FixtureStory(persistentStory: persistentStory)
    try playbackService.load(story: persistentStory, localAssetsDirectory: playbackAssetsDirectory ?? localAssetsDirectory)
  }

  private func refreshedStoryForPlayback(_ persistentStory: PersistentStory) async throws -> PersistentStory {
    if localAssetsDirectoryIfPresent(for: persistentStory) != nil {
      return persistentStory
    }

    if persistentStory.id == FixtureStory.hostedStoryID {
      let apiStory = try await SleepyHistoryAPIClient(
        apiBaseURL: AppConfiguration().apiBaseURL
      ).demoStory(id: Self.fullLengthAcceptanceStoryID)
      return try upsertPersistentStory(APIStoryPersistenceMapper.makePersistentStory(from: apiStory))
    }

    let apiStory = try await SleepyHistoryAPIClient(
      apiBaseURL: AppConfiguration().apiBaseURL
    ).story(id: persistentStory.id)
    return try upsertPersistentStory(APIStoryPersistenceMapper.makePersistentStory(from: apiStory))
  }

  private func localAssetsDirectoryIfPresent(for persistentStory: PersistentStory) -> URL? {
    guard let localFileName = persistentStory.assets.first(where: { $0.kind == "audio" })?.localFileName else {
      return nil
    }

    let candidateDirectories = [
      try? StoryDownloadService(context: modelContext).localAssetsDirectory,
      try? Self.localAssetsDirectory()
    ].compactMap { $0 }

    return candidateDirectories.first { directory in
      FileManager.default.fileExists(
        atPath: directory.appendingPathComponent(localFileName).path(percentEncoded: false)
      )
    }
  }

  private func localAssetsDirectoryForPlayback(_ persistentStory: PersistentStory) async throws -> URL? {
    if let localAssetsDirectory = localAssetsDirectoryIfPresent(for: persistentStory) {
      return localAssetsDirectory
    }

    guard shouldCacheAudioForPlayback(persistentStory) else {
      return nil
    }

    playbackError = "Preparing audio for stable background playback..."
    let service = try StoryDownloadService(context: modelContext)
    _ = try await service.downloadAudioForPlayback(story: persistentStory)
    return localAssetsDirectoryIfPresent(for: persistentStory) ?? service.localAssetsDirectory
  }

  private func shouldCacheAudioForPlayback(_ persistentStory: PersistentStory) -> Bool {
    guard let audioAsset = persistentStory.assets.first(where: { $0.kind.lowercased() == "audio" }) else {
      return false
    }

    return audioAsset.localFileName == nil && audioAsset.remoteURLString != nil
  }

  private func upsertPersistentStory(_ mappedStory: PersistentStory) throws -> PersistentStory {
    if let existingStory = try fetchPersistentStory(id: mappedStory.id) {
      let refreshedStory = try updatePersistentStory(
        existingStory,
        from: mappedStory,
        in: modelContext
      )
      if refreshedStory.state == nil,
         let existingState = try fetchPersistentStoryState(storyID: mappedStory.id) {
        refreshedStory.state = existingState
        existingState.story = refreshedStory
      }

      try modelContext.save()
      return refreshedStory
    }

    if let existingState = try fetchPersistentStoryState(storyID: mappedStory.id) {
      mappedStory.state = existingState
      existingState.story = mappedStory
    }

    modelContext.insert(mappedStory)
    try modelContext.save()
    return mappedStory
  }

  private func fetchPersistentStory(id: String) throws -> PersistentStory? {
    var descriptor = FetchDescriptor<PersistentStory>(
      predicate: #Predicate { $0.id == id }
    )
    descriptor.fetchLimit = 1

    return try modelContext.fetch(descriptor).first
  }

  private func fetchPersistentStoryState(storyID: String) throws -> PersistentStoryState? {
    var descriptor = FetchDescriptor<PersistentStoryState>(
      predicate: #Predicate { $0.storyID == storyID }
    )
    descriptor.fetchLimit = 1

    return try modelContext.fetch(descriptor).first
  }

  private func deletePersistentStory(id storyID: String) throws {
    guard let story = try fetchPersistentStory(id: storyID) else {
      return
    }

    modelContext.delete(story)
    try modelContext.save()
  }

  private func commitSeek(toProgress progress: Double) {
    runPlaybackTask {
      defer { scrubProgress = nil }
      try await preparePlaybackIfNeeded()
      let target = playbackService.state.durationSeconds * min(max(progress, 0), 1)
      try playbackService.seek(to: target)
    }
  }

  private func setPlaybackSpeed(_ value: String) {
    guard let rate = PlaybackDefaults.playbackRate(for: value) else {
      return
    }

    runPlaybackTask {
      try await preparePlaybackIfNeeded()
      try playbackService.setPlaybackRate(rate)
    }
  }

  private func setSleepTimer(_ value: String) {
    if value == "Off" {
      playbackService.cancelSleepTimer()
      return
    }

    guard let seconds = PlaybackDefaults.sleepTimerSeconds(for: value) else {
      return
    }

    runPlaybackTask {
      try await preparePlaybackIfNeeded()
      try playbackService.startSleepTimer(durationSeconds: seconds)
    }
  }

  private func toggleDownload() {
    if isDownloadedInSession {
      removeDownload()
    } else {
      downloadStory()
    }
  }

  private func createPlaybackBookmark() {
    guard !isPreparingPlayback else {
      return
    }

    isPreparingPlayback = true
    Task {
      do {
        try await preparePlaybackIfNeeded()
        let bookmark = try playbackService.createBookmark(note: "Saved from Now Playing")
        let label = Self.timeLabel(for: bookmark.positionSeconds)
        playbackBookmarkStatus = label
        isBookmarked = true
        playbackError = "Playback bookmark saved at \(label)."
      } catch {
        playbackError = "Bookmark could not be saved: \(error.localizedDescription)"
      }
      isPreparingPlayback = false
    }
  }

  private func downloadStory() {
    guard !isPreparingPlayback else {
      return
    }

    isPreparingPlayback = true
    Task {
      do {
        let persistentStory = try await persistentStoryForDownload()
        _ = try await StoryDownloadService(context: modelContext).download(story: persistentStory)
        isDownloadedInSession = true
        playbackError = "Download saved for offline listening."
      } catch StoryDownloadServiceError.noDownloadableAssets {
        playbackError = "This story does not have downloadable audio yet."
      } catch {
        playbackError = "Download could not be saved: \(error.localizedDescription)"
      }
      isPreparingPlayback = false
    }
  }

  private func persistentStoryForDownload() async throws -> PersistentStory {
    if let persistentStory = try fetchPersistentStory(id: story.id) {
      return try await refreshedStoryForPlayback(persistentStory)
    }

    if story.id == FixtureStory.continueListening.id {
      let apiStory = try await SleepyHistoryAPIClient(
        apiBaseURL: AppConfiguration().apiBaseURL
      ).demoStory(id: Self.fullLengthAcceptanceStoryID)
      return try upsertPersistentStory(APIStoryPersistenceMapper.makePersistentStory(from: apiStory))
    }

    let localAssetsDirectory = try Self.localAssetsDirectory()
    return try upsertPersistentStory(FullMockMode.makePersistentStory(
      from: story,
      localAssetsDirectory: localAssetsDirectory
    ))
  }

  private func removeDownload() {
    do {
      let storyID = story.id
      var descriptor = FetchDescriptor<PersistentStory>(
        predicate: #Predicate { $0.id == storyID }
      )
      descriptor.relationshipKeyPathsForPrefetching = [\.assets, \.state]

      guard let persistentStory = try modelContext.fetch(descriptor).first else {
        playbackError = "No downloaded file was found for this story."
        return
      }

      let service = try StoryDownloadService(context: modelContext)
      try service.deleteDownloads(for: persistentStory)
      isDownloadedInSession = false
      playbackError = "Download removed."
    } catch {
      playbackError = "Download could not be removed."
    }
  }

  private func runPlaybackTask(_ command: @escaping () async throws -> Void) {
    guard !isPreparingPlayback else {
      return
    }

    isPreparingPlayback = true
    Task {
      do {
        try await command()
        playbackError = nil
      } catch {
        playbackError = "Playback could not start: \(error.localizedDescription)"
      }
      isPreparingPlayback = false
    }
  }

  private static func localAssetsDirectory() throws -> URL {
    guard let baseURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      throw CocoaError(.fileNoSuchFile)
    }

    return baseURL.appendingPathComponent("MockModeAudio", isDirectory: true)
  }

  private static let fullLengthAcceptanceStoryID = "story_full_length_acceptance"

  private static func timeLabel(for seconds: TimeInterval) -> String {
    let totalSeconds = max(Int(seconds.rounded()), 0)
    let hours = totalSeconds / 3_600
    let minutes = (totalSeconds % 3_600) / 60
    let seconds = totalSeconds % 60

    if hours > 0 {
      return "\(hours):\(String(format: "%02d", minutes)):\(String(format: "%02d", seconds))"
    }

    return "\(minutes):\(String(format: "%02d", seconds))"
  }
}

private struct PlayerCircleButton: View {
  let systemName: String
  let label: String
  let size: CGFloat
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: systemName)
        .font(.system(size: 18, weight: .bold))
        .foregroundStyle(SleepyTheme.ColorToken.parchment)
        .frame(width: size, height: size)
        .background {
          Circle()
            .fill(SleepyTheme.ColorToken.cardRaised.opacity(0.82))
            .overlay {
              Circle()
                .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 1)
            }
        }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}

private struct PlayerActionButtonLabel: View {
  let systemName: String
  let title: String

  var body: some View {
    Label {
      Text(title)
        .lineLimit(1)
        .minimumScaleFactor(0.78)
    } icon: {
      Image(systemName: systemName)
        .symbolRenderingMode(SleepyTheme.Icon.symbolRenderingMode)
    }
    .font(SleepyTheme.Typography.caption.weight(.semibold))
    .foregroundStyle(SleepyTheme.ColorToken.parchment)
    .frame(maxWidth: .infinity, minHeight: 46)
    .background {
      Capsule()
        .fill(SleepyTheme.ColorToken.cardRaised.opacity(0.72))
        .overlay {
          Capsule()
            .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 1)
        }
    }
  }
}

private struct ToolTile: View {
  let systemName: String
  let title: String
  let value: String

  var body: some View {
    HStack(spacing: SleepyTheme.Spacing.sm) {
      SleepyIconBadge(systemName: systemName)

      VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
        Text(title)
          .font(SleepyTheme.Typography.label)
          .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
          .lineLimit(1)

        Text(value)
          .font(SleepyTheme.Typography.callout)
          .foregroundStyle(SleepyTheme.ColorToken.parchment)
          .lineLimit(1)
          .minimumScaleFactor(0.78)
      }

      Spacer(minLength: 0)
    }
    .padding(SleepyTheme.Spacing.sm)
    .frame(maxWidth: .infinity, minHeight: 66, alignment: .leading)
    .background {
      RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
        .fill(SleepyTheme.ColorToken.card.opacity(0.62))
        .overlay {
          RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
            .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 1)
        }
    }
  }
}

private struct StatTile: View {
  let value: String
  let label: String

  var body: some View {
    SleepyCard(padding: SleepyTheme.Spacing.sm) {
      VStack(spacing: SleepyTheme.Spacing.xxs) {
        Text(value)
          .font(SleepyTheme.Typography.title)
          .foregroundStyle(SleepyTheme.ColorToken.gold)

        Text(label)
          .font(SleepyTheme.Typography.label)
          .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
      }
      .frame(maxWidth: .infinity)
    }
  }
}

private struct ProfileLinkRow: View {
  let destination: ProfileDestination
  let detail: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(alignment: .center, spacing: SleepyTheme.Spacing.sm) {
        Image(systemName: destination.systemName)
          .symbolRenderingMode(SleepyTheme.Icon.symbolRenderingMode)
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(SleepyTheme.ColorToken.gold)
          .frame(width: 34, height: 34)
          .background {
            RoundedRectangle(cornerRadius: SleepyTheme.Radius.sm, style: .continuous)
              .fill(SleepyTheme.ColorToken.gold.opacity(0.12))
          }

          VStack(alignment: .leading, spacing: SleepyTheme.Spacing.xxs) {
            Text(destination.title)
              .lineLimit(1)
              .minimumScaleFactor(0.82)
            Text(detail)
              .font(SleepyTheme.Typography.label)
              .foregroundStyle(SleepyTheme.ColorToken.parchmentMuted)
              .lineLimit(1)
          }

        Spacer()

        Image(systemName: "chevron.right")
          .font(.caption.weight(.bold))
          .foregroundStyle(SleepyTheme.ColorToken.tertiaryText)
      }
      .font(SleepyTheme.Typography.callout)
      .foregroundStyle(SleepyTheme.ColorToken.parchment)
      .padding(SleepyTheme.Spacing.md)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(destination.accessibilityIdentifier)
  }
}

private struct SleepyPrimaryButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(SleepyTheme.Typography.callout.weight(.semibold))
      .foregroundStyle(SleepyTheme.ColorToken.ink)
      .background {
        RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
          .fill(SleepyTheme.ColorToken.gold.opacity(configuration.isPressed ? 0.82 : 1))
      }
  }
}

@MainActor
private func updatePersistentStory(
  _ existingStory: PersistentStory,
  from mappedStory: PersistentStory,
  in modelContext: ModelContext
) throws -> PersistentStory {
  existingStory.title = mappedStory.title
  existingStory.synopsis = mappedStory.synopsis
  existingStory.kind = mappedStory.kind
  existingStory.generationStatus = mappedStory.generationStatus
  existingStory.updatedAt = mappedStory.updatedAt
  existingStory.durationSeconds = mappedStory.durationSeconds

  let existingAssetsByID = Dictionary(uniqueKeysWithValues: existingStory.assets.map { ($0.id, $0) })
  var refreshedAssets: [PersistentAsset] = []
  var refreshedAssetIDs = Set<String>()

  for mappedAsset in mappedStory.assets {
    let asset = existingAssetsByID[mappedAsset.id] ?? mappedAsset
    asset.kind = mappedAsset.kind
    asset.remoteURLString = mappedAsset.remoteURLString
    asset.localFileName = asset.localFileName ?? mappedAsset.localFileName
    asset.mimeType = mappedAsset.mimeType
    asset.byteCount = mappedAsset.byteCount ?? asset.byteCount
    asset.createdAt = mappedAsset.createdAt
    asset.story = existingStory
    refreshedAssets.append(asset)
    refreshedAssetIDs.insert(asset.id)
  }

  for staleAsset in existingStory.assets where !refreshedAssetIDs.contains(staleAsset.id) {
    modelContext.delete(staleAsset)
  }

  existingStory.assets = refreshedAssets
  let existingChaptersByID = Dictionary(uniqueKeysWithValues: existingStory.chapters.map { ($0.id, $0) })
  var refreshedChapters: [PersistentChapter] = []
  var refreshedChapterIDs = Set<String>()

  for mappedChapter in mappedStory.chapters {
    let chapter = existingChaptersByID[mappedChapter.id] ?? mappedChapter
    chapter.index = mappedChapter.index
    chapter.title = mappedChapter.title
    chapter.summary = mappedChapter.summary
    chapter.estimatedDurationSeconds = mappedChapter.estimatedDurationSeconds
    chapter.transcript = mappedChapter.transcript
    chapter.sourceIDs = mappedChapter.sourceIDs
    chapter.story = existingStory
    refreshedChapters.append(chapter)
    refreshedChapterIDs.insert(chapter.id)
  }

  for staleChapter in existingStory.chapters where !refreshedChapterIDs.contains(staleChapter.id) {
    modelContext.delete(staleChapter)
  }

  existingStory.chapters = refreshedChapters

  let existingSourcesByID = Dictionary(uniqueKeysWithValues: existingStory.sources.map { ($0.id, $0) })
  var refreshedSources: [PersistentSource] = []
  var refreshedSourceIDs = Set<String>()

  for mappedSource in mappedStory.sources {
    let source = existingSourcesByID[mappedSource.id] ?? mappedSource
    source.title = mappedSource.title
    source.urlString = mappedSource.urlString
    source.publisher = mappedSource.publisher
    source.retrievedAt = mappedSource.retrievedAt
    source.notes = mappedSource.notes
    source.story = existingStory
    refreshedSources.append(source)
    refreshedSourceIDs.insert(source.id)
  }

  for staleSource in existingStory.sources where !refreshedSourceIDs.contains(staleSource.id) {
    modelContext.delete(staleSource)
  }

  existingStory.sources = refreshedSources
  return existingStory
}

private struct SleepySecondaryButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(SleepyTheme.Typography.callout.weight(.semibold))
      .foregroundStyle(SleepyTheme.ColorToken.parchment)
      .frame(maxWidth: .infinity, minHeight: 46)
      .background {
        RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
          .fill(SleepyTheme.ColorToken.card.opacity(configuration.isPressed ? 0.42 : 0.62))
          .overlay {
            RoundedRectangle(cornerRadius: SleepyTheme.Radius.md, style: .continuous)
              .stroke(SleepyTheme.ColorToken.stroke, lineWidth: 1)
          }
      }
  }
}

private struct SleepyCardButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    SleepyCard {
      configuration.label
        .opacity(configuration.isPressed ? 0.78 : 1)
    }
  }
}

#Preview {
  RootView()
    .modelContainer(try! PersistenceContainerFactory.makeInMemoryContainer())
}
