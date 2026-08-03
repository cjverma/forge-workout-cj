import Foundation

/// Every filesystem location Anvil touches, in one place.
///
/// The support directory is root-owned and mode 0755: no part of it is writable
/// by an unprivileged user, but `public-state.json` stays readable so the menu
/// bar app can render a countdown without elevation. `state.json` (the real
/// deadline) is 0600 and never readable by the user.
public enum Paths {
    public static let support = "/Library/Application Support/Anvil"
    public static let bin = support + "/bin"
    public static let state = support + "/state.json"
    public static let publicState = support + "/public-state.json"
    public static let lock = support + "/anvild.lock"
    public static let watchdogLock = support + "/watchdog.lock"
    public static let policyBackups = support + "/policy-backups"
    public static let pfConfBackup = support + "/pf.conf.orig"

    public static let socket = "/var/run/anvil.sock"

    public static let hosts = "/etc/hosts"
    public static let pfConf = "/etc/pf.conf"
    public static let pfAnchorFile = "/etc/pf.anchors/anvil"

    public static let daemonLabel = "com.cjverma.anvild"
    public static let watchdogLabel = "com.cjverma.anvil-watchdog"
    public static let daemonPlist = "/Library/LaunchDaemons/com.cjverma.anvild.plist"
    public static let watchdogPlist = "/Library/LaunchDaemons/com.cjverma.anvil-watchdog.plist"

    public static let daemonBinary = bin + "/anvild"
    public static let watchdogBinary = bin + "/anvil-watchdog"

    public static let logDaemon = "/var/log/anvild.log"
    public static let logWatchdog = "/var/log/anvil-watchdog.log"

    /// Presets belong to the user, not to root.
    public static var userPresets: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return home + "/Library/Application Support/Anvil/presets.json"
    }
}
