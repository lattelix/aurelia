#if DEBUG && os(iOS)
import Foundation
import UIKit
import Darwin
import AureliaPlaybackCore

/// Callbacks may arrive from URLSession/native workers. Only these typed values
/// enter the locked log; row 128 is reserved for final aggregate counters.
private final class DeviceCheckDiagnostics: @unchecked Sendable {
    private let lock = NSLock()
    private let started: TimeInterval
    private var emitted = 0, dropped = 0
    private var finished = false
    private var responses = 0, redirects = 0, loading = 0, cancelled = 0
    private var delivered: Int64 = 0
    private var status: Int?
    private var failure: PlaybackFailure?
    private var errorDomain: NativeMediaErrorDomain?
    private var errorCode: Int?

    init(started: TimeInterval) { self.started = started }

    func activation(state: Int, ready: Bool) {
        lock.lock(); defer { lock.unlock() }
        guard !finished else { return }
        emit(["component": "application", "event": ready ? "active" : "waiting", "applicationState": state])
    }
    func source(_ step: YouTubeSourceStep) {
        lock.lock(); defer { lock.unlock() }
        guard !finished else { return }
        emit(["component": "source", "step": step.rawValue])
    }
    func cipher(_ step: NativeCipherStep) {
        lock.lock(); defer { lock.unlock() }
        guard !finished else { return }
        emit(["component": "cipher", "step": step.rawValue])
    }
    func http(_ observation: YouTubeHTTPDiagnostic) {
        lock.lock(); defer { lock.unlock() }
        guard !finished else { return }
        switch observation {
        case .response(let code):
            responses += 1
            emit(["component": "http", "event": "response", "status": code])
        case .redirect(let code):
            redirects += 1
            emit(["component": "http", "event": "redirect", "status": code])
        }
    }
    func media(_ observation: NativeMediaDiagnostic, applicationState: Int) {
        lock.lock(); defer { lock.unlock() }
        guard !finished else { return }
        var values: [String: Any] = ["component": "media", "applicationState": applicationState]
        switch observation {
        case .loading(let offset, let length, let toEnd, let information):
            loading += 1
            values.merge(["event": "loading", "offsetBytes": offset, "requestedBytes": length,
                          "toEnd": toEnd ? 1 : 0, "information": information ? 1 : 0]) { _, new in new }
        case .contentTypes(let m4a, let mp4, let audio, let unrestricted):
            values.merge(["event": "contentTypes", "m4a": m4a ? 1 : 0, "mp4": mp4 ? 1 : 0,
                          "mpeg4Audio": audio ? 1 : 0, "unrestricted": unrestricted ? 1 : 0]) { _, new in new }
        case .delivered(let count):
            delivered += Int64(max(0, count))
            values.merge(["event": "delivered", "bytes": count]) { _, new in new }
        case .cancelled:
            cancelled += 1; values["event"] = "cancelled"
        case .failure(let reason):
            failure = reason; values["event"] = "failure"; values["reason"] = reason.rawValue
        case .status(let code):
            status = code; values["event"] = "status"; values["status"] = code
        case .error(let domain, let code):
            errorDomain = domain; errorCode = code
            values["event"] = "error"; values["errorDomain"] = domain.rawValue; values["errorCode"] = code
        }
        emit(values)
    }
    func finish() {
        lock.lock(); defer { lock.unlock() }
        guard !finished else { return }
        finished = true
        var values: [String: Any] = ["component": "summary", "eventsDropped": dropped,
            "httpResponses": responses, "httpRedirects": redirects, "loaderRequests": loading,
            "loaderDeliveredBytes": delivered, "loaderCancelled": cancelled]
        if let status { values["mediaStatus"] = status }
        if let failure { values["reason"] = failure.rawValue }
        if let errorDomain { values["errorDomain"] = errorDomain.rawValue }
        if let errorCode { values["errorCode"] = errorCode }
        write(values)
    }
    private func emit(_ values: [String: Any]) {
        guard emitted < 127 else { dropped += 1; return }
        write(values)
    }
    private func write(_ fields: [String: Any]) {
        guard emitted < 128 else { return }
        emitted += 1
        var values = fields
        values["sequence"] = emitted
        values["elapsedMs"] = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
        if let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]) {
            print("AURELIA_SOURCE_DIAGNOSTIC " + String(decoding: data, as: UTF8.self))
            fflush(nil)
        }
    }
}

