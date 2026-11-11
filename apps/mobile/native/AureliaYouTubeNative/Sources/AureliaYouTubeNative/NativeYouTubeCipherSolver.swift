import Foundation
import CryptoKit
import AureliaQuack
import AureliaPlaybackCore

/// Kotlin's mutable program is transferred only through this actor's single
/// physical worker slot. It is never used concurrently or returned to callers.
private final class ProgramBox: @unchecked Sendable {
    let key: Data
    let program: CompiledCipher
    init(key: Data, program: CompiledCipher) { self.key = key; self.program = program }
}

/// Cancellation does not release admission while native code is still running.
/// A Foundation worker does not inherit a Swift task's cancellation context.
private final class NativeWorkCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    func check() throws {
        lock.lock(); let value = cancelled; lock.unlock()
        if value { throw CancellationError() }
    }
}

public enum NativeCipherStep: String, Sendable {
    case compiled, unsupportedPlayer, invalidProgram, nativeFailure, solveFailed, solved
}

/// AOT-compiled restricted cipher interpreter; no JavaScriptCore/WebView/JVM.
/// Cancellation discards results but retains admission until the synchronous,
/// operation-budgeted native call returns. At most one player program is cached.
public actor NativeYouTubeCipherSolver: YouTubeCipherSolving {
    private var active = false
    private var cached: ProgramBox?
    private let diagnostic: @Sendable (NativeCipherStep) -> Void
    public init(diagnostic: @escaping @Sendable (NativeCipherStep) -> Void = { _ in }) { self.diagnostic = diagnostic }

    public func signatureTimestamp(playerJavaScript: Data) async throws -> Int? {
        try await perform(playerJavaScript) { box in
            box.program.signatureTimestamp.map { Int($0.intValue) }
        }
    }

    public func solve(playerJavaScript: Data, signature: String?, n: String?, videoID: String) async throws -> YouTubeCipherSolution {
        guard videoID.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil,
              signature != nil || n != nil, Self.validChallenge(signature), Self.validChallenge(n) else {
            throw PlaybackFailure.invalidSource
        }
        let diagnostic = self.diagnostic
        return try await perform(playerJavaScript) { box in
            let result = box.program.solve(signature: signature, n: n)
            guard result.status == .ok,
                  (signature == nil) == (result.signature == nil),
                  (n == nil) == (result.n == nil),
                  Self.validOutput(result.signature), Self.validOutput(result.n) else {
                diagnostic(.solveFailed)
                throw PlaybackFailure.scriptRequired
            }
            diagnostic(.solved)
            return YouTubeCipherSolution(signature: result.signature, n: result.n)
        }
    }

    private func perform<Value: Sendable>(
        _ data: Data, operation: @escaping @Sendable (ProgramBox) throws -> Value
    ) async throws -> Value {
        try Task.checkCancellation()
        guard !active else { throw PlaybackFailure.busy }
        guard !data.isEmpty, data.count <= 8 * 1024 * 1024,
              let source = String(data: data, encoding: .utf8), source.utf16.count <= 8 * 1024 * 1024 else {
            throw PlaybackFailure.invalidResponse
        }
        active = true
        defer { active = false }
        let key = Data(SHA256.hash(data: data))
        let existing = cached?.key == key ? cached : nil
        let diagnostic = self.diagnostic
        let cancellation = NativeWorkCancellation()
        let result = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(ProgramBox, Value), Error>) in
                // Kotlin's recursive interpreter has finite depth budgets, but
                // those depths exceed an iOS cooperative worker's small stack.
                // One admitted, explicitly bounded stack prevents SIGBUS before
                // the interpreter can enforce its own limits.
                let worker = Thread {
                    let result: Result<(ProgramBox, Value), Error> = autoreleasepool {
                        Result {
                            try Self.runNative(source: source, key: key, existing: existing,
                                diagnostic: diagnostic, checkCancellation: { try cancellation.check() }, operation: operation)
                        }
                    }
                    continuation.resume(with: result)
                }
                worker.name = "Aurelia native source"
                worker.stackSize = 8 * 1024 * 1024
                worker.qualityOfService = .userInitiated
                worker.start()
            }
        } onCancel: { cancellation.cancel() }
        try Task.checkCancellation()
        cached = result.0
        return result.1
    }

    /// This synchronous CPU section has a concrete worker-thread lifetime;
    /// Swift async tasks themselves may otherwise resume on different threads.
    private nonisolated static func runNative<Value: Sendable>(
        source: String, key: Data, existing: ProgramBox?,
        diagnostic: @Sendable (NativeCipherStep) -> Void,
        checkCancellation: @Sendable () throws -> Void,
        operation: @Sendable (ProgramBox) throws -> Value
    ) throws -> (ProgramBox, Value) {
        try checkCancellation()
        guard !Thread.isMainThread else { throw PlaybackFailure.unavailable }
        let box: ProgramBox
        if let existing { box = existing }
        else {
            let result = QuackCipherFactory.shared.compile(playerJavaScript: source)
            guard result.status == .ok, let program = result.program else {
                switch result.status {
                case .unsupportedPlayer: diagnostic(.unsupportedPlayer)
                case .invalidInput: diagnostic(.invalidProgram)
                default: diagnostic(.nativeFailure)
                }
                throw PlaybackFailure.scriptRequired
            }
            diagnostic(.compiled)
            box = ProgramBox(key: key, program: program)
        }
        try checkCancellation()
        let value = try operation(box)
        try checkCancellation()
        return (box, value)
    }

    private nonisolated static func validChallenge(_ value: String?) -> Bool {
        value.map { !$0.isEmpty && $0.utf16.count <= 16_384 } ?? true
    }
    private nonisolated static func validOutput(_ value: String?) -> Bool {
        value.map { !$0.isEmpty && $0.utf16.count <= 65_536 } ?? true
    }
}

public enum NativeYouTubeSourceFactory {
    public static func makeResolver(
        sourceDiagnostic: (@Sendable (YouTubeSourceStep) -> Void)? = nil,
        httpDiagnostic: (@Sendable (YouTubeHTTPDiagnostic) -> Void)? = nil,
        cipherDiagnostic: (@Sendable (NativeCipherStep) -> Void)? = nil
    ) -> any PlaybackResolving {
        // Leave five seconds for cooperative cancellation/cleanup before the
        // composed playback controller's 30-second resolution deadline.
        PortableYouTubeResolver(transport: PlayerSourceHTTP(diagnostic: httpDiagnostic),
            cipherSolver: NativeYouTubeCipherSolver(diagnostic: cipherDiagnostic ?? { _ in }),
            deadline: 25, diagnostic: sourceDiagnostic ?? { _ in })
    }
}
