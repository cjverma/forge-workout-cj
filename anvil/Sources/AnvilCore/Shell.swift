import Foundation

public struct ShellResult {
    public let status: Int32
    public let stdout: String
    public let stderr: String
    public var succeeded: Bool { status == 0 }
}

public enum Shell {
    /// Runs a tool and waits. Reads both pipes before waiting on the process so a
    /// chatty command cannot deadlock by filling its pipe buffer.
    @discardableResult
    public static func run(_ path: String, _ args: [String]) -> ShellResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        do {
            try process.run()
        } catch {
            return ShellResult(status: -1, stdout: "", stderr: "\(error)")
        }
        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return ShellResult(
            status: process.terminationStatus,
            stdout: String(data: outData, encoding: .utf8) ?? "",
            stderr: String(data: errData, encoding: .utf8) ?? ""
        )
    }
}

public enum Launchd {
    public static func isLoaded(label: String) -> Bool {
        Shell.run("/bin/launchctl", ["print", "system/\(label)"]).succeeded
    }

    @discardableResult
    public static func bootstrap(plistPath: String) -> ShellResult {
        Shell.run("/bin/launchctl", ["bootstrap", "system", plistPath])
    }

    /// Posts a notification into the console user's GUI session. The daemon runs
    /// as root outside any session, so it has to reach in explicitly.
    public static func notifyConsoleUser(title: String, message: String) {
        guard let uid = consoleUserID() else { return }
        let escapedTitle = title.replacingOccurrences(of: "\"", with: "'")
        let escapedMessage = message.replacingOccurrences(of: "\"", with: "'")
        let script = "display notification \"\(escapedMessage)\" with title \"\(escapedTitle)\""
        Shell.run("/bin/launchctl", ["asuser", "\(uid)", "/usr/bin/osascript", "-e", script])
    }

    /// The uid of whoever owns the login window right now, or nil at the login screen.
    public static func consoleUserID() -> uid_t? {
        let result = Shell.run("/usr/bin/stat", ["-f", "%u", "/dev/console"])
        guard result.succeeded else { return nil }
        let trimmed = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = UInt32(trimmed), value != 0 else { return nil }
        return uid_t(value)
    }
}
