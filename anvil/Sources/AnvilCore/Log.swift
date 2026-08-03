import Foundation

public enum Log {
    public static var name = "anvil"
    public static var dryRun = false

    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    public static func info(_ message: String) { emit("INFO", message) }
    public static func warn(_ message: String) { emit("WARN", message) }
    public static func error(_ message: String) { emit("ERROR", message) }

    /// Used for every mutating action so `--dry-run` output reads exactly like a
    /// real run, minus the mutation.
    public static func action(_ message: String) {
        emit(dryRun ? "WOULD" : "DO", message)
    }

    private static func emit(_ level: String, _ message: String) {
        let line = "\(formatter.string(from: Date())) [\(name)] \(level) \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        FileHandle.standardError.write(data)
    }
}
