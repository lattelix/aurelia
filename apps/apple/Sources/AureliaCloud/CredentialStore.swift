import Foundation
import Security

@MainActor public protocol CredentialStoring: AnyObject {
    func load() throws -> CloudCredential?
    func save(_ credential: CloudCredential) throws
    func delete() throws
}

/// No defaults, cookies, synchronizable items, shared groups or plaintext fallback.
@MainActor public final class KeychainCredentialStore: CredentialStoring {
    public init() {}
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.lattelix.aurelia.native.cloud.v1",
         kSecAttrAccount as String: CloudAPIClient.origin.absoluteString,
         kSecAttrSynchronizable as String: false]
    }
    public func load() throws -> CloudCredential? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try require(status)
        guard let data = result as? Data, data.count <= 4096,
              let credential = try? JSONDecoder().decode(CloudCredential.self, from: data) else { throw CloudFailure.credentialUnavailable }
        try credential.validate(); return credential
    }
    public func save(_ credential: CloudCredential) throws {
        try credential.validate()
        let data = try JSONEncoder().encode(credential)
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query; attributes.forEach { item[$0.key] = $0.value }
            try require(SecItemAdd(item as CFDictionary, nil))
        } else { try require(status) }
    }
    public func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecItemNotFound { try require(status) }
    }
    private func require(_ status: OSStatus) throws {
        guard status == errSecSuccess else {
            if status == errSecInteractionNotAllowed || status == errSecAuthFailed || status == errSecUserCanceled { throw CloudFailure.credentialLocked }
            throw CloudFailure.credentialUnavailable
        }
    }
}
