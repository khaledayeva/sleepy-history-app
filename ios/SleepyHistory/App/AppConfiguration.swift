import Foundation

struct AppConfiguration: Equatable {
  static let apiBaseURLInfoKey = "SleepyHistoryAPIBaseURL"

  let apiBaseURL: URL

  init(bundle: Bundle = .main) throws {
    try self.init(infoDictionary: bundle.infoDictionary ?? [:])
  }

  init(infoDictionary: [String: Any]) throws {
    guard let value = infoDictionary[Self.apiBaseURLInfoKey] as? String else {
      throw AppConfigurationError.missingAPIBaseURL
    }

    guard let url = URL(string: value),
          let scheme = url.scheme?.lowercased(),
          ["http", "https"].contains(scheme),
          url.host != nil
    else {
      throw AppConfigurationError.invalidAPIBaseURL(value)
    }

    apiBaseURL = url
  }
}

enum AppConfigurationError: Error, Equatable {
  case missingAPIBaseURL
  case invalidAPIBaseURL(String)
}
