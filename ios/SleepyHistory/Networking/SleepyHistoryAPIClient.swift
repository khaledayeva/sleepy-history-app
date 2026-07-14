import Foundation

protocol SleepyHistoryAPITransport {
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

struct URLSessionSleepyHistoryAPITransport: SleepyHistoryAPITransport {
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw SleepyHistoryAPIClientError.invalidResponse
    }

    return (data, httpResponse)
  }
}

struct SleepyHistoryAPIClient: @unchecked Sendable {
  let apiBaseURL: URL
  let tokenStore: EnrollmentTokenStore
  let transport: SleepyHistoryAPITransport
  let jsonDecoder: JSONDecoder
  let jsonEncoder: JSONEncoder

  init(
    apiBaseURL: URL,
    tokenStore: EnrollmentTokenStore = KeychainTokenStore(),
    transport: SleepyHistoryAPITransport = URLSessionSleepyHistoryAPITransport(),
    jsonDecoder: JSONDecoder = JSONDecoder(),
    jsonEncoder: JSONEncoder = JSONEncoder()
  ) {
    self.apiBaseURL = apiBaseURL
    self.tokenStore = tokenStore
    self.transport = transport
    self.jsonDecoder = jsonDecoder
    self.jsonEncoder = jsonEncoder
  }

  func createGenerationJob(_ requestPayload: APIStoryGenerationRequest) async throws -> APICreateJobResponse {
    var request = try authenticatedRequest(pathComponents: ["generation-jobs"])
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try jsonEncoder.encode(APIStoryGenerationRequestEnvelope(request: requestPayload))

    return try await send(request, successStatusCodes: [202], as: APICreateJobResponse.self)
  }

  func generationJob(id: String) async throws -> APIGenerationJob {
    let request = try authenticatedRequest(pathComponents: ["generation-jobs", id])
    return try await sendSafeRequest(request, successStatusCodes: [200], as: APIGenerationJobEnvelope.self).job
  }

  func cancelGenerationJob(id: String) async throws -> APIGenerationJob {
    var request = try authenticatedRequest(pathComponents: ["generation-jobs", id, "cancel"])
    request.httpMethod = "POST"
    return try await send(request, successStatusCodes: [200], as: APIGenerationJobEnvelope.self).job
  }

  func retryGenerationJob(id: String) async throws -> APIGenerationJob {
    var request = try authenticatedRequest(pathComponents: ["generation-jobs", id, "retry"])
    request.httpMethod = "POST"
    return try await send(request, successStatusCodes: [200], as: APIGenerationJobEnvelope.self).job
  }

  func deleteGenerationJob(id: String) async throws -> APIDeleteGenerationJobResponse {
    var request = try authenticatedRequest(pathComponents: ["generation-jobs", id])
    request.httpMethod = "DELETE"
    return try await send(request, successStatusCodes: [200], as: APIDeleteGenerationJobResponse.self)
  }

  func story(id: String) async throws -> APIStory {
    let request = try authenticatedRequest(pathComponents: ["stories", id])
    return try await sendSafeRequest(request, successStatusCodes: [200], as: APIStoryEnvelope.self).story
  }

  func demoStory(id: String) async throws -> APIStory {
    let url = ["demo-stories", id].reduce(apiBaseURL) { partialURL, component in
      partialURL.appendingPathComponent(component)
    }
    let request = URLRequest(url: url)
    return try await sendSafeRequest(request, successStatusCodes: [200], as: APIStoryEnvelope.self).story
  }

  private func authenticatedRequest(pathComponents: [String]) throws -> URLRequest {
    guard let token = try tokenStore.readToken() else {
      throw SleepyHistoryAPIClientError.missingEnrollmentToken
    }

    let url = pathComponents.reduce(apiBaseURL) { partialURL, component in
      partialURL.appendingPathComponent(component)
    }
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    return request
  }

  private func send<ResponseBody: Decodable>(
    _ request: URLRequest,
    successStatusCodes: Set<Int>,
    as type: ResponseBody.Type
  ) async throws -> ResponseBody {
    let (data, response) = try await transport.data(for: request)
    if successStatusCodes.contains(response.statusCode) {
      return try jsonDecoder.decode(type, from: data)
    }

    if let apiError = try? jsonDecoder.decode(APIErrorEnvelope.self, from: data).error {
      throw SleepyHistoryAPIClientError.api(apiError, statusCode: response.statusCode)
    }

    throw SleepyHistoryAPIClientError.serverRejected(statusCode: response.statusCode)
  }

  private func sendSafeRequest<ResponseBody: Decodable>(
    _ request: URLRequest,
    successStatusCodes: Set<Int>,
    as type: ResponseBody.Type,
    maxAttempts: Int = 2
  ) async throws -> ResponseBody {
    var lastError: Error?

    for attempt in 1...max(1, maxAttempts) {
      do {
        return try await send(request, successStatusCodes: successStatusCodes, as: type)
      } catch {
        lastError = error
        guard attempt < maxAttempts, shouldRetrySafeRequest(after: error) else {
          throw error
        }
      }
    }

    throw lastError ?? SleepyHistoryAPIClientError.invalidResponse
  }

