import AnvilCore
import Foundation

// anvild — the root enforcement daemon.
//
// Modes:
//   (none)       long-running daemon, installed by install.sh
//   --dry-run    print every action for a given blocklist, change nothing
//   --test-mode  foreground session with escape tools exempt, reverts on exit
//
// The rehearsal modes exist because escape-tool killing is unconditional in a real
// session: once installed, a bug that quits the wrong process is much harder to dig
// yourself out of. Prove the daemon sane before it can take your Terminal away.

struct Arguments {
    var dryRun = false
    var testMode = false
    var minutes = 2
    var domains: [String] = []
    var apps: [String] = []
    var noPacketFilter = false

    static func parse(_ argv: [String]) -> Arguments {
        var args = Arguments()
        var index = 0
        while index < argv.count {
            let flag = argv[index]
            switch flag {
            case "--dry-run": args.dryRun = true
            case "--test-mode": args.testMode = true
            case "--no-pf": args.noPacketFilter = true
            case "--minutes":
                index += 1
                if index < argv.count, let value = Int(argv[index]) { args.minutes = value }
            case "--domains":
                index += 1
                if index < argv.count {
                    args.domains = argv[index].split(separator: ",").map(String.init)
                }
            case "--apps":
                index += 1
                if index < argv.count {
                    args.apps = argv[index].split(separator: ",").map(String.init)
                }
            case "--help", "-h":
                print(usage)
                exit(0)
            default:
                break
            }
            index += 1
        }
        return args
    }
}

let usage = """
anvild - Anvil enforcement daemon

  anvild                     run as the installed daemon (root)
  anvild --dry-run  [...]    log every action without changing anything
  anvild --test-mode [...]   foreground session, escape tools exempt

Options for --dry-run and --test-mode:
  --minutes N                session length (default 2)
  --domains a.com,b.com      domains to block
  --apps com.foo.Bar,...     app bundle identifiers to block
  --no-pf                    skip the packet filter layer
"""

func requireRoot() {
    guard getuid() == 0 else {
        FileHandle.standardError.write("anvild must run as root\n".data(using: .utf8)!)
        exit(1)
    }
}

let arguments = Arguments.parse(Array(CommandLine.arguments.dropFirst()))
Log.name = "anvild"

// MARK: - Rehearsal modes

if arguments.dryRun || arguments.testMode {
    requireRoot()
    let preset = Preset(
        name: arguments.testMode ? "Test session" : "Dry run",
        appBundleIDs: arguments.apps,
        domains: arguments.domains,
        defaultMinutes: arguments.minutes
    )

    if preset.isEmpty {
        print("Nothing to block. Pass --domains and/or --apps.\n")
        print(usage)
        exit(1)
    }

    let enforcer = Enforcer(
        dryRun: arguments.dryRun,
        exemptEscapeTools: true,
        usePacketFilter: !arguments.noPacketFilter
    )

    if arguments.dryRun {
        // One pass, no mutation, then a plain summary of what a real session would do.
        let session = Session(
            startedAt: Date(),
            endsAt: Date().addingTimeInterval(TimeInterval(arguments.minutes) * 60),
            preset: preset
        )
        enforcer.enforce(session: session, now: Date())

        print("\n--- processes a real session would terminate ---")
        let processes = ProcessScanner.scan()
        let targets = ProcessScanner.killTargets(
            among: processes, preset: preset, includeEscapeTools: true
        )
        if targets.isEmpty {
            print("(none running right now)")
        }
        for target in targets {
            print("  pid \(target.pid)  \(target.bundleID ?? "-")  \(target.executablePath)")
        }
        print("\n--- protected, never terminated ---")
        let protected = processes.filter { ProcessScanner.isProtected($0) }
        print("  \(protected.count) processes covered by the guard list")
        print("\n--- /etc/hosts section that would be written ---")
        print(HostsFile.renderManagedSection(domains: preset.domains))
        exit(0)
    }

    // Test mode: a real, short, reversible session in the foreground.
    let endsAt = Date().addingTimeInterval(TimeInterval(arguments.minutes) * 60)
    Log.info("test session until \(endsAt); escape tools are exempt; ctrl-c reverts")

    // Test mode honours ctrl-c on purpose. A real session does not.
    InterruptFlag.installSIGINTHandler()

    let session = Session(startedAt: Date(), endsAt: endsAt, preset: preset)
    while Date() < endsAt && !InterruptFlag.isRaised {
        enforcer.enforce(session: session, now: Date())
        Thread.sleep(forTimeInterval: 1.0)
    }
    if InterruptFlag.isRaised { Log.info("interrupted, reverting") }
    enforcer.revertAll()
    Log.info("test session finished and reverted")
    exit(0)
}

// MARK: - Daemon mode

requireRoot()
PeerGuard.ignoreTerminationSignals()

let lock = InstanceLock()
guard lock.acquire(path: Paths.lock) else {
    Log.error("another anvild already holds the lock, exiting")
    exit(0)
}

SessionStore.ensureDirectories()

let socketServer = ControlSocketServer(path: Paths.socket)
do {
    try socketServer.start()
    Log.info("listening on \(Paths.socket)")
} catch {
    Log.error("could not open control socket: \(error)")
}

let enforcer = Enforcer(dryRun: false, exemptEscapeTools: false, usePacketFilter: true)

// A session found on disk at startup is a session that survived a reboot, or an
// attempt to tear the daemons down. Either way it resumes.
if let existing = SessionStore.load(), existing.isActive(at: Date()) {
    Log.info("resuming session from disk, ends at \(existing.endsAt)")
}

var wasActive = false

while true {
    let now = Date()

    if let payload = socketServer.poll(now: now) {
        do {
            let request = try SessionStore.decodeRequest(payload)
            let current = SessionStore.load()
            let updated = try SessionPolicy.apply(request: request, to: current, now: now)
            SessionStore.save(updated)
            Log.info("accepted request, deadline now \(updated.endsAt)")
        } catch let rejection as SessionPolicy.Rejection {
            Log.warn("request rejected: \(rejection)")
        } catch {
            Log.warn("malformed request discarded: \(error)")
        }
    }

    let session = SessionStore.load()
    if let session, session.isActive(at: now) {
        wasActive = true
        enforcer.enforce(session: session, now: now)
        SessionStore.writePublicState(session)
    } else if wasActive {
        wasActive = false
        enforcer.revertAll()
        SessionStore.save(nil)
    } else if session != nil {
        // Expired session left on disk by a crash mid-revert.
        enforcer.revertAll()
        SessionStore.save(nil)
    }

    PeerGuard.ensurePeerAlive(
        label: Paths.watchdogLabel,
        plistPath: Paths.watchdogPlist,
        plistBody: LaunchdPlist.watchdog,
        dryRun: false
    )

    Thread.sleep(forTimeInterval: 1.0)
}