/// Explicit, finite, muted development check. It never uses the app's account,
/// library, persisted queue or system transport controls. Not in release builds.
@MainActor public enum NativeDevicePlaybackCheck {
    private static var hasStarted = false
    public static func run() async {
        guard ProcessInfo.processInfo.arguments.contains("--native-source-proof"),
              ProcessInfo.processInfo.arguments.contains("--force-muted"), !hasStarted else { return }
        hasStarted = true
        let started = ProcessInfo.processInfo.systemUptime
        let proofDeadline = started + 135
        let diagnostics = DeviceCheckDiagnostics(started: started)
        let resolver = NativeYouTubeSourceFactory.makeResolver(
            sourceDiagnostic: { diagnostics.source($0) }, httpDiagnostic: { diagnostics.http($0) },
            cipherDiagnostic: { diagnostics.cipher($0) })
        let controller = NativePlaybackController(resolver: resolver,
            driver: AVPlayerDriver(volume: 0, diagnostic: {
                diagnostics.media($0, applicationState: UIApplication.shared.applicationState.rawValue)
            }))
        defer { controller.dispose(); diagnostics.finish() }
        func emit(_ phase: String, reason: String? = nil) {
            var values: [String: Any] = ["phase": phase,
                "elapsedMs": Int((ProcessInfo.processInfo.systemUptime - started) * 1000),
                "positionMs": Int(controller.snapshot.position * 1000),
                "applicationState": UIApplication.shared.applicationState.rawValue]
            if let reason { values["reason"] = reason }
            if let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]) {
                print("AURELIA_SOURCE_CHECK " + String(decoding: data, as: UTF8.self))
                fflush(nil)
            }
        }
        do {
            if UIApplication.shared.applicationState != .active {
                diagnostics.activation(state: UIApplication.shared.applicationState.rawValue, ready: false)
            }
            try await waitUntilActive()
            diagnostics.activation(state: UIApplication.shared.applicationState.rawValue, ready: true)
            emit("started")
            let track = try PlaybackTrack(videoID: "aqz-KE-bpKQ", title: "Public CC source check", artist: "Blender Foundation")
            try controller.setQueue([track], playing: true)
            try await wait(controller, after: 1, deadline: proofDeadline)
            emit("progress")
            controller.seek(to: 30)
            try await wait(controller, after: 30.5, deadline: proofDeadline)
            emit("seek")
            let baseline = controller.snapshot.position
            emit("background_window")
            guard proofDeadline - ProcessInfo.processInfo.systemUptime >= 15 else { throw PlaybackFailure.decoder }
            try await Task.sleep(for: .seconds(15))
            try Task.checkCancellation()
            guard ProcessInfo.processInfo.systemUptime < proofDeadline else { throw PlaybackFailure.decoder }
            guard controller.snapshot.status != .failed,
                  controller.snapshot.position > baseline + 8 else { throw controller.snapshot.failure ?? PlaybackFailure.decoder }
            emit("continued")
            controller.pause()
            emit("passed")
        } catch {
            emit("failed", reason: error is CancellationError ? "cancelled" : ((error as? PlaybackFailure)?.rawValue ?? "network"))
        }
    }

    private static func waitUntilActive() async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 15
        while UIApplication.shared.applicationState != .active {
            try Task.checkCancellation()
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw PlaybackFailure.unavailable }
            try await Task.sleep(for: .milliseconds(100))
        }
        try Task.checkCancellation()
    }

    private static func wait(_ controller: NativePlaybackController, after position: Double, deadline overall: TimeInterval) async throws {
        let deadline = min(overall, ProcessInfo.processInfo.systemUptime + 60)
        while ProcessInfo.processInfo.systemUptime < deadline {
            try Task.checkCancellation()
            if controller.snapshot.status == .failed { throw controller.snapshot.failure ?? .decoder }
            if controller.snapshot.position > position { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw PlaybackFailure.decoder
    }
}
#endif
