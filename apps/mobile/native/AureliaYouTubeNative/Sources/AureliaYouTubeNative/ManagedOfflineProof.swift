import Foundation
import CryptoKit
import AureliaPlaybackCore
import Darwin
import ImageIO
#if os(iOS)
import UIKit
#endif

private struct OfflineNetworkSnapshot: Codable {
    var sourceStep = "none", cipherStep = "none", sourceRoute = "none", sourceFailure = "none"
    var sourceHTTPResponses = 0, sourceLastHTTPStatus = 0, sourceRejectedStatus = 0, sourceRedirectStatus = 0
    var mediaHTTPResponses = 0, mediaLastHTTPStatus = 0, mediaRejectedStatus = 0, mediaRedirectStatus = 0
}
private final class OfflineProofNetwork: @unchecked Sendable {
    private let lock = NSLock()
    private var values = OfflineNetworkSnapshot()
    func sourceStep(_ step: YouTubeSourceStep) { lock.withLock { values.sourceStep = step.rawValue } }
    func cipherStep(_ step: NativeCipherStep) { lock.withLock { values.cipherStep = step.rawValue } }
    func route(_ request: URLRequest) { lock.withLock {
        switch request.url?.path {
        case "/watch": values.sourceRoute = "watch"
        case "/youtubei/v1/player": values.sourceRoute = "player"
        default: values.sourceRoute = request.url?.path.hasSuffix("/base.js") == true ? "script" : "media"
        }
    } }
    func failure(_ error: Error) { lock.withLock { values.sourceFailure = (error as? PlaybackFailure)?.rawValue ?? "network" } }
    func event(_ event: YouTubeHTTPDiagnostic, media: Bool) { lock.withLock {
        switch event {
        case .response(let status):
            if media {
                values.mediaHTTPResponses += 1; values.mediaLastHTTPStatus = status
                if status != 206 { values.mediaRejectedStatus = status }
            } else {
                values.sourceHTTPResponses += 1; values.sourceLastHTTPStatus = status
                if status != 200 && status != 206 { values.sourceRejectedStatus = status }
            }
        case .redirect(let status):
            if media { values.mediaRedirectStatus = status } else { values.sourceRedirectStatus = status }
        }
    } }
    func snapshot() -> OfflineNetworkSnapshot { lock.withLock { values } }
}
private struct OfflineProofSourceHTTP: YouTubeHTTPTransport {
    let diagnostics: OfflineProofNetwork
    let actual: PlayerSourceHTTP
    init(_ diagnostics: OfflineProofNetwork) {
        self.diagnostics = diagnostics
        actual = PlayerSourceHTTP(diagnostic: { diagnostics.event($0, media: false) })
    }
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        diagnostics.route(request)
        do { return try await actual.request(request, maxBytes: maxBytes) }
        catch { diagnostics.failure(error); throw error }
    }
}

private actor OfflineDenyNetwork: PlaybackResolving, YouTubeHTTPTransport {
    private(set) var resolverCalls = 0
    private(set) var transportCalls = 0
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        resolverCalls += 1; throw PlaybackFailure.network
    }
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        transportCalls += 1; throw PlaybackFailure.network
    }
}
private struct ProofLocalOnlyResolver: PlaybackResolving {
    let engine: ManagedOfflineEngine
    let owner: OfflineOwnerScope
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        try await .offline(engine.openReady(track, owner: owner))
    }
}
private struct OfflineLiveReport: Codable {
    var status = "failed"
    var phase = "storage"
    var reason = "unavailable"
    var bytes = 0
    var ready = false
    var coldActivation = false
    var wholeHashMatched = false
    var assetsRestored = false
    var backgroundContinued = false
    var nativeProgress = false
    var nativeSeek = false
    var ownerRevoked = false
    var deniedResolverCalls = 0
    var deniedTransportCalls = 0
    var elapsedMS = 0
    var cleaned = false
    var diagnostics = OfflineNetworkSnapshot()
}

private let offlineProofClock = ContinuousClock()
private let offlineProofClockOrigin = offlineProofClock.now
private func offlineProofNow() -> TimeInterval {
    let elapsed = offlineProofClockOrigin.duration(to: offlineProofClock.now).components
    return Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1_000_000_000_000_000_000
}

private func offlineProofBackgroundSeconds(arguments: [String]) throws -> Int {
    guard arguments.filter({ $0.hasPrefix("--native-offline-proof") }) == ["--native-offline-proof"],
          arguments.contains("--force-muted"),
          !arguments.contains("--native-source-proof") else { throw OfflineFailure.invalidRequest }
    let options = arguments.filter { $0.hasPrefix("--native-background-seconds") }
    guard options.count <= 1 else { throw OfflineFailure.invalidRequest }
    guard let option = options.first else { return 16 }
    let prefix = "--native-background-seconds="
    guard option.hasPrefix(prefix) else { throw OfflineFailure.invalidRequest }
    let value = option.dropFirst(prefix.count)
    guard (2...3).contains(value.utf8.count), value.utf8.allSatisfy({ (48...57).contains($0) }),
          let seconds = Int(value), (16...180).contains(seconds) else { throw OfflineFailure.invalidRequest }
    return seconds
}

