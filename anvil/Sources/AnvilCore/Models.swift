import Foundation

public enum Limits {
    /// A typo with no escape hatch could cost you a week, so sessions are capped.
    public static let maxMinutes = 1440
    public static let minMinutes = 1
    /// Anything larger than this on the control socket is discarded unread.
    public static let maxRequestBytes = 4096
    /// One accepted request per this interval. Blocks the drop-a-thousand-requests
    /// denial of service without affecting any legitimate use.
    public static let requestMinInterval: TimeInterval = 5
}

public struct Preset: Codable, Identifiable, Equatable {
    public var id: UUID
    public var name: String
    /// Primary app signal. Survives renaming or relocating the bundle.
    public var appBundleIDs: [String]
    /// Secondary signal, resolved when the preset is edited.
    public var appPaths: [String]
    public var domains: [String]
    public var defaultMinutes: Int

    public init(
        id: UUID = UUID(),
        name: String,
        appBundleIDs: [String] = [],
        appPaths: [String] = [],
        domains: [String] = [],
        defaultMinutes: Int = 60
    ) {
        self.id = id
        self.name = name
        self.appBundleIDs = appBundleIDs
        self.appPaths = appPaths
        self.domains = domains
        self.defaultMinutes = defaultMinutes
    }

    public var isEmpty: Bool {
        appBundleIDs.isEmpty && appPaths.isEmpty && domains.isEmpty
    }

    /// Merging two presets can only ever widen the block, never narrow it.
    public func unioned(with other: Preset) -> Preset {
        var merged = self
        merged.appBundleIDs = Array(Set(appBundleIDs).union(other.appBundleIDs)).sorted()
        merged.appPaths = Array(Set(appPaths).union(other.appPaths)).sorted()
        merged.domains = Array(Set(domains).union(other.domains)).sorted()
        return merged
    }
}

public struct Session: Codable, Equatable {
    public var startedAt: Date
    public var endsAt: Date
    public var preset: Preset

    public init(startedAt: Date, endsAt: Date, preset: Preset) {
        self.startedAt = startedAt
        self.endsAt = endsAt
        self.preset = preset
    }

    public func isActive(at now: Date) -> Bool { endsAt > now }
}

/// The only message the daemon accepts. There is deliberately no stop, cancel or
/// shorten opcode: no early exit is a property of the protocol, not of the UI.
public struct StartRequest: Codable {
    public var preset: Preset
    public var minutes: Int

    public init(preset: Preset, minutes: Int) {
        self.preset = preset
        self.minutes = minutes
    }
}

/// World-readable projection of the session, so the app can show a countdown
/// without being able to read or influence the real state.
public struct PublicState: Codable {
    public var active: Bool
    public var endsAt: Date?
    public var presetName: String?
    public var blockedAppCount: Int
    public var blockedDomainCount: Int

    public init(session: Session?, now: Date) {
        if let s = session, s.isActive(at: now) {
            active = true
            endsAt = s.endsAt
            presetName = s.preset.name
            blockedAppCount = s.preset.appBundleIDs.count + s.preset.appPaths.count
            blockedDomainCount = s.preset.domains.count
        } else {
            active = false
            endsAt = nil
            presetName = nil
            blockedAppCount = 0
            blockedDomainCount = 0
        }
    }
}

/// Deadline arithmetic, kept pure so it can be tested without root.
public enum SessionPolicy {
    public enum Rejection: Error, Equatable, CustomStringConvertible {
        case durationOutOfRange(Int)
        case emptyBlocklist
        case wouldNotStrengthen

        public var description: String {
            switch self {
            case .durationOutOfRange(let m):
                return "duration \(m) outside \(Limits.minMinutes)...\(Limits.maxMinutes) minutes"
            case .emptyBlocklist:
                return "preset blocks nothing"
            case .wouldNotStrengthen:
                return "request would not extend the deadline or widen the blocklist"
            }
        }
    }

    /// Returns the session that should replace `current`.
    ///
    /// The deadline is monotonic: a request may push it later or add entries to
    /// the blocklist, and can do nothing else. This is what makes a running
    /// session impossible to cut short through the front door.
    public static func apply(
        request: StartRequest,
        to current: Session?,
        now: Date
    ) throws -> Session {
        guard request.minutes >= Limits.minMinutes, request.minutes <= Limits.maxMinutes else {
            throw Rejection.durationOutOfRange(request.minutes)
        }

        let candidate = now.addingTimeInterval(TimeInterval(request.minutes) * 60)

        guard let current, current.isActive(at: now) else {
            // Only a session starting from nothing needs something to block. While a
            // session is live an empty preset is the natural way to say "same
            // blocklist, later deadline".
            guard !request.preset.isEmpty else { throw Rejection.emptyBlocklist }
            return Session(startedAt: now, endsAt: candidate, preset: request.preset)
        }

        let widened = current.preset.unioned(with: request.preset)
        let extends = candidate > current.endsAt
        let widens = widened != current.preset
        guard extends || widens else { throw Rejection.wouldNotStrengthen }

        var merged = current
        merged.preset = widened
        if extends { merged.endsAt = candidate }
        return merged
    }
}
