import XCTest
@testable import SleepyHistory

final class DeviceEnrollmentClientTests: XCTestCase {
  func testEnrollOnceExchangesCodeAndStoresReturnedToken() async throws {
    let store = InMemoryEnrollmentTokenStore()
    let transport = RecordingEnrollmentTransport(
      response: """
      {
        "device": {
          "deviceId": "owner-abc123",
          "deviceLabel": "Khaled's iPhone 14 Pro Max",
          "token": "returned-owner-device-token-000000000000"
        }
      }
      """
    )
    let client = DeviceEnrollmentClient(
      apiBaseURL: URL(string: "http://127.0.0.1:8787")!,
      tokenStore: store,
      transport: transport
    )

    let token = try await client.enrollOnce(
      code: "one-time-code",
      deviceLabel: "Khaled's iPhone 14 Pro Max"
    )

    XCTAssertEqual(token, "returned-owner-device-token-000000000000")
    XCTAssertEqual(try store.readToken(), token)
    XCTAssertEqual(transport.requests.count, 1)
    XCTAssertEqual(transport.requests.first?.url?.path, "/device-enrollments")
    XCTAssertEqual(transport.requests.first?.value(forHTTPHeaderField: "content-type"), "application/json")
    let requestBody = try JSONSerialization.jsonObject(
      with: transport.requests.first?.httpBody ?? Data()
    ) as? [String: String]
    XCTAssertEqual(requestBody?["code"], "one-time-code")
    XCTAssertEqual(requestBody?["deviceLabel"], "Khaled's iPhone 14 Pro Max")
  }

  func testEnrollOnceDoesNotExchangeAgainWhenTokenAlreadyExists() async throws {
    let store = InMemoryEnrollmentTokenStore()
    try store.saveToken("existing-owner-device-token")
    let transport = RecordingEnrollmentTransport(response: #"{"device":{"token":"unused"}}"#)
    let client = DeviceEnrollmentClient(
      apiBaseURL: URL(string: "http://127.0.0.1:8787")!,
      tokenStore: store,
      transport: transport
    )

    let token = try await client.enrollOnce(code: "unused-code", deviceLabel: "Owner iPhone")

    XCTAssertEqual(token, "existing-owner-device-token")
    XCTAssertTrue(transport.requests.isEmpty)
  }

  func testEnrollOnceSurfacesServerRejectionWithoutSavingToken() async throws {
    let store = InMemoryEnrollmentTokenStore()
    let transport = RecordingEnrollmentTransport(
      statusCode: 400,
      response: #"{"error":{"code":"used_enrollment_code"}}"#
    )
    let client = DeviceEnrollmentClient(
      apiBaseURL: URL(string: "http://127.0.0.1:8787")!,
      tokenStore: store,
      transport: transport
    )

    do {
      _ = try await client.enrollOnce(code: "used-code", deviceLabel: "Owner iPhone")
      XCTFail("Expected server rejection")
    } catch {
      XCTAssertEqual(error as? DeviceEnrollmentClientError, .serverRejected(statusCode: 400))
      XCTAssertNil(try store.readToken())
    }
  }
}

private final class RecordingEnrollmentTransport: DeviceEnrollmentTransport {
  private let statusCode: Int
  private let response: String
  private(set) var requests: [URLRequest] = []

  init(statusCode: Int = 201, response: String) {
    self.statusCode = statusCode
    self.response = response
  }

  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    requests.append(request)
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: statusCode,
      httpVersion: nil,
      headerFields: nil
    )!

    return (Data(self.response.utf8), response)
  }
}

private final class InMemoryEnrollmentTokenStore: EnrollmentTokenStore {
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
