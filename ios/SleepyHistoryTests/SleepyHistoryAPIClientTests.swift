import XCTest
@testable import SleepyHistory

final class SleepyHistoryAPIClientTests: XCTestCase {
  func testCreateGenerationJobSendsBearerTokenAndDecodesProgress() async throws {
    let testToken = "odt_12345"
    let store = InMemoryAPIClientTokenStore()
    try store.saveToken(testToken)
    let transport = RecordingAPITransport(statusCode: 202, response: """
    {
      "job": {
        "id": "job_123",
        "status": "accepted",
        "generationStatus": "queued",
        "progress": { "stage": "queued", "percent": 0, "message": "Queued" },
        "estimate": { "totalUsd": 8.75 }
      }
    }
    """)
    let client = SleepyHistoryAPIClient(
      apiBaseURL: URL(string: "http://127.0.0.1:8787")!,
      tokenStore: store,
      transport: transport
    )

    let response = try await client.createGenerationJob(APIStoryGenerationRequest(
      kind: "daily_life",
      subject: "a lantern maker",
      targetDurationMinutes: 60,
      era: "late 16th century",
      location: "Istanbul",
      perspective: "ordinary craftsperson",
      voiceId: "calm_narrator_01"
    ))

    XCTAssertEqual(response.job.id, "job_123")
    XCTAssertEqual(response.job.progress.stage, "queued")
    XCTAssertEqual(response.job.estimate.totalUsd, 8.75)
    XCTAssertEqual(transport.requests.first?.url?.path, "/generation-jobs")
    XCTAssertEqual(transport.requests.first?.httpMethod, "POST")
    XCTAssertEqual(transport.requests.first?.value(forHTTPHeaderField: "authorization"), "Bearer \(testToken)")

    let body = try JSONDecoder().decode(
      APIStoryGenerationRequestEnvelope.self,
      from: try XCTUnwrap(transport.requests.first?.httpBody)
    )
    XCTAssertEqual(body.request.subject, "a lantern maker")
    XCTAssertEqual(body.request.safety.bedtimeTone, "very_gentle")
  }

  func testPollCancelRetryDeleteAndFetchStoryUseTypedResponses() async throws {
    let store = InMemoryAPIClientTokenStore()
    try store.saveToken("odt_12345")
    let transport = RecordingAPITransport(responses: [
      #"{"job":{"id":"job_123","status":"writing","request":{"schemaVersion":"2026-05-10","kind":"daily_life","subject":"a scribe","targetDurationMinutes":60,"safety":{"bedtimeTone":"very_gentle","allowHistoricalViolenceContext":false}},"progress":{"stage":"writing","percent":45,"message":"Writing"},"createdAt":"2026-05-10T16:00:00Z","updatedAt":"2026-05-10T16:01:00Z","storyId":null}}"#,
      #"{"job":{"id":"job_123","status":"canceled","request":{"schemaVersion":"2026-05-10","kind":"daily_life","subject":"a scribe","targetDurationMinutes":60,"safety":{"bedtimeTone":"very_gentle","allowHistoricalViolenceContext":false}},"progress":{"stage":"canceled","percent":100,"message":"Canceled by owner"},"createdAt":"2026-05-10T16:00:00Z","updatedAt":"2026-05-10T16:02:00Z","storyId":null}}"#,
      #"{"job":{"id":"job_123","status":"queued","request":{"schemaVersion":"2026-05-10","kind":"daily_life","subject":"a scribe","targetDurationMinutes":60,"safety":{"bedtimeTone":"very_gentle","allowHistoricalViolenceContext":false}},"progress":{"stage":"queued","percent":0,"message":"Queued for retry"},"createdAt":"2026-05-10T16:00:00Z","updatedAt":"2026-05-10T16:03:00Z","storyId":null}}"#,
      #"{"deleted":true,"jobId":"job_123","deletedRemoteAssetKeys":["stories/story_123/audio.wav"]}"#,
      #"{"story":{"id":"story_123","title":"The Scribe's Quiet Desk","kind":"daily_life","subject":"a scribe","synopsis":"A calm fixture story.","targetDurationMinutes":60,"estimatedDurationSeconds":3600,"createdAt":"2026-05-10T16:00:00Z","chapters":[],"sources":[],"assets":[]}}"#
    ])
    let client = SleepyHistoryAPIClient(
      apiBaseURL: URL(string: "http://127.0.0.1:8787")!,
      tokenStore: store,
      transport: transport
    )

    let job = try await client.generationJob(id: "job_123")
    let canceled = try await client.cancelGenerationJob(id: "job_123")
    let retried = try await client.retryGenerationJob(id: "job_123")
    let deleted = try await client.deleteGenerationJob(id: "job_123")
    let story = try await client.story(id: "story_123")

    XCTAssertEqual(job.progress.percent, 45)
    XCTAssertEqual(canceled.status, "canceled")
    XCTAssertEqual(retried.status, "queued")
    XCTAssertEqual(deleted, APIDeleteGenerationJobResponse(deleted: true, jobId: "job_123", deletedRemoteAssetKeys: ["stories/story_123/audio.wav"]))
    XCTAssertEqual(story.title, "The Scribe's Quiet Desk")
    XCTAssertEqual(transport.requests.map { $0.url?.path }, [
      "/generation-jobs/job_123",
      "/generation-jobs/job_123/cancel",
      "/generation-jobs/job_123/retry",
      "/generation-jobs/job_123",
      "/stories/story_123"
    ])
    XCTAssertEqual(transport.requests.map { $0.httpMethod }, ["GET", "POST", "POST", "DELETE", "GET"])
  }

