import Foundation

/// Persistence for the deadline.
///
/// This is the thing that makes a reboot re-arm the block instead of clearing it:
/// the session outlives every process involved, so tearing the daemons down live
/// only buys freedom until the next boot.
public enum SessionStore {
    private static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }

    private static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }

    public static func ensureDirectories() {
        let fm = FileManager.default
        // 0755: nothing inside is user-writable, but public-state.json stays readable.
        try? fm.createDirectory(
            atPath: Paths.support,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o755]
        )
        try? fm.createDirectory(
            atPath: Paths.policyBackups,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
    }

    public static func load() -> Session? {
        guard let data = FileManager.default.contents(atPath: Paths.state) else { return nil }
        do {
            return try decoder.decode(Session.self, from: data)
        } catch {
            Log.error("state.json unreadable, treating as no session: \(error)")
            return nil
        }
    }

    public static func save(_ session: Session?) {
        ensureDirectories()
        if let session {
            do {
                let data = try encoder.encode(session)
                try data.write(to: URL(fileURLWithPath: Paths.state), options: .atomic)
                chmod(Paths.state, 0o600)
            } catch {
                Log.error("could not write state.json: \(error)")
            }
        } else {
            try? FileManager.default.removeItem(atPath: Paths.state)
        }
        writePublicState(session)
    }

    /// The unprivileged projection the menu bar app reads. Deliberately contains no
    /// secret and grants no control.
    public static func writePublicState(_ session: Session?) {
        let publicState = PublicState(session: session, now: Date())
        do {
            let data = try encoder.encode(publicState)
            try data.write(to: URL(fileURLWithPath: Paths.publicState), options: .atomic)
            chmod(Paths.publicState, 0o644)
        } catch {
            Log.error("could not write public-state.json: \(error)")
        }
    }

    public static func loadPublicState() -> PublicState? {
        guard let data = FileManager.default.contents(atPath: Paths.publicState) else { return nil }
        return try? decoder.decode(PublicState.self, from: data)
    }

    public static func encodeRequest(_ request: StartRequest) throws -> Data {
        try encoder.encode(request)
    }

    public static func decodeRequest(_ data: Data) throws -> StartRequest {
        try decoder.decode(StartRequest.self, from: data)
    }

    // MARK: - Presets (user side)

    public static func loadPresets() -> [Preset] {
        guard let data = FileManager.default.contents(atPath: Paths.userPresets) else { return [] }
        return (try? decoder.decode([Preset].self, from: data)) ?? []
    }

    public static func savePresets(_ presets: [Preset]) {
        let directory = (Paths.userPresets as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(
            atPath: directory, withIntermediateDirectories: true
        )
        guard let data = try? encoder.encode(presets) else { return }
        try? data.write(to: URL(fileURLWithPath: Paths.userPresets), options: .atomic)
    }
}

/// Single-instance guard. Two enforcement loops fighting over `/etc/hosts` would
/// rewrite it against each other once a second.
public final class InstanceLock {
    private var fd: Int32 = -1

    public init() {}

    public func acquire(path: String) -> Bool {
        SessionStore.ensureDirectories()
        fd = open(path, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else { return false }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            close(fd)
            fd = -1
            return false
        }
        return true
    }

    deinit {
        if fd >= 0 {
            flock(fd, LOCK_UN)
            close(fd)
        }
    }
}