  private func shouldRetrySafeRequest(after error: Error) -> Bool {
    if let clientError = error as? SleepyHistoryAPIClientError {
      switch clientError {
      case .api(_, let statusCode), .serverRejected(let statusCode):
        return (500...599).contains(statusCode)
      case .missingEnrollmentToken, .invalidResponse:
        return false
      }
    }

    return error is URLError
  }
}

enum SleepyHistoryAPIClientError: Error, Equatable {
  case missingEnrollmentToken
  case invalidResponse
  case serverRejected(statusCode: Int)
  case api(APIError, statusCode: Int)
}

struct APIStoryGenerationRequestEnvelope: Codable, Equatable {
  let request: APIStoryGenerationRequest
}

struct APIStoryGenerationRequest: Codable, Equatable {
  let schemaVersion: String
  let kind: String
  let subject: String
  let targetDurationMinutes: Int
  let era: String?
  let location: String?
  let perspective: String?
  let voiceId: String?
  let ambience: String?
  let safety: APISafetySettings

  init(
    kind: String,
    subject: String,
    targetDurationMinutes: Int,
    era: String? = nil,
    location: String? = nil,
    perspective: String? = nil,
    voiceId: String? = nil,
    ambience: String? = "rain",
    safety: APISafetySettings = APISafetySettings()
  ) {
    self.schemaVersion = "2026-05-10"
    self.kind = kind
    self.subject = subject
    self.targetDurationMinutes = targetDurationMinutes
    self.era = era
    self.location = location
    self.perspective = perspective
    self.voiceId = voiceId
    self.ambience = ambience
    self.safety = safety
  }
}

struct APISafetySettings: Codable, Equatable {
  let bedtimeTone: String
  let allowHistoricalViolenceContext: Bool

  init(
    bedtimeTone: String = "very_gentle",
    allowHistoricalViolenceContext: Bool = false
  ) {
    self.bedtimeTone = bedtimeTone
    self.allowHistoricalViolenceContext = allowHistoricalViolenceContext
  }
}

struct APICreateJobResponse: Decodable, Equatable {
  let job: APICreatedJob
}

struct APICreatedJob: Decodable, Equatable {
  let id: String
  let status: String
  let generationStatus: String
  let progress: APIJobProgress
  let estimate: APICostEstimate
}

struct APICostEstimate: Codable, Equatable {
  let totalUsd: Double
}

struct APIGenerationJobEnvelope: Decodable, Equatable {
  let job: APIGenerationJob
}

struct APIGenerationJob: Codable, Equatable {
  let id: String
  let status: String
  let request: APIStoryGenerationRequest
  let progress: APIJobProgress
  let createdAt: String
  let updatedAt: String
  let storyId: String?
  let error: APIError?
}

struct APIDeleteGenerationJobResponse: Decodable, Equatable {
  let deleted: Bool
  let jobId: String
  let deletedRemoteAssetKeys: [String]?
}

struct APIJobProgress: Codable, Equatable {
  let stage: String
  let percent: Int
  let message: String?
}

struct APIStoryEnvelope: Decodable, Equatable {
  let story: APIStory
}

struct APIStory: Codable, Equatable {
  let id: String
  let title: String
  let subtitle: String?
  let kind: String
  let subject: String
  let synopsis: String
  let targetDurationMinutes: Int
  let estimatedDurationSeconds: Int
  let createdAt: String
  let chapters: [APIChapter]
  let sources: [APISource]
  let assets: [APIAsset]
}

struct APIChapter: Codable, Equatable {
  let id: String
  let index: Int
  let title: String
  let summary: String
  let estimatedDurationSeconds: Int
  let transcript: String
  let sourceIds: [String]
}

struct APISource: Codable, Equatable {
  let id: String
  let title: String
  let url: URL?
  let publisher: String?
  let retrievedAt: String?
  let notes: String?
}

struct APIAsset: Codable, Equatable {
  let id: String
  let kind: String
  let mimeType: String
  let uri: URL
  let sizeBytes: Int?
  let width: Int?
  let height: Int?
  let durationSeconds: Int?
  let checksum: String?
}

struct APIErrorEnvelope: Decodable, Equatable {
  let error: APIError
}

struct APIError: Codable, Equatable {
  let code: String
  let message: String
  let retryable: Bool
  let details: [String: APIDetailValue]?

  var isBudgetLimit: Bool {
    ["daily_budget_exceeded", "job_budget_exceeded", "retry_budget_exceeded"].contains(code)
  }

