import Foundation

/// Bounded RAM storage for bytes already validated by the owning stream lease.
/// The owner must clear this value when that lease is renewed or invalidated.
/// This type performs no I/O and retains no locator or media metadata.
public struct ValidatedMediaRangeCache {
    public static let maximumCapacityBytes = 8 * 1024 * 1024
    public static let maximumReadBytes = 256 * 1024
    public static let maximumEntries = 256

    private struct Entry {
        let range: ClosedRange<Int>
        let data: Data
    }

    private let capacityBytes: Int
    // Oldest first. Array order avoids a recency counter that could overflow.
    private var entries: [Entry] = []
    public private(set) var byteCount = 0
    public var entryCount: Int { entries.count }

    /// A zero or negative budget disables storage. Larger budgets are capped.
    public init(capacityBytes: Int = ValidatedMediaRangeCache.maximumCapacityBytes) {
        self.capacityBytes = max(0, min(capacityBytes, Self.maximumCapacityBytes))
    }

    /// Takes an owned copy of one fully validated range, or leaves storage intact.
    /// Bytes must belong to the same immutable stream as all existing entries.
    @discardableResult
    public mutating func insert(_ data: Data, range: ClosedRange<Int>) -> Bool {
        guard let count = Self.byteCount(in: range),
              count == data.count,
              count <= capacityBytes else { return false }

        // Replacement avoids retaining duplicate ranges from concurrent misses.
        if let existing = entries.firstIndex(where: { $0.range == range }) {
            byteCount -= entries.remove(at: existing).data.count
        }
        while entries.count >= Self.maximumEntries || byteCount > capacityBytes - count {
            byteCount -= entries.removeFirst().data.count
        }

        // Data slices and bytesNoCopy inputs may share larger or mutable storage.
        let owned = data.withUnsafeBytes { bytes in
            Data(bytes: bytes.baseAddress!, count: bytes.count)
        }
        entries.append(Entry(range: range, data: owned))
        byteCount += count
        return true
    }

    /// Returns a separately owned, complete range of at most 256 KiB.
    /// A gap is a miss, even if other portions are cached, and does not change LRU.
    public mutating func read(_ range: ClosedRange<Int>) -> Data? {
        guard let count = Self.byteCount(in: range),
              count <= Self.maximumReadBytes else { return nil }

        var result = Data()
        result.reserveCapacity(count)
        var cursor = range.lowerBound
        var used = Set<Int>()

        while true {
            // Prefer the entry extending furthest from this cursor. This permits
            // arbitrary overlapping and adjacent ranges without storing a merge.
            var selected: Int?
            for index in entries.indices {
                let candidate = entries[index].range
                guard candidate.contains(cursor) else { continue }
                if let previous = selected,
                   entries[previous].range.upperBound > candidate.upperBound { continue }
                selected = index
            }
            guard let selected else { return nil }

            let entry = entries[selected]
            let end = min(entry.range.upperBound, range.upperBound)
            let offset = cursor - entry.range.lowerBound
            let segmentCount = end - cursor + 1
            result.append(entry.data.subdata(in: offset..<(offset + segmentCount)))
            used.insert(selected)

            if end == range.upperBound { break }
            // Here end < the valid requested upper bound, so +1 cannot overflow.
            cursor = end + 1
        }

        let touched = entries.indices.filter { used.contains($0) }.map { entries[$0] }
        entries = entries.indices.filter { !used.contains($0) }.map { entries[$0] } + touched
        return result
    }

    public mutating func removeAll() {
        entries.removeAll(keepingCapacity: false)
        byteCount = 0
    }

    private static func byteCount(in range: ClosedRange<Int>) -> Int? {
        guard range.lowerBound >= 0, range.upperBound >= range.lowerBound else { return nil }
        let (distance, subtractionOverflow) = range.upperBound.subtractingReportingOverflow(
            range.lowerBound
        )
        guard !subtractionOverflow else { return nil }
        let (count, additionOverflow) = distance.addingReportingOverflow(1)
        return additionOverflow ? nil : count
    }
}
