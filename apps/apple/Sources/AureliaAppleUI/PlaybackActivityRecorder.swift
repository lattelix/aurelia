import Foundation
import Combine
import CryptoKit
import AureliaCloud
import AureliaPlaybackCore

/// Bounded metadata outbox: offline listens can sync when this same account
/// next connects. Restoring/preparing/seeking alone never creates a listen.
@MainActor final class PlaybackActivityRecorder: ObservableObject {
    private struct Event: Codable {
        var id: UUID
        var trackID: String
        var completion: Double
        var signal: CloudSignalKind?
        var createdAt: Date
        private enum CodingKeys: CodingKey { case id, trackID, completion, signal, createdAt }
        init(id: UUID, trackID: String, completion: Double, signal: CloudSignalKind?) {
            self.id = id; self.trackID = trackID; self.completion = completion; self.signal = signal; createdAt = Date()
        }
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            id = try values.decode(UUID.self, forKey: .id); trackID = try values.decode(String.self, forKey: .trackID)
            completion = try values.decode(Double.self, forKey: .completion)
            signal = try values.decodeIfPresent(String.self, forKey: .signal).flatMap(CloudSignalKind.init(rawValue:))
            createdAt = try values.decode(Date.self, forKey: .createdAt)
        }
        func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(id, forKey: .id); try values.encode(trackID, forKey: .trackID)
            try values.encode(completion, forKey: .completion); try values.encodeIfPresent(signal?.rawValue, forKey: .signal)
            try values.encode(createdAt, forKey: .createdAt)
        }
    }
    private var owner: String?
    private var occurrence: UUID?
    private var playID = UUID()
    private var trackID: String?
    private var lastPosition: Double = 0
    private var listened: Double = 0
    private var duration: Double = 0
    private var wasPlaying = false
    private var lastStatus: PlaybackStatus = .idle
    private var lastObservation: TimeInterval?
    private var lastQueuedCompletion: Double = -1
    private var finished = false
    private var events: [Event] = []
    private var flushTask: Task<Void, Never>?
    private var flushToken = UUID()
    private let defaults: UserDefaults?
    private let monotonicNow: @Sendable () -> TimeInterval
    init(defaults: UserDefaults? = .standard,
         monotonicNow: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.defaults = defaults; self.monotonicNow = monotonicNow
    }
    deinit { flushTask?.cancel() }

    func accept(_ snapshot: PlaybackSnapshot, cloud: CloudAccountStore?) {
        let currentOwner = cloud?.authorizedOwnerID
        if currentOwner != owner {
            flushTask?.cancel(); flushTask = nil; flushToken = UUID(); owner = currentOwner
            reset(); load()
        }
        guard let cloud, owner != nil else { return }
        // Repeat-one reuses a queue UUID. A native reload at zero after an
        // ended/playing cycle starts a new listen; an ordinary seek keeps the
        // current status and cannot manufacture that boundary.
        let replay = snapshot.currentTrack?.id == occurrence && snapshot.status == .loading && snapshot.position == 0 &&
            (lastStatus == .ended || (wasPlaying && lastPosition > 0))
        if snapshot.currentTrack?.id != occurrence || replay {
            finish()
            reset(); occurrence = snapshot.currentTrack?.id; trackID = snapshot.currentTrack?.trackID
            lastPosition = snapshot.position
        }
        defer { lastStatus = snapshot.status }
        let instant = monotonicNow()
        let elapsed: TimeInterval
        if instant.isFinite, let previous = lastObservation, instant >= previous {
            elapsed = min(2, max(0, instant - previous))
        } else { elapsed = 0 }
        lastObservation = instant.isFinite ? instant : nil
        guard snapshot.currentTrack?.provider != .device else { wasPlaying = false; trackID = nil; flush(cloud); return }
        if snapshot.duration.isFinite, snapshot.duration > 0 { duration = snapshot.duration }
        let delta = snapshot.position - lastPosition
        if wasPlaying && snapshot.status == .playing && delta > 0 && delta <= 2 {
            // Count neither suspended/paused wall time nor position jumps in
            // excess of actual monotonic time between observations.
            listened += min(delta, elapsed)
        }
        lastPosition = snapshot.position; wasPlaying = snapshot.status == .playing
        if listened >= 10 { saveEvent(signal: nil) }
        if snapshot.status == .ended { finish() }
        flush(cloud)
    }
    func foreground(cloud: CloudAccountStore?) {
        guard let cloud, cloud.authorizedOwnerID == owner else { return }
        flush(cloud)
    }
    private func reset() {
        occurrence = nil; trackID = nil; playID = UUID(); listened = 0; duration = 0; lastPosition = 0; wasPlaying = false
        lastStatus = .idle; lastObservation = nil
        lastQueuedCompletion = -1; finished = false
    }
    private func finish() {
        guard listened >= 5, !finished else { return }
        finished = true
        saveEvent(signal: duration > 0 && listened / duration >= 0.9 ? .complete : .skip)
    }
    private func saveEvent(signal: CloudSignalKind?) {
        guard let id = trackID, owner != nil else { return }
        let fraction = duration > 0 ? min(1, listened / duration) : 0
        guard signal != nil || lastQueuedCompletion < 0 || fraction - lastQueuedCompletion >= 0.1 else { return }
        lastQueuedCompletion = fraction
        if let i = events.firstIndex(where: { $0.id == playID }) {
            // Avoid a disk write every half-second; update at 10% boundaries.
            events[i].completion = max(events[i].completion, fraction)
            if let signal { events[i].signal = signal }
        } else { events.append(Event(id: playID, trackID: id, completion: fraction, signal: signal)) }
        events = Array(events.suffix(100)); persist()
    }
    private var key: String? {
        owner.map { "aurelia.native.listening-outbox.v1." + SHA256.hash(data: Data($0.utf8)).map { String(format: "%02x", $0) }.joined() }
    }
    private func load() {
        events = []
        guard let key, let data = defaults?.data(forKey: key), data.count <= 64 * 1024,
              let stored = try? JSONDecoder().decode([Event].self, from: data), stored.count <= 100 else { return }
        events = stored.filter {
            ($0.trackID.range(of: "^youtube:[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil || StudioCatalogue.track($0.trackID) != nil)
            && $0.completion.isFinite && (0...1).contains($0.completion) && Date().timeIntervalSince($0.createdAt) < 30 * 86400
        }
    }
    private func persist() { if let key, let data = try? JSONEncoder().encode(events), data.count <= 64 * 1024 { defaults?.set(data, forKey: key) } }
    private func flush(_ cloud: CloudAccountStore) {
        guard flushTask == nil, let captured = owner, cloud.phase == .signedIn, !events.isEmpty else { return }
        let token = UUID(); flushToken = token
        flushTask = Task { [weak self, weak cloud] in
            guard let self, let cloud else { return }
            defer { if self.flushToken == token { self.flushTask = nil } }
            // One finite pass. Failed sends wait for a later real user activity.
            for event in self.events.prefix(100) {
                guard !Task.isCancelled, self.owner == captured, cloud.authorizedOwnerID == captured else { return }
                guard await cloud.recordHistory(trackID: event.trackID, playID: event.id, completion: event.completion, expectedAccountID: captured) else { return }
                if let signal = event.signal {
                    guard await cloud.recordSignal(signal, trackID: event.trackID, value: event.completion, expectedAccountID: captured) else { return }
                }
                guard !Task.isCancelled, self.owner == captured else { return }
                // Preserve a newer completion queued while the request was in flight.
                self.events.removeAll { $0.id == event.id && $0.completion <= event.completion && $0.signal?.rawValue == event.signal?.rawValue }
                self.persist()
            }
        }
    }
}
