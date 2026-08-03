import Foundation

/// Packet filter layer.
///
/// A hosts file alone is leaky: a browser that already resolved an address, or one
/// speaking QUIC on UDP 443, never asks the resolver again. pf closes that by
/// blocking the addresses themselves on both transports.
///
/// A malformed `/etc/pf.conf` takes the network down with it, so every load is
/// dry-parsed first and any failure restores the backup and continues without pf
/// rather than risking the network stack.
public enum PFAnchor {
    public static let anchorName = "anvil"
    public static let tableName = "anvil_blocked"
    public static let beginMarker = "# >>> anvil"
    public static let endMarker = "# <<< anvil"

    public static let anchorBody = """
    table <\(tableName)> persist
    block drop out quick proto tcp to <\(tableName)> port { 80, 443 }
    block drop out quick proto udp to <\(tableName)> port { 80, 443 }
    """

    // MARK: - pf.conf editing

    public static func stripManagedSection(_ contents: String) -> String {
        var kept: [String] = []
        var inside = false
        for line in contents.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed == beginMarker { inside = true; continue }
            if trimmed == endMarker { inside = false; continue }
            if !inside { kept.append(line) }
        }
        while let last = kept.last, last.trimmingCharacters(in: .whitespaces).isEmpty {
            kept.removeLast()
        }
        return kept.isEmpty ? "" : kept.joined(separator: "\n") + "\n"
    }

    /// Filter anchors have to come last in a pf ruleset, which is why this appends.
    public static func applying(to contents: String) -> String {
        let base = stripManagedSection(contents)
        let section = [
            beginMarker,
            "anchor \"\(anchorName)\"",
            "load anchor \"\(anchorName)\" from \"\(Paths.pfAnchorFile)\"",
            endMarker,
        ].joined(separator: "\n")
        return base + section + "\n"
    }

    // MARK: - DNS resolution

    /// Resolves with `dig`, which queries DNS directly and therefore ignores
    /// `/etc/hosts`. Using the system resolver here would return the 0.0.0.0 we
    /// just wrote and populate the table with garbage.
    ///
    /// No resolver is hardcoded: `dig` reads the system configuration, so this keeps
    /// working on networks that block external DNS.
    public static func resolve(domain: String) -> [String] {
        guard let normalized = HostsFile.normalize(domain) else { return [] }
        var addresses = Set<String>()
        for host in [normalized, "www." + normalized] {
            for recordType in ["A", "AAAA"] {
                let result = Shell.run(
                    "/usr/bin/dig",
                    ["+short", "+time=2", "+tries=1", recordType, host]
                )
                guard result.succeeded else { continue }
                for line in result.stdout.components(separatedBy: "\n") {
                    let value = line.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard isLiteralAddress(value) else { continue }
                    // Never blackhole the whole internet because a domain resolves to
                    // a placeholder or to what we already wrote into /etc/hosts.
                    guard value != "0.0.0.0", value != "::", value != "127.0.0.1" else { continue }
                    addresses.insert(value)
                }
            }
        }
        return addresses.sorted()
    }

    static func isLiteralAddress(_ value: String) -> Bool {
        guard !value.isEmpty else { return false }
        var v4 = in_addr()
        if inet_pton(AF_INET, value, &v4) == 1 { return true }
        var v6 = in6_addr()
        if inet_pton(AF_INET6, value, &v6) == 1 { return true }
        return false
    }

    public static func resolveAll(domains: [String]) -> [String] {
        var addresses = Set<String>()
        for domain in domains {
            for address in resolve(domain: domain) { addresses.insert(address) }
        }
        return addresses.sorted()
    }

    // MARK: - Lifecycle

    public static func wasEnabledBeforeUs() -> Bool {
        Shell.run("/sbin/pfctl", ["-s", "info"]).stdout.contains("Status: Enabled")
    }

    /// Returns false when pf could not be enabled safely. The caller carries on with
    /// hosts-level blocking rather than failing the session.
    public static func enable(dryRun: Bool) -> Bool {
        Log.action("install pf anchor and enable packet filter")
        guard !dryRun else { return true }

        do {
            try FileManager.default.createDirectory(
                atPath: (Paths.pfAnchorFile as NSString).deletingLastPathComponent,
                withIntermediateDirectories: true
            )
            try anchorBody.write(toFile: Paths.pfAnchorFile, atomically: true, encoding: .utf8)
        } catch {
            Log.error("could not write pf anchor: \(error)")
            return false
        }

        let original = (try? String(contentsOfFile: Paths.pfConf, encoding: .utf8)) ?? ""
        if !FileManager.default.fileExists(atPath: Paths.pfConfBackup) {
            try? original.write(toFile: Paths.pfConfBackup, atomically: true, encoding: .utf8)
        }

        let updated = applying(to: original)
        guard (try? updated.write(toFile: Paths.pfConf, atomically: true, encoding: .utf8)) != nil else {
            Log.error("could not write /etc/pf.conf")
            return false
        }

        // The guardrail: parse without loading. If this fails we put the original
        // back untouched, because a broken pf.conf means no network at all.
        let check = Shell.run("/sbin/pfctl", ["-n", "-f", Paths.pfConf])
        guard check.succeeded else {
            Log.error("pf.conf failed dry-parse, restoring backup and skipping pf: \(check.stderr)")
            restorePFConf()
            return false
        }

        let load = Shell.run("/sbin/pfctl", ["-f", Paths.pfConf])
        guard load.succeeded else {
            Log.error("pfctl load failed, restoring backup: \(load.stderr)")
            restorePFConf()
            return false
        }

        Shell.run("/sbin/pfctl", ["-E"])
        return true
    }

    public static func updateTable(addresses: [String], dryRun: Bool) {
        guard !addresses.isEmpty else { return }
        Log.action("replace pf table <\(tableName)> with \(addresses.count) addresses")
        guard !dryRun else { return }
        Shell.run("/sbin/pfctl", ["-a", anchorName, "-t", tableName, "-T", "replace"] + addresses)
    }

    public static func disable(restorePF: Bool, dryRun: Bool) {
        Log.action("flush pf anchor and restore /etc/pf.conf")
        guard !dryRun else { return }
        Shell.run("/sbin/pfctl", ["-a", anchorName, "-t", tableName, "-T", "flush"])
        Shell.run("/sbin/pfctl", ["-a", anchorName, "-F", "rules"])
        restorePFConf()
        Shell.run("/sbin/pfctl", ["-f", Paths.pfConf])
        // Only turn pf off if we were the ones who turned it on.
        if restorePF { Shell.run("/sbin/pfctl", ["-d"]) }
    }

    private static func restorePFConf() {
        if let backup = try? String(contentsOfFile: Paths.pfConfBackup, encoding: .utf8) {
            try? backup.write(toFile: Paths.pfConf, atomically: true, encoding: .utf8)
        } else {
            let current = (try? String(contentsOfFile: Paths.pfConf, encoding: .utf8)) ?? ""
            try? stripManagedSection(current).write(toFile: Paths.pfConf, atomically: true, encoding: .utf8)
        }
    }
}
