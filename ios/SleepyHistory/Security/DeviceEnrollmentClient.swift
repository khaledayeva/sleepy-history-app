import Foundation

protocol DeviceEnrollmentTransport {
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

struct URLSessionDeviceEnrollmentTransport: DeviceEnrollmentTransport {
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw DeviceEnrollmentClientError.invalidResponse
    }

    return (data, httpResponse)
  }
}

struct DeviceEnrollmentClient: @unchecked Sendable {
  let apiBaseURL: URL
  let tokenStore: EnrollmentTokenStore
  let transport: DeviceEnrollmentTransport

  init(
    apiBaseURL: URL,
    tokenStore: EnrollmentTokenStore = KeychainTokenStore(),
    transport: DeviceEnrollmentTransport = URLSessionDeviceEnrollmentTransport()
  ) {
    self.apiBaseURL = apiBaseURL
    self.tokenStore = tokenStore
    self.transport = transport
  }

  func enrollOnce(code: String, deviceLabel: String) async throws -> String {
    if let existingToken = try tokenStore.readToken() {
      return existingToken
    }

    var request = URLRequest(url: apiBaseURL.appendingPathComponent("device-enrollments"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try JSONEncoder().encode(DeviceEnrollmentRequest(
      code: code,
      deviceLabel: deviceLabel
    ))

    let (data, response) = try await transport.data(for: request)
    guard response.statusCode == 201 else {
      throw DeviceEnrollmentClientError.serverRejected(statusCode: response.statusCode)
    }

    let payload = try JSONDecoder().decode(DeviceEnrollmentResponse.self, from: data)
    try tokenStore.saveToken(payload.device.token)
    return payload.device.token
  }
}

enum DeviceEnrollmentClientError: Error, Equatable {
  case invalidResponse
  case serverRejected(statusCode: Int)
}

private struct DeviceEnrollmentRequest: Encodable {
  let code: String
  let deviceLabel: String
}

private struct DeviceEnrollmentResponse: Decodable {
  let device: DeviceEnrollmentDevice
}

private struct DeviceEnrollmentDevice: Decodable {
  let token: String
}
