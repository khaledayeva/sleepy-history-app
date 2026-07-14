import XCTest
@testable import SleepyHistory

final class EnrollmentTokenStoreTests: XCTestCase {
  private var store: KeychainTokenStore!

  override func setUpWithError() throws {
    try super.setUpWithError()
    store = KeychainTokenStore(
      service: "com.khaledayeva.SleepyHistoryTests.\(UUID().uuidString)",
      account: "owner-token"
    )
    try store.deleteToken()
  }

  override func tearDownWithError() throws {
    try? store.deleteToken()
    store = nil
    try super.tearDownWithError()
  }

  func testKeychainTokenStoreSavesReadsReplacesAndDeletesToken() throws {
    XCTAssertNil(try store.readToken())

    try store.saveToken("owner-device-token-first")
    XCTAssertEqual(try store.readToken(), "owner-device-token-first")

    try store.saveToken("owner-device-token-second")
    XCTAssertEqual(try store.readToken(), "owner-device-token-second")

    try store.deleteToken()
    XCTAssertNil(try store.readToken())
  }

  func testKeychainTokenStoreRejectsBlankToken() throws {
    XCTAssertThrowsError(try store.saveToken("   ")) { error in
      XCTAssertEqual(error as? KeychainTokenStoreError, .emptyToken)
    }
    XCTAssertNil(try store.readToken())
  }
}
