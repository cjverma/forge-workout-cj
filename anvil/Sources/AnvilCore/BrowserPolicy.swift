import Foundation

/// Enterprise policy files that force browsers back onto the system resolver.
///
/// `DnsOverHttpsMode = off` stops a browser resolving around `/etc/hosts`, and
/// `QuicAllowed = false` stops it opening a UDP 443 connection to an address it
/// already knows. Policies bind at launch, which is why the daemon force-quits
/// running browsers once when a session starts.
public enum BrowserPolicy {
    public struct Target {
        public let name: String
        public let plistPath: String
    }

    public static let chromiumTargets = [
        Target(name: "Chrome", plistPath: "/Library/Managed Preferences/com.google.Chrome.plist"),
        Target(name: "Brave", plistPath: "/Library/Managed Preferences/com.brave.Browser.plist"),
        Target(name: "Edge", plistPath: "/Library/Managed Preferences/com.microsoft.Edge.plist"),
        Target(name: "Vivaldi", plistPath: "/Library/Managed Preferences/com.vivaldi.Vivaldi.plist"),
    ]

    public static let firefoxPolicyPath =
        "/Applications/Firefox.app/Contents/Resources/distribution/policies.json"

    public static let managedKeys: [String: Any] = [
        "DnsOverHttpsMode": "off",
        "QuicAllowed": false,
    ]

    // MARK: - Apply

    public static func apply(dryRun: Bool) {
        for target in chromiumTargets {
            applyChromium(target, dryRun: dryRun)
        }
        applyFirefox(dryRun: dryRun)
    }

    private static func applyChromium(_ target: Target, dryRun: Bool) {
        Log.action("write managed policy for \(target.name) (DoH off, QUIC off)")
        guard !dryRun else { return }
        backup(path: target.plistPath)

        var merged = existingPlist(at: target.plistPath) ?? [:]
        for (key, value) in managedKeys { merged[key] = value }

        do {
            try FileManager.default.createDirectory(
                atPath: (target.plistPath as NSString).deletingLastPathComponent,
                withIntermediateDirectories: true
            )
            let data = try PropertyListSerialization.data(
                fromPropertyList: merged, format: .xml, options: 0
            )
            try data.write(to: URL(fileURLWithPath: target.plistPath))
        } catch {
            Log.warn("could not write \(target.name) policy: \(error)")
        }
    }

    private static func applyFirefox(dryRun: Bool) {
        // Only meaningful if Firefox is actually installed.
        let bundle = "/Applications/Firefox.app"
        guard FileManager.default.fileExists(atPath: bundle) else { return }
        Log.action("write Firefox policies.json (DoH off, locked)")
        guard !dryRun else { return }
        backup(path: firefoxPolicyPath)

        let policies: [String: Any] = [
            "policies": [
                "DNSOverHTTPS": ["Enabled": false, "Locked": true]
            ]
        ]
        do {
            try FileManager.default.createDirectory(
                atPath: (firefoxPolicyPath as NSString).deletingLastPathComponent,
                withIntermediateDirectories: true
            )
            let data = try JSONSerialization.data(withJSONObject: policies, options: [.prettyPrinted])
            try data.write(to: URL(fileURLWithPath: firefoxPolicyPath))
        } catch {
            Log.warn("could not write Firefox policy: \(error)")
        }
    }

    // MARK: - Revert

    public static func revert(dryRun: Bool) {
        Log.action("restore browser policy files")
        guard !dryRun else { return }
        for target in chromiumTargets { restore(path: target.plistPath) }
        restore(path: firefoxPolicyPath)
    }

    // MARK: - Backup bookkeeping

    /// A marker file records "there was nothing here before", so revert deletes the
    /// file rather than leaving a policy behind that the user never had.
    private static func backupPath(for path: String) -> String {
        let encoded = path.replacingOccurrences(of: "/", with: "_")
        return Paths.policyBackups + "/" + encoded
    }

    private static func backup(path: String) {
        let destination = backupPath(for: path)
        guard !FileManager.default.fileExists(atPath: destination),
              !FileManager.default.fileExists(atPath: destination + ".absent") else { return }
        try? FileManager.default.createDirectory(
            atPath: Paths.policyBackups, withIntermediateDirectories: true
        )
        if FileManager.default.fileExists(atPath: path) {
            try? FileManager.default.copyItem(atPath: path, toPath: destination)
        } else {
            FileManager.default.createFile(atPath: destination + ".absent", contents: Data())
        }
    }

    private static func restore(path: String) {
        let source = backupPath(for: path)
        if FileManager.default.fileExists(atPath: source) {
            try? FileManager.default.removeItem(atPath: path)
            try? FileManager.default.copyItem(atPath: source, toPath: path)
            try? FileManager.default.removeItem(atPath: source)
        } else if FileManager.default.fileExists(atPath: source + ".absent") {
            try? FileManager.default.removeItem(atPath: path)
            try? FileManager.default.removeItem(atPath: source + ".absent")
        }
    }

    private static func existingPlist(at path: String) -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        let parsed = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        return parsed as? [String: Any]
    }
}
