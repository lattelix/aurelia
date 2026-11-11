import Foundation

/// Timers are session intent, so they are never encoded or restored.
public enum SleepTimerState: Equatable, Sendable {
    case deadline(Date)
    case trackEnd(UUID)

    public var deadline: Date? {
        if case .deadline(let value) = self { return value }
        return nil
    }
    public var title: String {
        switch self {
        case .deadline(let date): return "Sleep at " + date.formatted(date: .omitted, time: .shortened)
        case .trackEnd: return "Sleep at end of song"
        }
    }
}
