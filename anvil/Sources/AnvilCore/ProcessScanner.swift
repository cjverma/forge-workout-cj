import Foundation

public struct RunningProcess: Equatable {
    public let pid: pid_t
    public let uid: uid_t
    public let executablePath: String
    public let command: String
    public let bundleID: String?
    public let bundlePath: String?

    public init(
        pid: pid_t,
        uid: uid_t,
        executablePath: String,
        command: String,
        bundleID: String?,
        bundlePath: String?
    ) {
        self.pid = pid
        self.uid = uid
        self.executablePath = executablePath
        self.command = command
        self.bundleID = bundleID
        self.bundlePath = bundlePath
    }
}

public enum ProcessScanner {
    // MARK: - Guard list

    /// System *services*. Killing anything under these paths breaks the machine.
    ///
    /// `/System/Applications/` is deliberately absent: on macOS 13+ that is where
    /// Terminal, Activity Monitor and System Settings live, and blocking the escape
    /// tools is the entire point. A blanket `/System/` prefix here would turn that
    /// feature into a silent no-op.
    public static let protectedPathPrefixes = [
        "/System/Library/",
        "/Library/Apple/",
        "/usr/libexec/",
        "/usr/sbin/",
        "/usr/bin/",
        "/sbin/",
        "/bin/",
    ]

    /// Killing any of these logs you out or leaves you with no desktop.
    public static let protectedBundleIDs: Set<String> = [
        "com.apple.finder",
        "com.apple.dock",
        "com.apple.WindowServer",
        "com.apple.loginwindow",
        "com.apple.systemuiserver",
        "com.apple.controlcenter",
        "com.apple.notificationcenterui",
        "com.apple.Spotlight",
    ]

    /// Quit during every session, regardless of preset. A blocker that leaves a
    /// shell open is an honour-system blocker for anyone who can type `sudo`.
    public static let escapeToolBundleIDs: Set<String> = [
        "com.apple.Terminal",
        "com.googlecode.iterm2",
        "com.apple.ActivityMonitor",
        "com.apple.systempreferences",
        "com.apple.Console",
        "com.apple.ScriptEditor2",
        "dev.warp.Warp-Stable",
        "co.zeit.hyper",
        "net.kovidgoyal.kitty",
        "io.alacritty",
        "com.github.wez.wezterm",
    ]

    /// Restarted once at session start to drop cached DNS answers and warm sockets.
    public static let browserBundleIDs: Set<String> = [
        "com.apple.Safari",
        "com.google.Chrome",
        "com.google.Chrome.canary",
        "com.brave.Browser",
        "com.microsoft.Edge",
        "org.mozilla.firefox",
        "company.thebrowser.Browser",
        "com.operasoftware.Opera",
        "com.vivaldi.Vivaldi",
    ]

    public static func isProtected(
        pid: pid_t,
        uid: uid_t,
        executablePath: String,
        bundleID: String?
    ) -> Bool {
        if pid < 100 { return true }
        // Root-owned processes are system infrastructure, including Anvil's own daemons.
        if uid == 0 { return true }
        for prefix in protectedPathPrefixes where executablePath.hasPrefix(prefix) { return true }
        if let bundleID, protectedBundleIDs.contains(bundleID) { return true }
        return false
    }

    public static func isProtected(_ process: RunningProcess) -> Bool {
        isProtected(
            pid: process.pid,
            uid: process.uid,
            executablePath: process.executablePath,
            bundleID: process.bundleID
        )
    }

    // MARK: - Bundle identity

    /// Walks up from an executable path to its enclosing `.app` and reads the real
    /// bundle identifier.
    ///
    /// This is what defeats the obvious dodges: renaming `Slack.app` to `Slack2.app`,
    /// copying it to `~/Applications` or `/tmp`, or launching the inner binary
    /// directly. None of those change `CFBundleIdentifier`, and all of them defeat
    /// matching on path alone.
    public static func bundleInfo(forExecutablePath path: String) -> (bundleID: String?, bundlePath: String?) {
        var url = URL(fileURLWithPath: path)
        while url.path != "/" && url.pathComponents.count > 1 {
            if url.pathExtension == "app" {
                let plistPath = url.appendingPathComponent("Contents/Info.plist").path
                guard let data = FileManager.default.contents(atPath: plistPath) else {
                    return (nil, url.path)
                }
                let parsed = try? PropertyListSerialization.propertyList(
                    from: data, options: [], format: nil
                )
                if let dict = parsed as? [String: Any],
                   let identifier = dict["CFBundleIdentifier"] as? String {
                    return (identifier, url.path)
                }
                return (nil, url.path)
            }
            url = url.deletingLastPathComponent()
        }
        return (nil, nil)
    }