private func emitOfflineProofReport(_ report: OfflineLiveReport, onDevice: Bool) {
    if let data = try? JSONEncoder().encode(report) {
        print((onDevice ? "AURELIA_OFFLINE_CHECK " : "") + String(decoding: data, as: UTF8.self)); fflush(nil)
    }
}

/// Explicit fixed CC fixture only. App/profile/Keychain code is never created.
/// Mac supervision remains 120 seconds. Device preparation has 110 seconds plus
/// the explicit, bounded background window; raw output stays supervisor-only.
@MainActor private enum OfflineProofAdmission { static var ranOnDevice = false }
@MainActor public func runManagedOfflineLiveProof(directory: URL? = nil, reserveBytes: Int64 = 3 * 1024 * 1024 * 1024) async -> Bool {
    var backgroundSeconds = 16
    if directory != nil {
        do {
            #if DEBUG
            let deviceProofEnabled = true
            #else
            let deviceProofEnabled = false
            #endif
            guard deviceProofEnabled else { throw OfflineFailure.invalidRequest }
            backgroundSeconds = try offlineProofBackgroundSeconds(arguments: ProcessInfo.processInfo.arguments)
            guard !OfflineProofAdmission.ranOnDevice else { throw OfflineFailure.invalidRequest }
        } catch {
            var rejected = OfflineLiveReport()
            rejected.reason = "invalidRequest"; rejected.cleaned = true
            emitOfflineProofReport(rejected, onDevice: true)
            return false
        }
        OfflineProofAdmission.ranOnDevice = true
    }
    let started = offlineProofNow()
    let preparationDeadline = started + 110
    let deadline = preparationDeadline + (directory == nil ? 0 : Double(backgroundSeconds))
    let repository = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let suppliedRun = ProcessInfo.processInfo.environment["AURELIA_OFFLINE_PROOF_RUN_ID"].flatMap(UUID.init(uuidString:))
    let runID = (suppliedRun ?? UUID()).uuidString.lowercased()
    let base = directory ?? repository.appendingPathComponent(".runtime", isDirectory: true)
    let temporary = base.appendingPathComponent("offline-live-" + runID, isDirectory: true)
    let storage = temporary.appendingPathComponent("copies", isDirectory: true)
    var report = OfflineLiveReport(), live: ManagedOfflineEngine?, restored: ManagedOfflineEngine?
    var controller: NativePlaybackController?, copy: OfflineLocalCopy?
    let denied = OfflineDenyNetwork()
    let network = OfflineProofNetwork()
    do {
        guard (directory == nil ? FileManager.default.fileExists(atPath: repository.appendingPathComponent("apps/mobile/native/AureliaYouTubeNative/Package.swift").path) : directory?.standardizedFileURL.path == FileManager.default.temporaryDirectory.resolvingSymlinksInPath().standardizedFileURL.path),
              reserveBytes >= 128 * 1024 * 1024, reserveBytes <= 3 * 1024 * 1024 * 1024,
              temporary.standardizedFileURL.path == temporary.resolvingSymlinksInPath().standardizedFileURL.path,
              let free = try FileManager.default.attributesOfFileSystem(forPath: base.path)[.systemFreeSize] as? NSNumber,
              free.int64Value >= reserveBytes + 128 * 1024 * 1024 else { throw OfflineFailure.insufficientSpace }
        let owner = try OfflineOwnerScope(ownerID: "public-cc-offline-proof")
        let track = try PlaybackTrack(videoID: "aqz-KE-bpKQ", title: "Public CC offline proof", artist: "Blender Foundation")
        let policy = try OfflineStoragePolicy(budgetBytes: 256 * 1024 * 1024, reserveBytes: reserveBytes)
        let source = PortableYouTubeResolver(transport: OfflineProofSourceHTTP(network),
            cipherSolver: NativeYouTubeCipherSolver(diagnostic: { network.cipherStep($0) }), deadline: 25,
            diagnostic: { network.sourceStep($0) })
        let engine = try ManagedOfflineEngine(rootDirectory: storage, resolver: source, policy: policy,
            transport: BoundedYouTubeHTTP(diagnostic: { network.event($0, media: true) }))
        live = engine
        try await engine.activateOwner(owner); try await engine.setEnvironment(foreground: true, onWiFi: true)
        report.phase = "download"
        _ = try await engine.enqueue(track, owner: owner)
        while offlineProofNow() < preparationDeadline {
            let item = try await engine.snapshot(owner: owner).items.first
            if let item { report.bytes = item.receivedBytes }
            if item?.state == .failed { throw item?.failure ?? OfflineFailure.unavailable }
            if item?.state == .ready { report.ready = true; break }
            try await Task.sleep(for: .milliseconds(200))
        }
        guard report.ready else { throw OfflineFailure.network }
        guard let itemID = try await engine.snapshot(owner: owner).items.first?.id else { throw OfflineFailure.notReady }
        let assets = try OfflineAssetsPayload(album: "Aurelia offline proof", duration: 600,
            coverJPEG: makeOfflineProofCover(), plainLyrics: "Offline verification",
            syncedLyrics: "[00:00.00] Offline verification", enrichmentComplete: true)
        _ = try await engine.saveAssets(assets, for: itemID, owner: owner, expectedRevision: nil)
        copy = try await engine.openReady(track, owner: owner)
        let initialHash = try hashLocalFile(copy!.url, deadline: preparationDeadline)
        try await engine.activateOwner(nil)
        guard copy?.isValid == false else { throw OfflineFailure.staleOwner }
        copy = nil; live = nil

        report.phase = "cold"
        let coldOwner = try OfflineOwnerScope(ownerID: owner.ownerID)
        let cold = try ManagedOfflineEngine(rootDirectory: storage, resolver: denied, policy: policy, transport: denied)
        restored = cold
        try await cold.activateOwner(coldOwner)
        copy = try await cold.openReady(track, owner: coldOwner)
        report.coldActivation = copy!.isValid
        let restoredAssets = try await cold.readAssets(itemID, owner: coldOwner)
        let restoredItem = try await cold.snapshot(owner: coldOwner).items.first
        report.assetsRestored = restoredAssets?.payload == assets && restoredItem?.album == assets.album &&
            restoredItem?.duration == assets.duration && restoredItem?.assetsEnriched == true
        report.wholeHashMatched = try hashLocalFile(copy!.url, deadline: preparationDeadline) == initialHash
        guard report.coldActivation, report.wholeHashMatched, report.assetsRestored else { throw OfflineFailure.corrupt }

        report.phase = "local"
        let player = NativePlaybackController(resolver: ProofLocalOnlyResolver(engine: cold, owner: coldOwner),
                                              driver: AVPlayerDriver(volume: 0, enableSystemControls: false))
        controller = player
        try player.setQueue([track], playing: true)
        try await waitOfflineProgress(player, after: 1, deadline: min(preparationDeadline, offlineProofNow() + 15))
        report.nativeProgress = true
        let target = max(2, min(30, player.snapshot.duration / 2))
        player.seek(to: target)
        try await waitOfflineProgress(player, after: target + 0.5, deadline: min(preparationDeadline, offlineProofNow() + 15))
        report.nativeSeek = true
        #if os(iOS)
        if directory != nil {
            report.phase = "background"
            print("AURELIA_OFFLINE_BACKGROUND_WINDOW"); fflush(nil)
            try await sampleOfflineBackground(player, seconds: backgroundSeconds, proofStarted: started,
                admissionDeadline: min(preparationDeadline, offlineProofNow() + 15), deadline: deadline)
            report.backgroundContinued = true
        }
        #endif
        player.pause(); player.dispose(); controller = nil

        report.phase = "revoke"
        let other = try OfflineOwnerScope(ownerID: "another-offline-proof-owner")
        try await cold.activateOwner(other)
        let empty = try await cold.snapshot(owner: other).items.isEmpty
        report.ownerRevoked = copy?.isValid == false && empty
        guard report.ownerRevoked else { throw OfflineFailure.staleOwner }
        do { _ = try await cold.openReady(track, owner: coldOwner); throw OfflineFailure.invalidRequest }
        catch OfflineFailure.staleOwner { }
        report.deniedResolverCalls = await denied.resolverCalls
        report.deniedTransportCalls = await denied.transportCalls
        guard report.deniedResolverCalls == 0, report.deniedTransportCalls == 0 else { throw OfflineFailure.network }
        try await cold.activateOwner(nil); restored = nil; copy = nil
        report.status = "passed"; report.phase = "complete"; report.reason = "none"
    } catch {
        report.reason = (error as? OfflineFailure)?.rawValue ?? (error as? PlaybackFailure)?.rawValue ?? "unavailable"
    }
    controller?.dispose(); controller = nil; copy = nil
    try? await live?.activateOwner(nil); try? await restored?.activateOwner(nil)
    do { if FileManager.default.fileExists(atPath: temporary.path) { try FileManager.default.removeItem(at: temporary) }; report.cleaned = true }
    catch { report.status = "failed"; report.reason = "storage" }
    report.elapsedMS = Int((offlineProofNow() - started) * 1_000)
    report.diagnostics = network.snapshot()
    emitOfflineProofReport(report, onDevice: directory != nil)
    return report.status == "passed"
}

