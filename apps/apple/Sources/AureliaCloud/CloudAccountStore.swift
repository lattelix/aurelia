import Foundation
import Combine

public enum CloudAuthPhase: String, Sendable { case signedOut, restoring, authorizing, signedIn, offline, expired, secureStorageLocked }
public struct BrowserApproval: Sendable {
    public let userCode: String
    public let verificationURL: URL
    public let expiresAt: Date
}

@MainActor public final class CloudAccountStore: ObservableObject {
    @Published public private(set) var phase: CloudAuthPhase = .signedOut
    @Published public private(set) var account: AccountDTO?
    @Published public private(set) var library: LibraryDTO?
    @Published public private(set) var capabilities: [String: Bool] = [:]
    @Published public private(set) var approval: BrowserApproval?
    @Published public private(set) var isRefreshing = false
    @Published public private(set) var isMutating = false
    @Published public private(set) var libraryNeedsRefresh = false
    @Published public private(set) var recommendations: [RecommendationDTO] = []
    @Published public private(set) var recommendationsLoading = false
    @Published public private(set) var recommendationsError: String?
    @Published public var message: String?
    public var onIdentityChange: (() -> Void)?
    /// Permits an already-approved, unexpired owner to open their local downloads while offline.
    /// A later server rejection still expires the credential and removes that authorization.
    public var authorizedOwnerID: String? {
        guard let credential, credential.expiresAt > now(), [.signedIn, .offline].contains(phase) else { return nil }
        return credential.accountID
    }
    /// Non-secret admission deadline for native local capabilities. This does
    /// not renew a cloud credential or permit cloud requests after expiry.
    public var authorizationExpiresAt: Date? {
        guard authorizedOwnerID != nil else { return nil }
        return credential?.expiresAt
    }
    public let music: CloudMusicStore
    private let client: CloudAPIClient
    private let credentials: any CredentialStoring
    private let now: @Sendable () -> Date
    private let sleep: @Sendable (Double) async throws -> Void
    private var credential: CloudCredential?
    private var generation: UInt64 = 0
    private var refreshGeneration: UInt64?
    private var refreshID: UInt64 = 0
    private var restored = false
    private var polling: Task<Void, Never>?
    private var recommendationGeneration: UInt64 = 0
    private static let savedRefreshMessage = "Saved. Refresh the library to see the latest changes."
    public init(client: CloudAPIClient, credentials: any CredentialStoring,
                now: @escaping @Sendable () -> Date = { Date() },
                sleep: @escaping @Sendable (Double) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }) {
        self.client = client; self.credentials = credentials; self.now = now; self.sleep = sleep
        self.music = CloudMusicStore(client: client)
    }
    deinit { polling?.cancel() }
    public static func live() -> CloudAccountStore {
        CloudAccountStore(client: CloudAPIClient(transport: URLSessionCloudTransport()), credentials: KeychainCredentialStore())
    }
    public func restore() async {
        guard !restored, phase != .authorizing else { return }
        restored = true; phase = .restoring
        let epoch = generation
        do {
            guard let stored = try credentials.load() else { phase = .signedOut; return }
            guard stored.expiresAt > now() else {
                try credentials.delete(); phase = .expired; return
            }
            guard epoch == generation else { return }
            music.reset()
            libraryNeedsRefresh = false
            credential = stored
            await refresh()
        } catch {
            guard epoch == generation else { return }
            restored = false; handleStorage(error)
        }
    }
    /// Returns only the validated public approval URL, never the device code/verifier.
    public func beginSignIn(deviceName: String) async -> URL? {
        guard phase != .secureStorageLocked else { message = CloudFailure.credentialLocked.message; return nil }
        guard credential == nil else { message = "Sign out before connecting another account."; return nil }
        invalidate(); let epoch = generation
        phase = .authorizing; message = nil
        let verifier = PKCE.verifier(), started = now()
        do {
            let grant = try await client.startDevice(challenge: PKCE.challenge(verifier), deviceName: deviceName)
            guard epoch == generation, let url = URL(string: grant.verificationUri) else { return nil }
            guard !Task.isCancelled else { phase = .signedOut; return nil }
            let deadline = started.addingTimeInterval(Double(grant.expiresIn))
            guard deadline > now() else { throw CloudFailure.expired }
            approval = BrowserApproval(userCode: grant.userCode, verificationURL: url, expiresAt: deadline)
            polling = Task { [weak self] in await self?.poll(grant: grant, verifier: verifier, deadline: deadline, epoch: epoch) }
            return url
        } catch {
            guard epoch == generation else { return nil }
            approval = nil; phase = .signedOut; show(error); return nil
        }
    }
    public func cancelSignIn() {
        invalidate(); approval = nil; phase = credential == nil ? .signedOut : .signedIn
        message = nil
    }
    public func foreground() async {
        if phase == .authorizing { return }
        if credential != nil { await refresh() } else { await restore() }
    }
    public func refresh() async {
        guard let captured = credential else { return }
        let epoch = generation
        guard refreshGeneration != epoch else { return }
        refreshID &+= 1; let ticket = refreshID
        refreshGeneration = epoch; isRefreshing = true
        defer { if refreshGeneration == epoch && refreshID == ticket { refreshGeneration = nil; isRefreshing = false } }
        do {
            let result = try await client.bootstrap(captured)
            guard current(epoch, captured), ticket == refreshID else { return }
            account = result.user; library = result.library; capabilities = result.capabilities
            applyRecommendations(result.recommendations)
            libraryNeedsRefresh = false
            phase = .signedIn; message = nil
        } catch {
            guard current(epoch, captured), ticket == refreshID else { return }
            if error as? CloudFailure == .unauthorized { expire(epoch: epoch) }
            else { phase = .offline; show(error) }
        }
    }
    public func signOut(expectedAccountID: String) async {
        guard let captured = credential, !isMutating else { return }
        guard captured.accountID == expectedAccountID else { message = CloudFailure.conflict.message; return }
        invalidate(); let epoch = generation
        onIdentityChange?(); isMutating = true
        defer { if epoch == generation { isMutating = false } }
        do {
            do { try await client.logout(captured) }
            catch CloudFailure.unauthorized {} // Already revoked is signed out.
            guard current(epoch, captured) else { return }
            credential = nil; account = nil; library = nil; capabilities = [:]
            libraryNeedsRefresh = false
            do { try credentials.delete(); phase = .signedOut; message = nil }
            catch { restored = false; handleStorage(error) }
        } catch {
            guard current(epoch, captured) else { return }
            show(error)
        }
    }
    public func setLiked(_ trackID: String, liked: Bool, expectedAccountID: String) async {
        await mutate(expectedAccountID: expectedAccountID) { client, credential in try await client.setLiked(trackID, liked: liked, credential: credential) }
    }
    @discardableResult public func deletePlaylist(_ playlistID: String, expectedAccountID: String) async -> Bool {
        await mutate(expectedAccountID: expectedAccountID) { client, credential in try await client.deletePlaylist(playlistID, credential: credential) }
    }
    public func exportLibrary(expectedAccountID: String) async -> Data? {
        guard let captured = credential, captured.accountID == expectedAccountID else { return nil }
        let epoch = generation
        do {
            let data = try await client.exportLibrary(captured)
            guard current(epoch, captured), !Task.isCancelled else { return nil }
            return data
        } catch {
            guard current(epoch, captured), !Task.isCancelled else { return nil }
            if error as? CloudFailure == .unauthorized { expire(epoch: epoch) } else { show(error) }
            return nil
        }
    }
    public func imports(expectedAccountID: String) async -> CloudImportResultDTO? {
        guard let captured = credential, captured.accountID == expectedAccountID else { return nil }
        let epoch = generation
        do {
            let result = try await client.imports(captured)
            guard current(epoch, captured), !Task.isCancelled else { return nil }
            return result
        } catch {
            guard current(epoch, captured), !Task.isCancelled else { return nil }
            if error as? CloudFailure == .unauthorized { expire(epoch: epoch) } else { show(error) }
            return nil
        }
    }
    public func importLibrary(_ data: Data, expectedAccountID: String) async -> CloudImportResultDTO? {
        await importMutation(expectedAccountID: expectedAccountID) { client, credential in
            try await client.importLibrary(data, credential: credential)
        }
    }
    public func resolveImport(itemID: String, trackID: String, expectedAccountID: String) async -> CloudImportResultDTO? {
        await importMutation(expectedAccountID: expectedAccountID) { client, credential in
            try await client.resolveImport(itemID: itemID, trackID: trackID, credential: credential)
        }
    }
    private func importMutation(expectedAccountID: String,
        _ operation: @Sendable (CloudAPIClient, CloudCredential) async throws -> CloudImportResultDTO) async -> CloudImportResultDTO? {
        guard let captured = credential, captured.accountID == expectedAccountID, !isMutating else { return nil }
        guard !libraryNeedsRefresh else { message = Self.savedRefreshMessage; return nil }
        let epoch = generation
        isMutating = true; message = nil
        defer { if epoch == generation { isMutating = false } }
        var acknowledged: CloudImportResultDTO?
        do {
            let result = try await operation(client, captured)
            guard current(epoch, captured) else { return nil }
            acknowledged = result; libraryNeedsRefresh = true
            refreshID &+= 1; let ticket = refreshID
            refreshGeneration = epoch; isRefreshing = true
            defer { if current(epoch, captured), ticket == refreshID { refreshGeneration = nil; isRefreshing = false } }
            let refreshed = try await client.bootstrap(captured)
            guard current(epoch, captured), ticket == refreshID else { return nil }
            account = refreshed.user; library = refreshed.library; capabilities = refreshed.capabilities
            applyRecommendations(refreshed.recommendations); libraryNeedsRefresh = false
            phase = .signedIn; message = nil
            return result
        } catch {
            guard current(epoch, captured) else { return nil }
            if error as? CloudFailure == .unauthorized { expire(epoch: epoch); return nil }
            if acknowledged != nil { message = Self.savedRefreshMessage }
            else { show(error) }
            return acknowledged
        }
    }
    /// The caller keeps one playID for a playback occurrence; the server updates completion idempotently.
    @discardableResult public func recordHistory(trackID: String, playID: UUID, completion: Double, expectedAccountID: String) async -> Bool {
        await recordActivity(expectedAccountID: expectedAccountID) { client, credential in
            try await client.recordHistory(trackID: trackID, playID: playID, completion: completion, credential: credential)
        }
    }
    @discardableResult public func recordSignal(_ kind: CloudSignalKind, trackID: String? = nil, query: String? = nil,
                                               value: Double = 1, expectedAccountID: String) async -> Bool {
        let recorded = await recordActivity(expectedAccountID: expectedAccountID) { client, credential in
            try await client.recordSignal(kind, trackID: trackID, query: query, value: value, credential: credential)
        }
        if recorded, kind == .hide, let trackID {
            applyRecommendations(recommendations.filter { $0.id != trackID })
        }
        return recorded
    }
    @discardableResult private func recordActivity(expectedAccountID: String,
        _ operation: @Sendable (CloudAPIClient, CloudCredential) async throws -> Void) async -> Bool {
        guard let captured = credential, captured.accountID == expectedAccountID else { return false }
        let epoch = generation
        do {
            try await operation(client, captured)
            return current(epoch, captured) && !Task.isCancelled
        } catch {
            guard current(epoch, captured), !Task.isCancelled else { return false }
            if error as? CloudFailure == .unauthorized { expire(epoch: epoch) }
            else { show(error) }
            return false
        }
    }
    public func loadRecommendations(expectedAccountID: String) async {
        guard let captured = credential, captured.accountID == expectedAccountID else { return }
        let epoch = generation
        recommendationGeneration &+= 1; let ticket = recommendationGeneration
        recommendationsLoading = true; recommendationsError = nil
        defer { if epoch == generation && ticket == recommendationGeneration { recommendationsLoading = false } }
        do {
            let result = try await client.recommendations(captured)
            guard current(epoch, captured), ticket == recommendationGeneration, !Task.isCancelled else { return }
            recommendations = result
        } catch {
            guard current(epoch, captured), ticket == recommendationGeneration, !Task.isCancelled else { return }
            if error as? CloudFailure == .unauthorized { expire(epoch: epoch) }
            else { recommendationsError = (error as? CloudFailure ?? .unavailable).message }
        }
    }
    @discardableResult public func createPlaylist(_ name: String, description: String = "", expectedAccountID: String) async -> Bool {
        await mutate(expectedAccountID: expectedAccountID) { client, credential in _ = try await client.createPlaylist(name, description: description, credential: credential) }
    }
    @discardableResult public func updatePlaylist(_ playlistID: String, name: String, description: String, expectedAccountID: String) async -> Bool {
        await mutate(expectedAccountID: expectedAccountID) { client, credential in
            try await client.updatePlaylist(playlistID, name: name, description: description, credential: credential)
        }
    }
    @discardableResult public func reorderPlaylist(_ playlistID: String, trackIDs: [String], expectedTrackIDs: [String], expectedAccountID: String) async -> Bool {
        await mutate(expectedAccountID: expectedAccountID) { client, credential in
            try await client.reorderPlaylist(playlistID, trackIDs: trackIDs, expectedTrackIDs: expectedTrackIDs, credential: credential)
        }
    }
    public func playlistTrack(_ trackID: String, playlistID: String, adding: Bool, expectedAccountID: String) async {
        await mutate(expectedAccountID: expectedAccountID) { client, credential in try await client.playlistTrack(trackID, playlistID: playlistID, adding: adding, credential: credential) }
    }
    @discardableResult private func mutate(expectedAccountID: String, _ operation: @Sendable (CloudAPIClient, CloudCredential) async throws -> Void) async -> Bool {
        guard let captured = credential, !isMutating else { return false }
        guard captured.accountID == expectedAccountID else { message = CloudFailure.conflict.message; return false }
        guard !libraryNeedsRefresh else { message = Self.savedRefreshMessage; return false }
        let epoch = generation; isMutating = true
        var acknowledged = false
        message = nil
        defer { if epoch == generation { isMutating = false } }
        do {
            try await operation(client, captured)
            guard current(epoch, captured) else { return false }
            acknowledged = true; libraryNeedsRefresh = true
            // Invalidate older reads; a successful write is not a successful refresh.
            refreshID &+= 1; let ticket = refreshID
            refreshGeneration = epoch; isRefreshing = true
            defer {
                if current(epoch, captured), ticket == refreshID { refreshGeneration = nil; isRefreshing = false }
            }
            let result = try await client.bootstrap(captured)
            guard current(epoch, captured), ticket == refreshID else { return false }
            account = result.user; library = result.library; capabilities = result.capabilities
            applyRecommendations(result.recommendations)
            libraryNeedsRefresh = false
            phase = .signedIn; message = nil
            return true
        } catch {
            guard current(epoch, captured) else { return false }
            if error as? CloudFailure == .unauthorized { expire(epoch: epoch) }
            else if acknowledged { message = Self.savedRefreshMessage }
            else { show(error) }
            return acknowledged
        }
    }
    private func poll(grant: DeviceStartDTO, verifier: String, deadline: Date, epoch: UInt64) async {
        var interval = Double(max(3, grant.interval))
        do {
            while generation == epoch && !Task.isCancelled {
                guard now().addingTimeInterval(interval) < deadline else { throw CloudFailure.expired }
                try await sleep(interval)
                guard generation == epoch, !Task.isCancelled else { return }
                guard now() < deadline else { throw CloudFailure.expired }
                let result: DevicePoll
                do { result = try await client.pollDevice(grant, verifier: verifier, now: now()) }
                catch CloudFailure.slowDown(let delay) { interval = min(60, max(interval + 5, delay)); continue }
                guard generation == epoch, !Task.isCancelled else { await discard(result); return }
                guard now() < deadline else { await discard(result); throw CloudFailure.expired }
                if case .approved(let newCredential, let user) = result {
                    do { try credentials.save(newCredential) }
                    catch {
                        try? await client.logout(newCredential)
                        throw error
                    }
                    guard generation == epoch else { return }
                    music.reset()
                    libraryNeedsRefresh = false
                    credential = newCredential; account = user; library = nil
                    approval = nil; phase = .signedIn; restored = true; polling = nil
                    onIdentityChange?(); await refresh(); return
                }
            }
        } catch is CancellationError { return }
        catch {
            guard generation == epoch else { return }
            approval = nil; phase = .signedOut; polling = nil; show(error)
        }
    }
    private func current(_ epoch: UInt64, _ captured: CloudCredential) -> Bool {
        epoch == generation && credential?.accountID == captured.accountID && credential?.token == captured.token
    }
    private func discard(_ result: DevicePoll) async {
        guard case .approved(let issued, _) = result else { return }
        // Cancellation may race with token issuance. Revoke only that unused
        // token, in a bounded task that does not inherit the cancelled poll.
        let client = client
        let cleanup = Task { try? await client.logout(issued) }
        await cleanup.value
    }
    private func invalidate() {
        music.reset()
        recommendationGeneration &+= 1; recommendations = []; recommendationsLoading = false; recommendationsError = nil
        generation &+= 1; polling?.cancel(); polling = nil
        refreshGeneration = nil; isRefreshing = false; isMutating = false
    }
    private func applyRecommendations(_ entries: [RecommendationDTO]) {
        recommendationGeneration &+= 1
        recommendations = entries; recommendationsLoading = false; recommendationsError = nil
    }
    private func expire(epoch: UInt64) {
        guard generation == epoch else { return }
        invalidate(); credential = nil; account = nil; library = nil; approval = nil; capabilities = [:]
        libraryNeedsRefresh = false
        phase = .expired; onIdentityChange?()
        do { try credentials.delete() } catch { restored = false; handleStorage(error) }
    }
    private func show(_ error: Error) { message = (error as? CloudFailure ?? .unavailable).message }
    private func handleStorage(_ error: Error) {
        phase = .secureStorageLocked; show(error as? CloudFailure ?? .credentialUnavailable)
    }
}