    // MARK: - Scanning

    /// Two `ps` invocations joined on pid, because `comm` and `command` both have to
    /// be the trailing column to survive paths and arguments containing spaces.
    /// `-ww` disables the width truncation that would otherwise silently clip long
    /// paths and break matching.
    public static func scan() -> [RunningProcess] {
        let commResult = Shell.run("/bin/ps", ["-axww", "-o", "pid=,uid=,comm="])
        guard commResult.succeeded else {
            Log.error("ps failed: \(commResult.stderr.trimmingCharacters(in: .whitespacesAndNewlines))")
            return []
        }
        let argsResult = Shell.run("/bin/ps", ["-axww", "-o", "pid=,command="])

        var commandsByPID = [pid_t: String]()
        for line in argsResult.stdout.components(separatedBy: "\n") {
            guard let (pid, rest) = splitLeadingInt(line) else { continue }
            commandsByPID[pid] = rest
        }

        var processes: [RunningProcess] = []
        for line in commResult.stdout.components(separatedBy: "\n") {
            guard let (pid, afterPID) = splitLeadingInt(line) else { continue }
            guard let (uidValue, executablePath) = splitLeadingInt(afterPID) else { continue }
            let path = executablePath.trimmingCharacters(in: .whitespaces)
            guard !path.isEmpty else { continue }
            let info = bundleInfo(forExecutablePath: path)
            processes.append(
                RunningProcess(
                    pid: pid,
                    uid: uid_t(max(0, uidValue)),
                    executablePath: path,
                    command: commandsByPID[pid] ?? path,
                    bundleID: info.bundleID,
                    bundlePath: info.bundlePath
                )
            )
        }
        return processes
    }

    /// Peels one integer field off the front of a `ps` line and returns the remainder.
    static func splitLeadingInt(_ line: String) -> (Int32, String)? {
        let trimmed = line.drop(while: { $0 == " " })
        guard let boundary = trimmed.firstIndex(of: " ") else { return nil }
        guard let value = Int32(trimmed[trimmed.startIndex..<boundary]) else { return nil }
        let rest = String(trimmed[trimmed.index(after: boundary)...]).drop(while: { $0 == " " })
        return (value, String(rest))
    }

    // MARK: - Matching

    /// Three independent signals, any of which is enough. Bundle ID is the one that
    /// survives tampering; path and command line catch things launched outside a
    /// bundle entirely, such as a raw binary started from a shell.
    public static func matches(_ process: RunningProcess, preset: Preset) -> Bool {
        if let bundleID = process.bundleID, preset.appBundleIDs.contains(bundleID) {
            return true
        }
        for path in preset.appPaths where !path.isEmpty {
            if process.executablePath.hasPrefix(path) { return true }
            if let bundlePath = process.bundlePath, bundlePath == path { return true }
        }
        for bundleID in preset.appBundleIDs where !bundleID.isEmpty {
            if process.command.contains(bundleID) { return true }
        }
        return false
    }

    /// The full kill list for one tick. The guard list is applied last and
    /// unconditionally, so no matching rule can ever reach a protected process.
    public static func killTargets(
        among processes: [RunningProcess],
        preset: Preset,
        includeEscapeTools: Bool
    ) -> [RunningProcess] {
        processes.filter { process in
            guard !isProtected(process) else { return false }
            if matches(process, preset: preset) { return true }
            if includeEscapeTools, let bundleID = process.bundleID,
               escapeToolBundleIDs.contains(bundleID) {
                return true
            }
            return false
        }
    }

    public static func runningBrowsers(among processes: [RunningProcess]) -> [RunningProcess] {
        processes.filter { process in
            guard !isProtected(process), let bundleID = process.bundleID else { return false }
            return browserBundleIDs.contains(bundleID)
        }
    }

    // MARK: - Killing

    /// SIGTERM first so an app can flush state, SIGKILL a moment later for anything
    /// that ignores it.
    public static func terminate(_ process: RunningProcess, dryRun: Bool) {
        let label = process.bundleID ?? process.executablePath
        Log.action("terminate pid \(process.pid) (\(label))")
        guard !dryRun else { return }
        kill(process.pid, SIGTERM)
        usleep(150_000)
        if kill(process.pid, 0) == 0 {
            kill(process.pid, SIGKILL)
        }
    }
}
