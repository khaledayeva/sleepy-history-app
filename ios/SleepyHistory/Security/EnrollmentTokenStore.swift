import Foundation
import Security

protocol EnrollmentTokenStore {
  func readToken() throws -> String?
  func saveToken(_ token: String) throws
  func deleteToken() throws
}

final class KeychainTokenStore: EnrollmentTokenStore {
  private let service: String
  private let account: String

  init(
    service: String = Bundle.main.bundleIdentifier ?? "com.khaledayeva.SleepyHistory",
    account: String = "owner-enrollment-token"
  ) {
    self.service = service
    self.account = account
  }

  func readToken() throws -> String? {
    var query = baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)

    if status == errSecItemNotFound {
      return nil
    }

    guard status == errSecSuccess else {
      throw KeychainTokenStoreError.unhandledStatus(status)
    }

    guard let data = result as? Data,
          let token = String(data: data, encoding: .utf8)
    else {
      throw KeychainTokenStoreError.invalidStoredToken
    }

    return token
  }

  func saveToken(_ token: String) throws {
    guard !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw KeychainTokenStoreError.emptyToken
    }

    try deleteToken()

    var item = baseQuery()
    item[kSecValueData as String] = Data(token.utf8)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw KeychainTokenStoreError.unhandledStatus(status)
    }
  }

  func deleteToken() throws {
    let status = SecItemDelete(baseQuery() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainTokenStoreError.unhandledStatus(status)
    }
  }

  private func baseQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account
    ]
  }
}

enum KeychainTokenStoreError: Error, Equatable {
  case emptyToken
  case invalidStoredToken
  case unhandledStatus(OSStatus)
}
