import Foundation
import AureliaPlaybackCore

private enum ValidatedRangeCacheCheckFailure: Error { case assertion }

private func requireCache(_ condition: @autoclosure () -> Bool) throws {
    guard condition() else { throw ValidatedRangeCacheCheckFailure.assertion }
}

private func cacheBytes(_ values: [UInt8]) -> Data { Data(values) }

func checkValidatedRangeCacheCoverage() throws {
    var cache = ValidatedMediaRangeCache(capacityBytes: 32)
    try requireCache(cache.insert(cacheBytes([4, 5, 6, 7]), range: 4...7))
    try requireCache(cache.insert(cacheBytes([0, 1, 2, 3, 4]), range: 0...4))
    try requireCache(cache.insert(cacheBytes([7, 8, 9]), range: 7...9))
    try requireCache(cache.read(0...9) == cacheBytes(Array(0...9)))
    try requireCache(cache.read(2...8) == cacheBytes(Array(2...8)))
    try requireCache(cache.read(5...5) == cacheBytes([5]))
    try requireCache(cache.read(0...10) == nil)
    try requireCache(cache.read(10...10) == nil)

    cache.removeAll()
    try requireCache(cache.insert(cacheBytes([0, 1]), range: 0...1))
    try requireCache(cache.insert(cacheBytes([3, 4]), range: 3...4))
    try requireCache(cache.read(0...4) == nil)
    try requireCache(cache.insert(cacheBytes([2]), range: 2...2))
    try requireCache(cache.read(0...4) == cacheBytes(Array(0...4)))
}

func checkValidatedRangeCacheBounds() throws {
    var cache = ValidatedMediaRangeCache(capacityBytes: 4)
    try requireCache(cache.insert(cacheBytes([1, 2]), range: 0...1))
    try requireCache(!cache.insert(Data(), range: 2...2))
    try requireCache(!cache.insert(cacheBytes([3]), range: -1 ... -1))
    try requireCache(!cache.insert(cacheBytes([3]), range: Int.min...Int.max))
    try requireCache(!cache.insert(cacheBytes([3]), range: 0...Int.max))
    try requireCache(!cache.insert(Data(repeating: 3, count: 5), range: 2...6))
    try requireCache(cache.read(-1...0) == nil)
    try requireCache(cache.read(0...Int.max) == nil)
    try requireCache(cache.byteCount == 2 && cache.entryCount == 1)
    try requireCache(cache.read(0...1) == cacheBytes([1, 2]))
    try requireCache(cache.insert(cacheBytes([9]), range: Int.max...Int.max))
    try requireCache(cache.read(Int.max...Int.max) == cacheBytes([9]))

    let maximum = ValidatedMediaRangeCache.maximumReadBytes
    var large = ValidatedMediaRangeCache()
    try requireCache(large.insert(Data(repeating: 6, count: maximum + 1), range: 0...maximum))
    try requireCache(large.read(0...(maximum - 1)) == Data(repeating: 6, count: maximum))
    try requireCache(large.read(0...maximum) == nil)
    let tooLarge = ValidatedMediaRangeCache.maximumCapacityBytes + 1
    try requireCache(!large.insert(Data(repeating: 7, count: tooLarge), range: 0...(tooLarge - 1)))

    for budget in [0, -1, Int.min] {
        var disabled = ValidatedMediaRangeCache(capacityBytes: budget)
        try requireCache(!disabled.insert(cacheBytes([1]), range: 0...0))
        try requireCache(disabled.byteCount == 0 && disabled.entryCount == 0)
    }
    var capped = ValidatedMediaRangeCache(capacityBytes: Int.max)
    try requireCache(!capped.insert(Data(repeating: 7, count: tooLarge), range: 0...(tooLarge - 1)))
    try requireCache(capped.byteCount == 0 && capped.entryCount == 0)
}

