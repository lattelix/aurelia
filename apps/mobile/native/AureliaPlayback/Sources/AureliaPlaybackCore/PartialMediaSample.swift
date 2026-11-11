import Foundation

/// Validates one bounded byte-range response without retaining or exposing its URL.
public enum PartialMediaSample {
    private struct ParsedContentRange {
        let start: Int
        let end: Int
        let total: Int
    }

    private enum HeaderValue {
        case absent
        case present(String)
        case ambiguous
    }

    private enum FieldState: String {
        case absent, match, valid, invalid, mismatch
    }

    public static func validate(
        _ response: BoundedHTTPResponse,
        expectedStart: Int,
        expectedEnd: Int,
        expectedTotal: Int
    ) throws {
        guard let expectedBytes = expectedByteCount(start: expectedStart, end: expectedEnd),
              expectedTotal > expectedEnd,
              response.status == 206,
              response.body.count == expectedBytes,
              contentRangeState(
                response.headers,
                expectedStart: expectedStart,
                expectedEnd: expectedEnd,
                expectedTotal: expectedTotal
              ) == .match else {
            throw PlaybackFailure.invalidResponse
        }
        let length = contentLengthState(response.headers, expectedBytes: expectedBytes)
        guard length == .absent || length == .match else {
            throw PlaybackFailure.invalidResponse
        }
    }

    /// Parses the single explicit byte range emitted by this package.
    public static func requestedRange(_ value: String?) -> ClosedRange<Int>? {
        guard let value else { return nil }
        let pieces = value.split(separator: "=", omittingEmptySubsequences: false)
        guard pieces.count == 2, pieces[0].lowercased() == "bytes" else { return nil }
        let bounds = pieces[1].split(separator: "-", omittingEmptySubsequences: false)
        guard bounds.count == 2,
              let start = decimal(bounds[0]), let end = decimal(bounds[1]),
              start <= end else { return nil }
        return start...end
    }

    /// Sanitized live-check output: no URL, raw header value, body, or credentials.
    public static func safeDiagnostic(
        _ response: BoundedHTTPResponse,
        requested: ClosedRange<Int>,
        expectedTotal: Int? = nil
    ) -> String {
        let expectedBytes = expectedByteCount(
            start: requested.lowerBound,
            end: requested.upperBound
        ) ?? 0
        let length = contentLengthState(response.headers, expectedBytes: expectedBytes)
        let range: FieldState
        if let expectedTotal {
            range = contentRangeState(
                response.headers,
                expectedStart: requested.lowerBound,
                expectedEnd: requested.upperBound,
                expectedTotal: expectedTotal
            )
        } else {
            range = contentRangeState(
                response.headers,
                expectedStart: requested.lowerBound,
                expectedEnd: requested.upperBound,
                expectedTotal: nil
            )
        }
        return "media:status=\(response.status):bytes=\(response.body.count):cl=\(length.rawValue):cr=\(range.rawValue)"
    }

    private static func expectedByteCount(start: Int, end: Int) -> Int? {
        guard start >= 0, end >= start else { return nil }
        let (distance, overflow) = end.subtractingReportingOverflow(start)
        guard !overflow else { return nil }
        let (count, countOverflow) = distance.addingReportingOverflow(1)
        return countOverflow ? nil : count
    }

    private static func header(_ name: String, in headers: [String: String]) -> HeaderValue {
        let values = headers.compactMap { key, value in
            key.caseInsensitiveCompare(name) == .orderedSame ? value : nil
        }
        guard !values.isEmpty else { return .absent }
        guard values.count == 1 else { return .ambiguous }
        return .present(values[0])
    }

    private static func contentLengthState(
        _ headers: [String: String],
        expectedBytes: Int
    ) -> FieldState {
        switch header("content-length", in: headers) {
        case .absent:
            return .absent
        case .ambiguous:
            return .invalid
        case .present(let raw):
            guard let value = decimal(raw[...]) else { return .invalid }
            return value == expectedBytes ? .match : .mismatch
        }
    }

    private static func contentRangeState(
        _ headers: [String: String],
        expectedStart: Int,
        expectedEnd: Int,
        expectedTotal: Int?
    ) -> FieldState {
        switch header("content-range", in: headers) {
        case .absent:
            return .absent
        case .ambiguous:
            return .invalid
        case .present(let raw):
            guard let parsed = parseContentRange(raw),
                  parsed.start <= parsed.end,
                  parsed.end < parsed.total else { return .invalid }
            guard parsed.start == expectedStart, parsed.end == expectedEnd else {
                return .mismatch
            }
            guard let expectedTotal else { return .valid }
            return parsed.total == expectedTotal ? .match : .mismatch
        }
    }

    private static func parseContentRange(_ raw: String) -> ParsedContentRange? {
        let pieces = raw.split(separator: " ", omittingEmptySubsequences: false)
        guard pieces.count == 2, pieces[0].lowercased() == "bytes" else { return nil }
        let rangeAndTotal = pieces[1].split(separator: "/", omittingEmptySubsequences: false)
        guard rangeAndTotal.count == 2 else { return nil }
        let bounds = rangeAndTotal[0].split(separator: "-", omittingEmptySubsequences: false)
        guard bounds.count == 2,
              let start = decimal(bounds[0]),
              let end = decimal(bounds[1]),
              let total = decimal(rangeAndTotal[1]) else { return nil }
        return ParsedContentRange(start: start, end: end, total: total)
    }

    private static func decimal<S: StringProtocol>(_ text: S) -> Int? {
        guard !text.isEmpty else { return nil }
        var value = 0
        for byte in text.utf8 {
            guard byte >= 48, byte <= 57 else { return nil }
            let digit = Int(byte - 48)
            guard value <= (Int.max - digit) / 10 else { return nil }
            value = value * 10 + digit
        }
        return value
    }
}