  var userFacingGenerationMessage: String {
    switch code {
    case "daily_budget_exceeded":
      if let estimate = detailNumber("estimatedCostUsd"),
         let current = detailNumber("currentDailyCostUsd"),
         let cap = detailNumber("maxDailyCostUsd") {
        return "Daily generation budget reached. Today's reserved estimate is $\(Self.currency(current)) of $\(Self.currency(cap)); this story is estimated at $\(Self.currency(estimate)). Wait for the daily reset or raise MAX_DAILY_COST_USD in Railway."
      }
      return "Daily generation budget reached. Wait for the daily reset or raise MAX_DAILY_COST_USD in Railway."

    case "job_budget_exceeded":
      if let estimate = detailNumber("estimatedCostUsd"),
         let cap = detailNumber("maxJobCostUsd") {
        return "This story is estimated at $\(Self.currency(estimate)), above the per-story cap of $\(Self.currency(cap)). Shorten the duration or raise MAX_JOB_COST_USD in Railway."
      }
      return "This story is above the configured per-story budget cap. Shorten the duration or raise MAX_JOB_COST_USD in Railway."

    case "retry_budget_exceeded":
      if let exposure = detailNumber("retryExposureUsd"),
         let cap = detailNumber("maxRetryCostUsd") {
        return "Retry budget limit reached. Retry exposure is $\(Self.currency(exposure)) against the $\(Self.currency(cap)) cap. Delete this attempt, shorten the story, or raise MAX_RETRY_COST_USD in Railway."
      }
      return "Retry budget limit reached. Delete this attempt, shorten the story, or raise MAX_RETRY_COST_USD in Railway."

    case "provider_quota_exceeded":
      let provider = detailString("provider") ?? "The writing provider"
      if provider.localizedCaseInsensitiveContains("anthropic") || provider.localizedCaseInsensitiveContains("claude") {
        return "Anthropic credits are depleted. Refill credits in the Anthropic console, then retry this story."
      }
      return "\(provider) credits are depleted or billing is unavailable. Refill the provider account, then retry this story."

    default:
      return message
    }
  }

  private func detailNumber(_ key: String) -> Double? {
    guard let value = details?[key] else {
      return nil
    }

    switch value {
    case .number(let number):
      return number
    case .string(let string):
      return Double(string)
    case .bool, .null:
      return nil
    }
  }

  private func detailString(_ key: String) -> String? {
    guard let value = details?[key] else {
      return nil
    }

    switch value {
    case .string(let string):
      return string
    case .number(let number):
      return String(number)
    case .bool(let bool):
      return String(bool)
    case .null:
      return nil
    }
  }

  private static func currency(_ value: Double) -> String {
    String(format: "%.2f", value)
  }
}

enum APIDetailValue: Codable, Equatable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else {
      self = .string(try container.decode(String.self))
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value):
      try container.encode(value)
    case .number(let value):
      try container.encode(value)
    case .bool(let value):
      try container.encode(value)
    case .null:
      try container.encodeNil()
    }
  }
}

enum APIStoryPersistenceMapper {
  static func makePersistentStory(
    from apiStory: APIStory,
    now: Date = Date()
  ) -> PersistentStory {
    let createdAt = iso8601Date(from: apiStory.createdAt) ?? now
    let story = PersistentStory(
      id: apiStory.id,
      title: apiStory.title,
      synopsis: apiStory.synopsis,
      kind: apiStory.kind,
      generationStatus: "completed",
      createdAt: createdAt,
      updatedAt: now,
      durationSeconds: TimeInterval(apiStory.estimatedDurationSeconds)
    )

    story.assets = apiStory.assets.map { asset in
      PersistentAsset(
        id: asset.id,
        kind: asset.kind,
        remoteURLString: asset.uri.absoluteString,
        mimeType: asset.mimeType,
        byteCount: asset.sizeBytes.map(Int64.init),
        createdAt: createdAt,
        story: story
      )
    }
    story.chapters = apiStory.chapters.map { chapter in
      PersistentChapter(
        id: chapter.id,
        index: chapter.index,
        title: chapter.title,
        summary: chapter.summary,
        estimatedDurationSeconds: TimeInterval(chapter.estimatedDurationSeconds),
        transcript: chapter.transcript,
        sourceIDs: chapter.sourceIds,
        story: story
      )
    }
    story.sources = apiStory.sources.map { source in
      PersistentSource(
        id: source.id,
        title: source.title,
        urlString: source.url?.absoluteString,
        publisher: source.publisher,
        retrievedAt: source.retrievedAt,
        notes: source.notes,
        story: story
      )
    }
    story.state = PersistentStoryState(
      storyID: apiStory.id,
      isDownloaded: false,
      playbackDurationSeconds: TimeInterval(apiStory.estimatedDurationSeconds),
      updatedAt: now,
      story: story
    )

    return story
  }

  private static func iso8601Date(from value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) {
      return date
    }

    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
  }
}