#if os(iOS)
private enum OfflineBackgroundEvent: String, Codable { case start, progress, complete }
private struct OfflineBackgroundSample: Codable {
    let event: OfflineBackgroundEvent
    let requestedSeconds: Int
    let elapsedMS: Int
    let totalElapsedMS: Int
    let positionMS: Int
    let advancedMS: Int
    let applicationState: Int
    let playing: Bool
    let uninterrupted: Bool
}

@MainActor private final class OfflineBackgroundContinuity {
    private(set) var uninterrupted = true
    private var foregroundObserver: NSObjectProtocol?
    init() {
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.uninterrupted = false }
        }
    }
    func stop() {
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
        foregroundObserver = nil
    }
}

@MainActor private func sampleOfflineBackground(_ player: NativePlaybackController, seconds: Int,
                                               proofStarted: TimeInterval, admissionDeadline: TimeInterval,
                                               deadline: TimeInterval) async throws {
    while UIApplication.shared.applicationState != .background {
        guard offlineProofNow() < admissionDeadline, player.snapshot.status == .playing else {
            throw PlaybackFailure.decoder
        }
        try await Task.sleep(for: .milliseconds(100))
    }
    let continuity = OfflineBackgroundContinuity()
    defer { continuity.stop() }
    let started = offlineProofNow(), initialPosition = player.snapshot.position
    var previousTime = started, previousPosition = initialPosition
    func milliseconds(_ value: Double) -> Int {
        value.isFinite ? Int(max(0, min(86_400, value)) * 1_000) : 0
    }
    func emit(_ event: OfflineBackgroundEvent) {
        let now = offlineProofNow()
        let sample = OfflineBackgroundSample(event: event, requestedSeconds: seconds,
            elapsedMS: milliseconds(now - started), totalElapsedMS: milliseconds(now - proofStarted),
            positionMS: milliseconds(player.snapshot.position), advancedMS: milliseconds(player.snapshot.position - initialPosition),
            applicationState: UIApplication.shared.applicationState.rawValue,
            playing: player.snapshot.status == .playing, uninterrupted: continuity.uninterrupted)
        if let data = try? JSONEncoder().encode(sample) {
            print("AURELIA_BACKGROUND_SAMPLE " + String(decoding: data, as: UTF8.self)); fflush(nil)
        }
    }
    emit(.start)
    while true {
        let now = offlineProofNow()
        let remaining = Double(seconds) - (now - started)
        if remaining <= 0 { break }
        guard now + remaining <= deadline else {
            throw PlaybackFailure.decoder
        }
        try await Task.sleep(for: .seconds(min(5, remaining)))
        let sampledAt = offlineProofNow(), position = player.snapshot.position
        let elapsed = sampledAt - started
        emit(elapsed >= Double(seconds) ? .complete : .progress)
        guard sampledAt <= deadline, UIApplication.shared.applicationState == .background,
              continuity.uninterrupted, player.snapshot.status == .playing,
              position - previousPosition >= (sampledAt - previousTime) * 0.5 else { throw PlaybackFailure.decoder }
        previousTime = sampledAt; previousPosition = position
    }
    guard player.snapshot.position - initialPosition >= Double(max(10, seconds - 6)) else { throw PlaybackFailure.decoder }
}
#endif

private func makeOfflineProofCover() throws -> Data {
    let bytes = NSMutableData()
    guard let context = CGContext(data: nil, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 64,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
          let image = context.makeImage(), let destination = CGImageDestinationCreateWithData(bytes, "public.jpeg" as CFString, 1, nil) else { throw OfflineFailure.unavailable }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw OfflineFailure.unavailable }
    return bytes as Data
}

private func hashLocalFile(_ url: URL, deadline: TimeInterval) throws -> Data {
    let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
    var hash = SHA256(), count = 0
    while let block = try handle.read(upToCount: 256 * 1024), !block.isEmpty {
        count += block.count
        guard count <= 128 * 1024 * 1024, offlineProofNow() < deadline else { throw OfflineFailure.storageLimit }
        hash.update(data: block)
    }
    return Data(hash.finalize())
}
@MainActor private func waitOfflineProgress(_ player: NativePlaybackController, after position: Double,
                                          deadline: TimeInterval) async throws {
    while offlineProofNow() < deadline {
        if player.snapshot.status == .failed { throw player.snapshot.failure ?? PlaybackFailure.decoder }
        if player.snapshot.position > position { return }
        try await Task.sleep(for: .milliseconds(100))
    }
    throw PlaybackFailure.decoder
}
