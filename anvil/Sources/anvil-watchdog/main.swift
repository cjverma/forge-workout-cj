import AnvilCore
import Foundation

// anvil-watchdog — the other half of the resurrection pair.
//
// It does one job: make sure anvild is loaded and its plist exists, once a second.
// anvild does the same for this process, so removing either one alone heals.
//
// This does not make the pair invulnerable, and the code does not pretend it does.
// A prepared root command that boots out both in one line wins the race. The
// durable defenses are elsewhere: Terminal is dead during a session, and the
// deadline lives in root-owned state, so a reboot re-arms the block.

Log.name = "anvil-watchdog"

guard getuid() == 0 else {
    FileHandle.standardError.write("anvil-watchdog must run as root\n".data(using: .utf8)!)
    exit(1)
}

PeerGuard.ignoreTerminationSignals()

let lock = InstanceLock()
guard lock.acquire(path: Paths.watchdogLock) else {
    Log.error("another watchdog already holds the lock, exiting")
    exit(0)
}

Log.info("watching \(Paths.daemonLabel)")

while true {
    PeerGuard.ensurePeerAlive(
        label: Paths.daemonLabel,
        plistPath: Paths.daemonPlist,
        plistBody: LaunchdPlist.daemon,
        dryRun: false
    )
    Thread.sleep(forTimeInterval: 1.0)
}
