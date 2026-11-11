import Foundation
@preconcurrency import AVFoundation

/// Byte reads use the same guard during playback and seeks, not only preflight.
/// Injected transports must preserve BoundedYouTubeHTTP's refusal of redirects.
/// Requests retain their admission slot until the underlying operation returns,
/// even if a mock or an underlying implementation ignores cancellation.
public actor GuardedYouTubeByteSource {
    public static let maximumChunkBytes = 256 * 1024
    public static let maximumConcurrentRequests = 4
    private var lease: VerifiedYouTubeStreamLease
    private let transport: any YouTubeHTTPTransport
    private let now: @Sendable () -> Date
    private var requests: [UUID: Task<BoundedHTTPResponse, Error>] = [:]
    private var generation: UInt64 = 0
    private var invalidated = false
    private var cache = ValidatedMediaRangeCache()

    public init(
        lease: VerifiedYouTubeStreamLease,
        transport: any YouTubeHTTPTransport = BoundedYouTubeHTTP(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.lease = lease; self.transport = transport; self.now = now
    }

    deinit { requests.values.forEach { $0.cancel() } }

    public func read(_ range: ClosedRange<Int>) async throws -> Data {
        try Task.checkCancellation()
        guard !invalidated else { throw PlaybackFailure.staleRequest }
        let time = now()
        guard time.timeIntervalSince1970.isFinite, lease.expiresAt > time else { throw PlaybackFailure.expired }
        guard range.lowerBound >= 0, range.upperBound < lease.contentLength,
              range.upperBound - range.lowerBound < Self.maximumChunkBytes else {
            throw PlaybackFailure.invalidRequest
        }
        // Cache reads retain the same cancellation, lease and range boundaries.
        // Only fully validated responses from this lease enter RAM storage.
        if let bytes = cache.read(range) { return bytes }
        guard requests.count < Self.maximumConcurrentRequests else { throw PlaybackFailure.busy }
        let admittedGeneration = generation
        let length = range.upperBound - range.lowerBound + 1
        var request = URLRequest(url: lease.url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("bytes=\(range.lowerBound)-\(range.upperBound)", forHTTPHeaderField: "Range")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        request.setValue("audio/mp4", forHTTPHeaderField: "Accept")
        let transport = transport
        let task = Task { try await transport.request(request, maxBytes: length) }
        let id = UUID()
        requests[id] = task
        defer { requests[id] = nil }
        do {
            let response = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: { task.cancel() }
            try Task.checkCancellation()
            guard !invalidated, generation == admittedGeneration else { throw PlaybackFailure.staleRequest }
            guard lease.expiresAt > now() else { throw PlaybackFailure.expired }
            try PartialMediaSample.validate(response, expectedStart: range.lowerBound,
                                            expectedEnd: range.upperBound, expectedTotal: lease.contentLength)
            guard response.headers.keys.filter({ $0.caseInsensitiveCompare("content-encoding") == .orderedSame }).count <= 1,
                  response.headers.first(where: { $0.key.caseInsensitiveCompare("content-encoding") == .orderedSame })
                    .map({ $0.value.lowercased() == "identity" }) ?? true else { throw PlaybackFailure.invalidResponse }
            guard let rawLength = Self.singleHeader("content-length", in: response.headers),
                  VerifiedYouTubeStreamLease.decimal(rawLength) == length,
                  let mime = Self.singleHeader("content-type", in: response.headers),
                  Self.validResponseMIME(mime, lease: lease) else { throw PlaybackFailure.invalidResponse }
            cache.insert(response.body, range: range)
            return response.body
        } catch is CancellationError { throw CancellationError() }
        catch let failure as PlaybackFailure { throw failure }
        catch { throw PlaybackFailure.network }
    }

    public func renew(_ replacement: VerifiedYouTubeStreamLease) throws {
        guard !invalidated else { throw PlaybackFailure.staleRequest }
        try lease.validatingRenewal(replacement, now: now())
        cache.removeAll()
        generation &+= 1
        requests.values.forEach { $0.cancel() }
        lease = replacement
    }

    public func invalidate() {
        guard !invalidated else { return }
        invalidated = true; generation &+= 1
        cache.removeAll()
        requests.values.forEach { $0.cancel() }
    }

    /// AVFoundation requests use Int64 offsets and may extend beyond EOF. This
    /// pure conversion is also used by checks without constructing a player.
    public static func requestBounds(
        requestedOffset: Int64, currentOffset: Int64, requestedLength: Int,
        toEnd: Bool, contentLength: Int
    ) throws -> ClosedRange<Int>? {
        guard requestedOffset >= 0, currentOffset >= 0, requestedLength >= 0,
              requestedOffset <= Int64(Int.max), currentOffset <= Int64(Int.max),
              contentLength > 0 else { throw PlaybackFailure.invalidRequest }
        let start = max(Int(requestedOffset), Int(currentOffset))
        guard start < contentLength else { return nil }
        if toEnd { return start...(contentLength - 1) }
        let (exclusiveEnd, overflow) = Int(requestedOffset).addingReportingOverflow(requestedLength)
        guard !overflow else { throw PlaybackFailure.invalidRequest }
        let end = min(contentLength, exclusiveEnd)
        return start < end ? start...(end - 1) : nil
    }

    private static func singleHeader(_ name: String, in headers: [String: String]) -> String? {
        let values = headers.compactMap { key, value in
            key.caseInsensitiveCompare(name) == .orderedSame ? value : nil
        }
        return values.count == 1 ? values[0] : nil
    }

    private static func validResponseMIME(_ raw: String, lease: VerifiedYouTubeStreamLease) -> Bool {
        let mime = VerifiedYouTubeStreamLease.normalizedMIME(raw)
        return mime == "audio/mp4" || mime == VerifiedYouTubeStreamLease.normalizedMIME(lease.mimeType)
    }
}

/// AVFoundation callbacks and loading-request mutation are confined to MainActor.
/// AVAssetResourceLoader is explicitly configured on DispatchQueue.main. Async
/// network reads run in the separate actor above; AVPlayer never sees the CDN URL.
@MainActor
final class GuardedYouTubeResourceLoader: NSObject, @preconcurrency AVAssetResourceLoaderDelegate {
    let assetURL: URL
    private let source: GuardedYouTubeByteSource
    private let contentLength: Int
    private let diagnostic: (@MainActor (NativeMediaDiagnostic) -> Void)?
    private var jobs: [ObjectIdentifier: Task<Void, Never>] = [:]
    private var loading: [ObjectIdentifier: AVAssetResourceLoadingRequest] = [:]
    private var invalidated = false
    private var generation: UInt64 = 0
    var onFailure: (@MainActor (PlaybackFailure) -> Void)?

    init(lease: VerifiedYouTubeStreamLease, diagnostic: (@MainActor (NativeMediaDiagnostic) -> Void)? = nil) {
        self.diagnostic = diagnostic
        assetURL = URL(string: "aurelia-youtube://asset/\(UUID().uuidString).m4a")!
        source = GuardedYouTubeByteSource(lease: lease)
        contentLength = lease.contentLength
        super.init()
    }

    deinit {
        jobs.values.forEach { $0.cancel() }
        let source = source
        Task { await source.invalidate() }
    }

    func makeAsset() -> AVURLAsset {
        let asset = AVURLAsset(url: assetURL)
        asset.resourceLoader.setDelegate(self, queue: .main)
        return asset
    }

    func invalidate() {
        guard !invalidated else { return }
        invalidated = true; generation &+= 1; onFailure = nil
        let pending = Array(loading.values)
        loading.removeAll()
        jobs.values.forEach { $0.cancel() }; jobs.removeAll()
        pending.filter { !$0.isCancelled && !$0.isFinished }.forEach {
            $0.finishLoading(with: Self.safeError(.staleRequest))
        }
        let source = source
        Task { await source.invalidate() }
    }

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
    ) -> Bool {
        let requestedData = loadingRequest.dataRequest
        diagnostic?(.loading(offset: requestedData?.requestedOffset ?? 0, length: requestedData?.requestedLength ?? 0,
                             toEnd: requestedData?.requestsAllDataToEndOfResource ?? false,
                             information: loadingRequest.contentInformationRequest != nil))
        guard !invalidated, loadingRequest.request.url == assetURL else {
            if !loadingRequest.isCancelled && !loadingRequest.isFinished {
                loadingRequest.finishLoading(with: Self.safeError(.invalidSource))
            }
            diagnostic?(.failure(.invalidSource)); return true
        }
        guard jobs.count < GuardedYouTubeByteSource.maximumConcurrentRequests else {
            loadingRequest.finishLoading(with: Self.safeError(.busy))
            diagnostic?(.failure(.busy)); return true
        }
        if let info = loadingRequest.contentInformationRequest {
            let allowed = info.allowedContentTypes
            diagnostic?(.contentTypes(m4a: allowed?.contains(AVFileType.m4a.rawValue) ?? false,
                                      mp4: allowed?.contains(AVFileType.mp4.rawValue) ?? false,
                                      mpeg4Audio: allowed?.contains("public.mpeg-4-audio") ?? false,
                                      unrestricted: allowed?.isEmpty ?? true))
            // The callback may synchronously release ownership. It must not
            // let the continuation mutate a cancelled or finished request.
            guard !invalidated, !loadingRequest.isCancelled, !loadingRequest.isFinished else {
                if !loadingRequest.isCancelled && !loadingRequest.isFinished {
                    loadingRequest.finishLoading(with: Self.safeError(.staleRequest))
                }
                return true
            }
            // Negotiate AVFoundation's supported container identifiers for
            // this audio-only ISO-MP4 recording.
            let candidates = [AVFileType.m4a.rawValue, AVFileType.mp4.rawValue]
            if let allowed, !allowed.isEmpty {
                guard let selected = candidates.first(where: allowed.contains) else {
                    loadingRequest.finishLoading(with: Self.safeError(.unavailable))
                    diagnostic?(.failure(.unavailable)); onFailure?(.unavailable)
                    return true
                }
                info.contentType = selected
            } else { info.contentType = AVFileType.m4a.rawValue }
            info.contentLength = Int64(contentLength)
            info.isByteRangeAccessSupported = true
        }
        guard let data = loadingRequest.dataRequest else {
            loadingRequest.finishLoading(); return true
        }
        let id = ObjectIdentifier(loadingRequest)
        guard jobs[id] == nil else { return true }
        let admittedGeneration = generation
        loading[id] = loadingRequest
        jobs[id] = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.jobs[id] = nil; self.loading[id] = nil }
            do {
                let bounds = try GuardedYouTubeByteSource.requestBounds(
                    requestedOffset: data.requestedOffset, currentOffset: data.currentOffset,
                    requestedLength: data.requestedLength,
                    toEnd: data.requestsAllDataToEndOfResource, contentLength: self.contentLength
                )
                if let bounds {
                    var offset = bounds.lowerBound
                    while offset <= bounds.upperBound {
                        try Task.checkCancellation()
                        guard self.isCurrent(loadingRequest, generation: admittedGeneration) else { return }
                        let end = min(bounds.upperBound, offset + GuardedYouTubeByteSource.maximumChunkBytes - 1)
                        let bytes = try await self.source.read(offset...end)
                        try Task.checkCancellation()
                        guard self.isCurrent(loadingRequest, generation: admittedGeneration) else { return }
                        data.respond(with: bytes)
                        self.diagnostic?(.delivered(bytes.count))
                        offset = end + 1
                    }
                }
                guard self.isCurrent(loadingRequest, generation: admittedGeneration) else { return }
                loadingRequest.finishLoading()
            } catch {
                guard self.isCurrent(loadingRequest, generation: admittedGeneration) else { return }
                let failure = (error as? PlaybackFailure) ?? .network
                loadingRequest.finishLoading(with: Self.safeError(failure))
                self.diagnostic?(.failure(failure))
                self.onFailure?(failure)
            }
        }
        return true
    }

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        didCancel loadingRequest: AVAssetResourceLoadingRequest
    ) {
        let id = ObjectIdentifier(loadingRequest)
        jobs[id]?.cancel()
        // Keep the job and its admission slot until its transport has returned.
        loading[id] = nil
        diagnostic?(.cancelled)
    }

    private func isCurrent(_ request: AVAssetResourceLoadingRequest, generation: UInt64) -> Bool {
        !invalidated && self.generation == generation && !request.isCancelled && !request.isFinished
            && loading[ObjectIdentifier(request)] != nil
    }

    private static func safeError(_ failure: PlaybackFailure) -> NSError {
        // No underlying error/userInfo: URLSession and AVFoundation errors may
        // otherwise retain a signed locator in their diagnostic metadata.
        NSError(domain: "AureliaPlayback", code: failure == .expired ? 2 : 1,
                userInfo: [NSLocalizedDescriptionKey: failure.rawValue])
    }
}
