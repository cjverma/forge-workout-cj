import Foundation

/// Applies a session to the machine, once per tick.
///
/// Shared by the installed daemon and by `--test-mode`, so the rehearsal you run
/// before installing exercises exactly the code that will later hold your Mac.
public final class Enforcer {
    public let dryRun: Bool
    /// Test mode exempts the escape tools so a first run cannot take your shell
    /// away before you have seen the daemon behave.
    public let exemptEscapeTools: Bool
    public let usePacketFilter: Bool

    private var appliedSessionFingerprint: String?
    private var browsersRestarted = false
    private var pfEnabled = false
    private var pfWasEnabledBeforeUs = false
    private var lastResolve: Date?
    private var resolvedAddresses: [String] = []
    private var notifiedTargets = Set<String>()

    public init(dryRun: Bool, exemptEscapeTools: Bool, usePacketFilter: Bool) {
        self.dryRun = dryRun
        self.exemptEscapeTools = exemptEscapeTools
        self.usePacketFilter = usePacketFilter
        Log.dryRun = dryRun
    }

    private func fingerprint(_ session: Session) -> String {
        let preset = session.preset
        return ([preset.id.uuidString]
            + preset.domains.sorted()
            + preset.appBundleIDs.sorted()
            + preset.appPaths.sorted()).joined(separator: "|")
    }

    /// Called once when a session begins or its blocklist widens.
    private func onSessionChanged(_ session: Session) {
        Log.info("session active until \(session.endsAt), preset '\(session.preset.name)'")
        BrowserPolicy.apply(dryRun: dryRun)

        if usePacketFilter {
            // Resolve before the hosts block lands. Afterwards dig would still bypass
            // /etc/hosts, but the ordering keeps the first resolution honest and costs
            // nothing.
            resolveAddresses(for: session)
            pfWasEnabledBeforeUs = PFAnchor.wasEnabledBeforeUs()
            pfEnabled = PFAnchor.enable(dryRun: dryRun)
            if pfEnabled {
                PFAnchor.updateTable(addresses: resolvedAddresses, dryRun: dryRun)
            } else {
                Log.warn("continuing without pf, hosts-level blocking only")
            }
        }

        HostsWriter.enforce(domains: session.preset.domains, dryRun: dryRun)

        // Policies only bind at launch, and a running browser holds its own DNS
        // cache and warm sockets, so it has to be restarted once to pick them up.
        if !browsersRestarted && !session.preset.domains.isEmpty {
            let processes = ProcessScanner.scan()
            let browsers = ProcessScanner.runningBrowsers(among: processes)
            for browser in browsers {
                ProcessScanner.terminate(browser, dryRun: dryRun)
            }
            if !browsers.isEmpty && !dryRun {
                Launchd.notifyConsoleUser(
                    title: "Anvil",
                    message: "Browsers restarted so the block takes effect."
                )
            }
            browsersRestarted = true
        }
    }

    /// Resolution only. Loading the table is the caller's job, so this can run
    /// before pf is enabled without logging a failure against a table that does
    /// not exist yet.
    @discardableResult
    private func resolveAddresses(for session: Session) -> Bool {
        guard usePacketFilter, !session.preset.domains.isEmpty else { return false }
        lastResolve = Date()
        let addresses = PFAnchor.resolveAll(domains: session.preset.domains)
        // An empty result means DNS is unreachable, not that nothing should be
        // blocked. Keeping the previous addresses is the safer failure.
        guard !addresses.isEmpty, addresses != resolvedAddresses else { return false }
        resolvedAddresses = addresses
        return true
    }

    /// Addresses drift as sites move between CDN nodes, so the table is refreshed
    /// on a slow cycle rather than every tick.
    private func refreshAddressesIfStale(for session: Session) {
        guard usePacketFilter, pfEnabled else { return }
        if let last = lastResolve, Date().timeIntervalSince(last) < 300 { return }
        if resolveAddresses(for: session) {
            PFAnchor.updateTable(addresses: resolvedAddresses, dryRun: dryRun)
        }
    }

    /// One enforcement tick.
    public func enforce(session: Session, now: Date) {
        let current = fingerprint(session)
        if current != appliedSessionFingerprint {
            appliedSessionFingerprint = current
            onSessionChanged(session)
        }

        // Cheap: only rewrites when the file has actually drifted.
        HostsWriter.enforce(domains: session.preset.domains, dryRun: dryRun)
        refreshAddressesIfStale(for: session)

        let processes = ProcessScanner.scan()
        let targets = ProcessScanner.killTargets(
            among: processes,
            preset: session.preset,
            includeEscapeTools: !exemptEscapeTools
        )
        for target in targets {
            ProcessScanner.terminate(target, dryRun: dryRun)
            notifyOnce(target, endsAt: session.endsAt)
        }
    }

    /// One notification per app per session, not one per tick.
    private func notifyOnce(_ process: RunningProcess, endsAt: Date) {
        guard !dryRun else { return }
        let key = process.bundleID ?? process.executablePath
        guard !notifiedTargets.contains(key) else { return }
        notifiedTargets.insert(key)

        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        let name = (process.bundlePath as NSString?)?.lastPathComponent
            .replacingOccurrences(of: ".app", with: "")
            ?? key
        Launchd.notifyConsoleUser(
            title: "Blocked by Anvil",
            message: "\(name) is blocked until \(formatter.string(from: endsAt))."
        )
    }

    /// Called once when the deadline passes. Undoes everything, in reverse order.
    public func revertAll() {
        Log.info("session ended, reverting")
        HostsWriter.revert(dryRun: dryRun)
        BrowserPolicy.revert(dryRun: dryRun)
        if usePacketFilter && pfEnabled {
            PFAnchor.disable(restorePF: !pfWasEnabledBeforeUs, dryRun: dryRun)
        }
        appliedSessionFingerprint = nil
        browsersRestarted = false
        pfEnabled = false
        notifiedTargets.removeAll()
        resolvedAddresses = []
        lastResolve = nil
        if !dryRun {
            Launchd.notifyConsoleUser(title: "Anvil", message: "Session complete. Everything is unblocked.")
        }
    }
}