  func testDemoStoryFetchDoesNotRequireEnrollmentToken() async throws {
    let transport = RecordingAPITransport(response: #"{"story":{"id":"story_full_length_acceptance","title":"The Library at Alexandria","kind":"daily_life","subject":"a scribe closing the Library at Alexandria","synopsis":"A calm generated story.","targetDurationMinutes":60,"estimatedDurationSeconds":3548,"createdAt":"2026-05-14T23:27:30Z","chapters":[],"sources":[],"assets":[{"id":"asset_audio","kind":"audio","mimeType":"audio/wav","uri":"https://media.example.com/audio.wav","sizeBytes":113545248,"durationSeconds":3548}]}}"#)
    let client = SleepyHistoryAPIClient(
      apiBaseURL: URL(string: "http://127.0.0.1:8787")!,
      tokenStore: InMemoryAPIClientTokenStore(),
      transport: transport
    )

    let story = try await client.demoStory(id: "story_full_length_acceptance")

    XCTAssertEqual(story.id, "story_full_length_acceptance")
    XCTAssertEqual(story.assets.first?.uri.absoluteString, "https://media.example.com/audio.wav")
    XCTAssertEqual(transport.requests.first?.url?.path, "/demo-stories/story_full_length_acceptance")
    XCTAssertNil(transport.requests.first?.value(forHTTPHeaderField: "authorization"))
  }

  func testAPIStoryPersistenceMapperCreatesRemotePlayablePersistentStory() throws {
    let apiStory = APIStory(
      id: "story_full_length_acceptance",
      title: "The Library at Alexandria",
      subtitle: nil,
      kind: "daily_life",
      subject: "a scribe closing the Library at Alexandria",
      synopsis: "A calm generated story.",
      targetDurationMinutes: 60,
      estimatedDurationSeconds: 3548,
      createdAt: "2026-05-14T23:27:30.000Z",
      chapters: [
        APIChapter(
          id: "chapter_01",
          index: 1,
          title: "The Scribes Close Their Inkwells",
          summary: "The desks grow quiet.",
          estimatedDurationSeconds: 420,
          transcript: "The reed pens are washed and set beside the ink.",
          sourceIds: ["source_01"]
        )
      ],
      sources: [
        APISource(
          id: "source_01",
          title: "Alexandrian Library Practices",
          url: URL(string: "https://example.com/sources/alexandria"),
          publisher: "Sleepy History Fixtures",
          retrievedAt: "2026-05-10T15:00:00Z",
          notes: "Fixture source notes."
        )
      ],
      assets: [
        APIAsset(
          id: "asset_audio",
          kind: "audio",
          mimeType: "audio/wav",
          uri: URL(string: "https://media.example.com/audio.wav")!,
          sizeBytes: 113545248,
          width: nil,
          height: nil,
          durationSeconds: 3548,
          checksum: nil
        ),
        APIAsset(
          id: "asset_cover",
          kind: "cover_thumbnail",
          mimeType: "image/png",
          uri: URL(string: "https://media.example.com/cover.png")!,
          sizeBytes: 240000,
          width: 512,
          height: 512,
          durationSeconds: nil,
          checksum: "sha256:cover"
        )
      ]
    )

    let story = APIStoryPersistenceMapper.makePersistentStory(from: apiStory)

    XCTAssertEqual(story.id, "story_full_length_acceptance")
    XCTAssertEqual(story.durationSeconds, 3548)
    XCTAssertEqual(story.assets.first?.remoteURLString, "https://media.example.com/audio.wav")
    XCTAssertEqual(story.assets.first { $0.kind == "cover_thumbnail" }?.remoteURLString, "https://media.example.com/cover.png")
    XCTAssertEqual(story.chapters.first?.title, "The Scribes Close Their Inkwells")
    XCTAssertEqual(story.chapters.first?.transcript, "The reed pens are washed and set beside the ink.")
    XCTAssertEqual(story.chapters.first?.sourceIDs, ["source_01"])
    XCTAssertEqual(story.sources.first?.title, "Alexandrian Library Practices")
    XCTAssertEqual(story.sources.first?.urlString, "https://example.com/sources/alexandria")
    XCTAssertEqual(story.sources.first?.publisher, "Sleepy History Fixtures")
    XCTAssertEqual(story.state?.isDownloaded, false)
  }

  func testSafeGetRequestsRetryTransientFailuresWithoutRetryingPosts() async throws {
    let store = InMemoryAPIClientTokenStore()
    try store.saveToken("odt_12345")

    let pollTransport = RecordingAPITransport(responses: [
      .http(statusCode: 503, body: #"{"error":{"code":"temporarily_unavailable","message":"Please try again.","retryable":true}}"#),
      .http(statusCode: 200, body: #"{"job":{"id":"job_123","status":"writing","request":{"schemaVersion":"2026-05-10","kind":"daily_life","subject":"a scribe","targetDurationMinutes":60,"safety":{"bedtimeTone":"very_gentle","allowHistoricalViolenceContext":false}},"progress":{"stage":"writing","percent":45,"message":"Writing"},"createdAt":"2026-05-10T16:00:00Z","updatedAt":"2026-05-10T16:01:00Z","storyId":null}}"#)
    ])
    let retryingClient = SleepyHistoryAPIClient(
      apiBaseURL: URL(string: "http://127.0.0.1:8787")!,
      tokenStore: store,
      transport: pollTransport
    )

    let retriedJob = try await retryingClient.generationJob(id: "job_123")

    XCTAssertEqual(retriedJob.progress.percent, 45)
    XCTAssertEqual(pollTransport.requests.count, 2)

    let createTransport = RecordingAPITransport(responses: [
      .http(statusCode: 503, body: #"{"error":{"code":"temporarily_unavailable","message":"Please try again.","retryable":true}}"#),
      .http(statusCode: 202, body: #"{"job":{"id":"job_retry","status":"accepted","generationStatus":"queued","progress":{"stage":"queued","percent":0,"message":"Queued"},"estimate":{"totalUsd":8.75}}}"#)
    ])
    let nonRetryingClient = SleepyHistoryAPIClient(
      apiBaseURL: URL(string: "http://127.0.0.1:8787")!,
      tokenStore: store,
      transport: createTransport
    )

    do {
      _ = try await nonRetryingClient.createGenerationJob(APIStoryGenerationRequest(
        kind: "daily_life",
        subject: "a scribe",
        targetDurationMinutes: 60
      ))
      XCTFail("Expected non-idempotent create request to surface the first failure")
    } catch let error as SleepyHistoryAPIClientError {
      guard case .api(let apiError, let statusCode) = error else {
        XCTFail("Expected typed API error")
        return
      }
      XCTAssertEqual(statusCode, 503)
      XCTAssertEqual(apiError.code, "temporarily_unavailable")
    }

    XCTAssertEqual(createTransport.requests.count, 1)
  }

  func testSafeGetRequestsRetryTransientTransportErrors() async throws {
    let store = InMemoryAPIClientTokenStore()
    try store.saveToken("odt_12345")
    let transport = RecordingAPITransport(responses: [
      .failure(URLError(.networkConnectionLost)),
      .http(statusCode: 200, body: #"{"story":{"id":"story_123","title":"The Scribe's Quiet Desk","kind":"daily_life","subject":"a scribe","synopsis":"A calm fixture story.","targetDurationMinutes":60,"estimatedDurationSeconds":3600,"createdAt":"2026-05-10T16:00:00Z","chapters":[],"sources":[],"assets":[]}}"#)
    ])
    let client = SleepyHistoryAPIClient(
      apiBaseURL: URL(string: "http://127.0.0.1:8787")!,
      tokenStore: store,
      transport: transport
    )

    let story = try await client.story(id: "story_123")

    XCTAssertEqual(story.id, "story_123")
    XCTAssertEqual(transport.requests.count, 2)
  }

  func testFetchStoryDecodesChaptersSourcesAndAssets() async throws {
    let store = InMemoryAPIClientTokenStore()
    try store.saveToken("odt_12345")
    let transport = RecordingAPITransport(response: """
    {
      "story": {
        "id": "story_nested",
        "title": "The Scribe's Quiet Desk",
        "subtitle": "Ink, papyrus, and lamplight",
        "kind": "daily_life",
        "subject": "a scribe",
        "synopsis": "A calm fixture story.",
        "targetDurationMinutes": 60,
        "estimatedDurationSeconds": 3600,
        "createdAt": "2026-05-10T16:00:00Z",
        "chapters": [
          {
            "id": "chapter_01",
            "index": 1,
            "title": "The Reed Pen Rests",
            "summary": "A quiet desk is prepared.",
            "estimatedDurationSeconds": 420,
            "transcript": "The lamp is low and the ink is still.",
            "sourceIds": ["source_01"]
          }
        ],
        "sources": [
          {
            "id": "source_01",
            "title": "Alexandrian Library Practices",
            "url": "https://example.com/sources/alexandria",
            "publisher": "Sleepy History Fixtures",
            "retrievedAt": "2026-05-10T15:00:00Z",
            "notes": "Fixture source notes."
          }
        ],
        "assets": [
          {
            "id": "asset_audio",
            "kind": "audio",
            "mimeType": "audio/wav",
            "uri": "https://media.example.com/stories/story_nested/audio.wav",
            "sizeBytes": 48000000,
            "durationSeconds": 3600,
            "checksum": "sha256:audio"
          },
          {
            "id": "asset_cover",
            "kind": "cover_full",
            "mimeType": "image/png",
            "uri": "https://media.example.com/stories/story_nested/cover.png",
            "sizeBytes": 240000,
            "width": 1536,
            "height": 1536,
            "checksum": "sha256:cover"
          }
        ]
      }
    }
    """)
    let client = SleepyHistoryAPIClient(
      apiBaseURL: URL(string: "http://127.0.0.1:8787")!,
      tokenStore: store,
      transport: transport
    )

    let story = try await client.story(id: "story_nested")

    XCTAssertEqual(story.chapters.first?.title, "The Reed Pen Rests")
    XCTAssertEqual(story.chapters.first?.sourceIds, ["source_01"])
    XCTAssertEqual(story.sources.first?.url?.absoluteString, "https://example.com/sources/alexandria")
    XCTAssertEqual(story.sources.first?.publisher, "Sleepy History Fixtures")
    XCTAssertEqual(story.sources.first?.retrievedAt, "2026-05-10T15:00:00Z")
    XCTAssertEqual(story.assets.first { $0.kind == "audio" }?.durationSeconds, 3600)
    XCTAssertEqual(story.assets.first { $0.kind == "cover_full" }?.width, 1536)
    XCTAssertEqual(story.assets.first { $0.kind == "cover_full" }?.checksum, "sha256:cover")
  }

  func testMissingTokenAndTypedApiErrorsAreSurfaced() async throws {
    let missingTokenClient = SleepyHistoryAPIClient(
      apiBaseURL: URL(string: "http://127.0.0.1:8787")!,
      tokenStore: InMemoryAPIClientTokenStore(),
      transport: RecordingAPITransport(response: "{}")
    )

    do {
      _ = try await missingTokenClient.generationJob(id: "job_123")
      XCTFail("Expected missing token error")
    } catch {
      XCTAssertEqual(error as? SleepyHistoryAPIClientError, .missingEnrollmentToken)
    }

    let store = InMemoryAPIClientTokenStore()
    try store.saveToken("odt_12345")
    let rejectedClient = SleepyHistoryAPIClient(
      apiBaseURL: URL(string: "http://127.0.0.1:8787")!,
      tokenStore: store,
      transport: RecordingAPITransport(
        statusCode: 404,
        response: #"{"error":{"code":"job_not_found","message":"Generation job was not found.","retryable":false}}"#
      )
    )

    do {
      _ = try await rejectedClient.generationJob(id: "job_missing")
      XCTFail("Expected API error")
    } catch let error as SleepyHistoryAPIClientError {
      guard case .api(let apiError, let statusCode) = error else {
        XCTFail("Expected typed API error")
        return
      }
      XCTAssertEqual(statusCode, 404)
      XCTAssertEqual(apiError.code, "job_not_found")
      XCTAssertFalse(apiError.retryable)
    }
  }
}

private final class RecordingAPITransport: SleepyHistoryAPITransport {
  enum RecordedResponse {
    case http(statusCode: Int, body: String)
    case failure(Error)
  }

  private var responses: [RecordedResponse]
  private let statusCode: Int
  private(set) var requests: [URLRequest] = []

  init(statusCode: Int = 200, response: String) {
    self.statusCode = statusCode
    self.responses = [.http(statusCode: statusCode, body: response)]
  }

  init(responses: [String]) {
    self.statusCode = 200
    self.responses = responses.map { .http(statusCode: 200, body: $0) }
  }

  init(responses: [RecordedResponse]) {
    self.statusCode = 200
    self.responses = responses
  }

  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    requests.append(request)
    let recordedResponse = responses.isEmpty ? .http(statusCode: statusCode, body: "{}") : responses.removeFirst()
    if case .failure(let error) = recordedResponse {
      throw error
    }

    guard case .http(let statusCode, let responseBody) = recordedResponse else {
      throw URLError(.badServerResponse)
    }

    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: statusCode,
      httpVersion: nil,
      headerFields: nil
    )!

    return (Data(responseBody.utf8), response)
  }
}

private final class InMemoryAPIClientTokenStore: EnrollmentTokenStore {
  private var token: String?

  func readToken() throws -> String? {
    token
  }

  func saveToken(_ token: String) throws {
    self.token = token
  }

  func deleteToken() throws {
    token = nil
  }
}
