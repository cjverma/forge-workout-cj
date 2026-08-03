import Foundation

/// Pure text handling for the managed section of `/etc/hosts`.
///
/// Everything here is a string transform so the whole thing is testable without
/// root and without touching the real file.
public enum HostsFile {
    public static let beginMarker = "# >>> anvil"
    public static let endMarker = "# <<< anvil"

    /// Browsers that resolve over DNS-over-HTTPS never consult `/etc/hosts`, so the
    /// resolver endpoints themselves get blocked. Combined with the managed policy
    /// plists this collapses a browser back onto the system resolver.
    public static let dohEndpoints = [
        "chrome.cloudflare-dns.com",
        "cloudflare-dns.com",
        "dns.adguard.com",
        "dns.google",
        "dns.nextdns.io",
        "dns.quad9.net",
        "dns64.dns.google",
        "doh.cleanbrowsing.org",
        "doh.dns.sb",
        "doh.opendns.com",
        "family.cloudflare-dns.com",
        "mozilla.cloudflare-dns.com",
        "one.one.one.one",
        "security.cloudflare-dns.com",
    ]

    /// "https://www.Reddit.com/r/x" and "reddit.com" have to land on the same key.
    public static func normalize(_ raw: String) -> String? {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !value.isEmpty, !value.hasPrefix("#") else { return nil }
        for scheme in ["https://", "http://"] where value.hasPrefix(scheme) {
            value = String(value.dropFirst(scheme.count))
        }
        if let slash = value.firstIndex(of: "/") { value = String(value[value.startIndex..<slash]) }
        if let colon = value.firstIndex(of: ":") { value = String(value[value.startIndex..<colon]) }
        if value.hasPrefix("www.") { value = String(value.dropFirst(4)) }
        while value.hasSuffix(".") { value = String(value.dropLast()) }
        guard !value.isEmpty, value.contains("."), !value.contains(" ") else { return nil }
        return value
    }

    /// Apex plus `www.`, deduplicated and ordered so the rendered block is stable
    /// and a drift check does not fire on reordering alone.
    public static func expand(domains: [String], includeDoHEndpoints: Bool = true) -> [String] {
        var hosts = Set<String>()
        for raw in domains {
            guard let domain = normalize(raw) else { continue }
            hosts.insert(domain)
            hosts.insert("www." + domain)
        }
        if includeDoHEndpoints, !hosts.isEmpty {
            for endpoint in dohEndpoints { hosts.insert(endpoint) }
        }
        return hosts.sorted()
    }

    public static func renderManagedSection(domains: [String], includeDoHEndpoints: Bool = true) -> String {
        let hosts = expand(domains: domains, includeDoHEndpoints: includeDoHEndpoints)
        guard !hosts.isEmpty else { return "" }
        var lines = [beginMarker]
        lines.append("# Managed by Anvil. Edits here are reverted while a session is active.")
        for host in hosts {
            lines.append("0.0.0.0 \(host)")
            lines.append(":: \(host)")
        }
        lines.append(endMarker)
        return lines.joined(separator: "\n")
    }

    /// Removes every managed section, including duplicates left behind by a crash.
    /// A begin marker with no matching end strips to end of file, which is the
    /// safe direction: worst case a stale block is dropped, never user content
    /// silently retained inside a block we no longer track.
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

    /// Idempotent: applying the same domains twice yields byte-identical output.
    public static func applying(domains: [String], to contents: String, includeDoHEndpoints: Bool = true) -> String {
        let base = stripManagedSection(contents)
        let section = renderManagedSection(domains: domains, includeDoHEndpoints: includeDoHEndpoints)
        if section.isEmpty { return base }
        return base + section + "\n"
    }
}

/// The on-disk half, kept apart from the transforms above so the transforms stay
/// trivially testable.
public enum HostsWriter {
    public static func read() -> String {
        (try? String(contentsOfFile: Paths.hosts, encoding: .utf8)) ?? ""
    }

    /// Writes only when content actually differs, so the 1s enforcement tick does
    /// not rewrite `/etc/hosts` and flush the DNS cache once per second forever.
    /// Returns true when a write happened.
    @discardableResult
    public static func enforce(domains: [String], dryRun: Bool) -> Bool {
        let current = read()
        let desired = HostsFile.applying(domains: domains, to: current)
        guard current != desired else { return false }
        Log.action("rewrite /etc/hosts managed section (\(domains.count) domains)")
        guard !dryRun else { return true }
        guard writeAtomically(desired) else { return false }
        flushDNS()
        return true
    }

    @discardableResult
    public static func revert(dryRun: Bool) -> Bool {
        let current = read()
        let desired = HostsFile.stripManagedSection(current)
        guard current != desired else { return false }
        Log.action("remove /etc/hosts managed section")
        guard !dryRun else { return true }
        guard writeAtomically(desired) else { return false }
        flushDNS()
        return true
    }

    /// Temp file in the same directory then rename, so a crash mid-write can never
    /// leave `/etc/hosts` truncated. A truncated hosts file is a broken machine.
    private static func writeAtomically(_ contents: String) -> Bool {
        let temp = "/etc/.anvil-hosts.tmp"
        do {
            try contents.write(toFile: temp, atomically: false, encoding: .utf8)
            chmod(temp, 0o644)
            var attributes = [FileAttributeKey: Any]()
            attributes[.ownerAccountID] = 0
            attributes[.groupOwnerAccountID] = 0
            try? FileManager.default.setAttributes(attributes, ofItemAtPath: temp)
            if rename(temp, Paths.hosts) != 0 {
                Log.error("rename of hosts temp file failed: errno \(errno)")
                unlink(temp)
                return false
            }
            return true
        } catch {
            Log.error("could not write hosts temp file: \(error)")
            unlink(temp)
            return false
        }
    }

    public static func flushDNS() {
        Shell.run("/usr/bin/dscacheutil", ["-flushcache"])
        Shell.run("/usr/bin/killall", ["-HUP", "mDNSResponder"])
    }
}
