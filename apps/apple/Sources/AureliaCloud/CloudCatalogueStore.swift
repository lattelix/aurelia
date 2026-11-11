import Foundation
import Combine

/// One anonymous catalogue screen owns one generation. This store has no
/// credential, account, playback source or persistent storage dependency.
@MainActor public final class CloudCatalogueStore: ObservableObject {
    @Published public private(set) var result: MusicCatalogueDTO?
    @Published public private(set) var loading = false
    @Published public private(set) var error: String?
    @Published public private(set) var usesLegacySongs = false
    private let client: CloudAPIClient
    private var generation: UInt64 = 0
    private var task: Task<MusicCatalogueSearchResult, Error>?
    public init(client: CloudAPIClient) { self.client = client }
    deinit { task?.cancel() }
    public func makeSession() -> CloudCatalogueStore { CloudCatalogueStore(client: client) }
    public func search(_ query: String, kind: MusicSearchKind) async {
        guard let query = musicQuery(query) else { clear(); return }
        let client = client
        await load { try await client.searchCatalogue(query, kind: kind) }
    }
    public func browse(_ collection: MusicCollectionDTO) async {
        let client = client
        await load { .init(catalogue: try await client.browseCatalogue(kind: collection.kind, id: collection.id), usesLegacySongs: false) }
    }
    public func charts(country: String) async {
        let client = client
        await load { .init(catalogue: try await client.chartsCatalogue(country: country), usesLegacySongs: false) }
    }
    public func clear() {
        generation &+= 1; task?.cancel(); task = nil
        result = nil; loading = false; error = nil; usesLegacySongs = false
    }
    private func load(_ action: @escaping @Sendable () async throws -> MusicCatalogueSearchResult) async {
        clear(); let ticket = generation
        loading = true
        let pending = Task { try await action() }; task = pending
        defer { if ticket == generation { loading = false; task = nil } }
        do {
            let value = try await withTaskCancellationHandler { try await pending.value } onCancel: { pending.cancel() }
            guard ticket == generation, !Task.isCancelled, !pending.isCancelled else { return }
            result = value.catalogue; usesLegacySongs = value.usesLegacySongs
        } catch {
            guard ticket == generation, !Task.isCancelled, !pending.isCancelled, !(error is CancellationError) else { return }
            self.error = (error as? CloudCatalogueFailure)?.message ?? (error as? CloudFailure ?? .unavailable).message
        }
    }
}
