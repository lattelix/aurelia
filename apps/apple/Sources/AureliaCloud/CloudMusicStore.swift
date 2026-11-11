import Foundation
import Combine

/// Anonymous public metadata. This store has no credential or playback dependency.
@MainActor public final class CloudMusicStore: ObservableObject {
    @Published public private(set) var discovery: DiscoveryDTO?
    @Published public private(set) var discoveryLoading = false
    @Published public private(set) var discoveryError: String?
    @Published public private(set) var searchResults: [TrackDTO] = []
    @Published public private(set) var searchLoading = false
    @Published public private(set) var searchError: String?
    private let client: CloudAPIClient
    private var discoveryGeneration: UInt64 = 0
    private var searchGeneration: UInt64 = 0
    private var discoveryTask: Task<DiscoveryDTO, Error>?
    private var searchTask: Task<[TrackDTO], Error>?

    public init(client: CloudAPIClient) { self.client = client }
    deinit { discoveryTask?.cancel(); searchTask?.cancel() }

    /// Each mounted search screen owns its results and cancellation. Sharing the
    /// stateless HTTP client must not share a query across tabs or Mac windows.
    public func makeSearchSession() -> CloudMusicStore { CloudMusicStore(client: client) }
    public func makeLyricsSession() -> CloudLyricsStore { CloudLyricsStore(client: client) }
    public func makeCatalogueSession() -> CloudCatalogueStore { CloudCatalogueStore(client: client) }

    public func loadDiscovery() async {
        discoveryGeneration &+= 1; let ticket = discoveryGeneration
        discoveryTask?.cancel()
        discoveryLoading = true; discoveryError = nil
        let client = client, task = Task { try await client.discovery() }
        discoveryTask = task
        defer {
            if ticket == discoveryGeneration { discoveryLoading = false; discoveryTask = nil }
        }
        do {
            let result = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
            guard ticket == discoveryGeneration, !Task.isCancelled, !task.isCancelled else { return }
            discovery = result
        } catch {
            guard ticket == discoveryGeneration, !Task.isCancelled, !task.isCancelled,
                  !(error is CancellationError) else { return }
            discoveryError = (error as? CloudFailure ?? .unavailable).message
        }
    }

    public func search(_ query: String) async {
        clearSearch()
        guard let query = musicQuery(query) else { return }
        let ticket = searchGeneration
        searchLoading = true
        let client = client, task = Task { try await client.search(query) }
        searchTask = task
        defer {
            if ticket == searchGeneration { searchLoading = false; searchTask = nil }
        }
        do {
            let result = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
            guard ticket == searchGeneration, !Task.isCancelled, !task.isCancelled else { return }
            searchResults = result
        } catch {
            guard ticket == searchGeneration, !Task.isCancelled, !task.isCancelled,
                  !(error is CancellationError) else { return }
            searchError = (error as? CloudFailure ?? .unavailable).message
        }
    }

    public func clearSearch() {
        searchGeneration &+= 1; searchTask?.cancel(); searchTask = nil
        searchResults = []; searchLoading = false; searchError = nil
    }

    /// Invalidates in-flight results at an account boundary as well as visible metadata.
    public func reset() {
        discoveryGeneration &+= 1; discoveryTask?.cancel(); discoveryTask = nil
        discovery = nil; discoveryLoading = false; discoveryError = nil
        clearSearch()
    }
}