func checkValidatedRangeCacheLRU() throws {
    var cache = ValidatedMediaRangeCache(capacityBytes: 6)
    try requireCache(cache.insert(cacheBytes([0, 1, 2]), range: 0...2))
    try requireCache(cache.insert(cacheBytes([3, 4, 5]), range: 3...5))
    try requireCache(cache.read(0...1) == cacheBytes([0, 1]))
    try requireCache(cache.insert(cacheBytes([6, 7, 8]), range: 6...8))
    try requireCache(cache.read(3...5) == nil)
    try requireCache(cache.read(0...2) == cacheBytes([0, 1, 2]))
    try requireCache(cache.byteCount == 6 && cache.entryCount == 2)

    var assembled = ValidatedMediaRangeCache(capacityBytes: 8)
    for start in stride(from: 0, to: 8, by: 2) {
        try requireCache(assembled.insert(
            cacheBytes([UInt8(start), UInt8(start + 1)]), range: start...(start + 1)
        ))
    }
    try requireCache(assembled.read(1...4) == cacheBytes(Array(1...4)))
    try requireCache(assembled.insert(cacheBytes([8, 9]), range: 8...9))
    try requireCache(assembled.read(6...7) == nil)
    try requireCache(assembled.read(0...5) == cacheBytes(Array(0...5)))

    var miss = ValidatedMediaRangeCache(capacityBytes: 4)
    try requireCache(miss.insert(cacheBytes([0, 1]), range: 0...1))
    try requireCache(miss.insert(cacheBytes([3, 4]), range: 3...4))
    try requireCache(miss.read(0...4) == nil)
    try requireCache(miss.insert(cacheBytes([5, 6]), range: 5...6))
    try requireCache(miss.read(0...1) == nil)
    try requireCache(miss.read(3...4) == cacheBytes([3, 4]))

    var replacement = ValidatedMediaRangeCache(capacityBytes: 4)
    try requireCache(replacement.insert(cacheBytes([0, 1]), range: 0...1))
    try requireCache(replacement.insert(cacheBytes([2, 3]), range: 2...3))
    try requireCache(replacement.insert(cacheBytes([0, 1]), range: 0...1))
    try requireCache(replacement.byteCount == 4 && replacement.entryCount == 2)
    try requireCache(replacement.insert(cacheBytes([4, 5]), range: 4...5))
    try requireCache(replacement.read(2...3) == nil)
    try requireCache(replacement.read(0...1) == cacheBytes([0, 1]))
}

func checkValidatedRangeCacheOwnershipAndReset() throws {
    let count = 4096
    let pointer = UnsafeMutableRawPointer.allocate(byteCount: count, alignment: 1)
    defer { pointer.deallocate() }
    pointer.initializeMemory(as: UInt8.self, repeating: 7, count: count)
    var source = Data(bytesNoCopy: pointer, count: count, deallocator: .none)
    var cache = ValidatedMediaRangeCache(capacityBytes: count)
    try requireCache(cache.insert(source, range: 100...(99 + count)))
    pointer.storeBytes(of: UInt8(9), as: UInt8.self)
    source[1] = 8
    try requireCache(cache.read(100...103) == Data(repeating: 7, count: 4))
    var result = cache.read(100...103)!
    result[0] = 0
    try requireCache(cache.read(100...103) == Data(repeating: 7, count: 4))

    var copy = cache
    cache.removeAll()
    try requireCache(cache.byteCount == 0 && cache.entryCount == 0)
    try requireCache(cache.read(100...103) == nil)
    try requireCache(copy.read(100...103) == Data(repeating: 7, count: 4))
    copy.removeAll()
    try requireCache(copy.insert(cacheBytes([3, 4]), range: 1...2))
    try requireCache(copy.byteCount == 2 && copy.entryCount == 1)
    try requireCache(copy.read(1...2) == cacheBytes([3, 4]))

    let parent = Data(repeating: 5, count: 1024)
    try requireCache(cache.insert(parent[100..<104], range: 5...8))
    try requireCache(cache.read(5...8) == Data(repeating: 5, count: 4))
}

func checkValidatedRangeCacheInvariants() throws {
    var entries = ValidatedMediaRangeCache(capacityBytes: 1024)
    for offset in 0..<600 {
        try requireCache(entries.insert(cacheBytes([UInt8(offset % 256)]), range: offset...offset))
        try requireCache(entries.byteCount == min(offset + 1, 256))
        try requireCache(entries.entryCount == min(offset + 1, 256))
    }
    try requireCache(entries.read(343...343) == nil)
    try requireCache(entries.read(344...599) == Data((344...599).map { UInt8($0 % 256) }))

    for budget in [1, 3, 7, 16, 31] {
        var cache = ValidatedMediaRangeCache(capacityBytes: budget)
        for offset in 0..<300 {
            let count = offset % (budget + 2) + 1
            let inserted = cache.insert(
                Data(repeating: UInt8(offset % 256), count: count),
                range: (offset * 40)...(offset * 40 + count - 1)
            )
            try requireCache(inserted == (count <= budget))
            try requireCache(cache.byteCount <= budget && cache.byteCount >= 0)
            try requireCache(cache.entryCount <= 256 && cache.entryCount >= 0)
            if inserted {
                try requireCache(cache.read((offset * 40)...(offset * 40 + count - 1))
                    == Data(repeating: UInt8(offset % 256), count: count))
            }
        }
    }
}
