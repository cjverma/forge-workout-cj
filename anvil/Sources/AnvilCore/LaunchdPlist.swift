import Foundation

/// Launchd job definitions, embedded in both binaries.
///
/// Each daemon carries a copy so it can rewrite its peer's plist from memory. That
/// is what makes `rm /Library/LaunchDaemons/...` followed by `bootout` heal instead
/// of sticking: the survivor recreates the file before bootstrapping it.
public enum LaunchdPlist {
    public static func xml(label: String, program: String, arguments: [String], logPath: String) -> String {
        let argumentLines = ([program] + arguments)
            .map { "        <string>\(escape($0))</string>" }
            .joined(separator: "\n")
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key>
            <string>\(escape(label))</string>
            <key>ProgramArguments</key>
            <array>
        \(argumentLines)
            </array>
            <key>RunAtLoad</key>
            <true/>
            <key>KeepAlive</key>
            <true/>
            <key>ProcessType</key>
            <string>Interactive</string>
            <key>StandardErrorPath</key>
            <string>\(escape(logPath))</string>
            <key>StandardOutPath</key>
            <string>\(escape(logPath))</string>
        </dict>
        </plist>
        """
    }

    public static var daemon: String {
        xml(
            label: Paths.daemonLabel,
            program: Paths.daemonBinary,
            arguments: [],
            logPath: Paths.logDaemon
        )
    }

    public static var watchdog: String {
        xml(
            label: Paths.watchdogLabel,
            program: Paths.watchdogBinary,
            arguments: [],
            logPath: Paths.logWatchdog
        )
    }

    @discardableResult
    public static func write(_ contents: String, to path: String) -> Bool {
        do {
            try contents.write(toFile: path, atomically: true, encoding: .utf8)
            chmod(path, 0o644)
            try? FileManager.default.setAttributes(
                [.ownerAccountID: 0, .groupOwnerAccountID: 0], ofItemAtPath: path
            )
            return true
        } catch {
            Log.error("could not write \(path): \(error)")
            return false
        }
    }

    private static func escape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}

/// Mutual resurrection.
///
/// Being straight about the ceiling: a 1s check narrows the window but does not
/// close it. A prepared `sudo launchctl bootout a && sudo launchctl bootout b`
/// still wins the race, and SIGKILL cannot be caught by anything. What actually
/// holds a session together is that Terminal is dead for its duration, and that the
/// deadline lives in root-owned state, so a reboot re-arms rather than clears.
public enum PeerGuard {
    public static func ensurePeerAlive(label: String, plistPath: String, plistBody: String, dryRun: Bool) {
        if !FileManager.default.fileExists(atPath: plistPath) {
            Log.action("recreate missing launchd plist \(plistPath)")
            guard !dryRun else { return }
            LaunchdPlist.write(plistBody, to: plistPath)
        }
        guard !Launchd.isLoaded(label: label) else { return }
        Log.action("bootstrap missing peer \(label)")
        guard !dryRun else { return }
        let result = Launchd.bootstrap(plistPath: plistPath)
        if !result.succeeded {
            Log.warn("bootstrap of \(label) failed: \(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
    }

    /// SIGTERM is what `killall` and a polite `bootout` send first. Ignoring it means
    /// the casual attempt fails outright. SIGKILL is uncatchable by design, and
    /// nothing here pretends otherwise.
    public static func ignoreTerminationSignals() {
        signal(SIGTERM, SIG_IGN)
        signal(SIGHUP, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        signal(SIGPIPE, SIG_IGN)
    }
}
