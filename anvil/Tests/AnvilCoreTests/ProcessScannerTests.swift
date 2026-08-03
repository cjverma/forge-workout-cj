import XCTest
@testable import AnvilCore

final class ProcessScannerTests: XCTestCase {
    let terminalPath = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"
    let dockPath = "/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock"
    let slackPath = "/Applications/Slack.app/Contents/MacOS/Slack"

    func process(
        pid: pid_t = 5000,
        uid: uid_t = 501,
        path: String,
        command: String? = nil,
        bundleID: String?,
        bundlePath: String? = nil
    ) -> RunningProcess {
        RunningProcess(
            pid: pid,
            uid: uid,
            executablePath: path,
            command: command ?? path,
            bundleID: bundleID,
            bundlePath: bundlePath
        )
    }

    // MARK: - The guard pair
    //
    // These two assertions catch a regression in either direction: a guard list so
    // broad that escape-tool blocking silently stops working, or so narrow that the
    // daemon can log you out. A blanket "/System/" prefix breaks the first one,
    // because Terminal lives under /System/Applications on macOS 13+.

    func testTerminalIsKillable() {
        XCTAssertFalse(
            ProcessScanner.isProtected(
                pid: 5000, uid: 501, executablePath: terminalPath, bundleID: "com.apple.Terminal"
            ),
            "Terminal must be killable or blocking the escape tools does nothing"
        )
    }

    func testDockIsProtected() {
        XCTAssertTrue(
            ProcessScanner.isProtected(
                pid: 5000, uid: 501, executablePath: dockPath, bundleID: "com.apple.dock"
            )
        )
    }

    func testSystemSettingsAndActivityMonitorAreKillable() {
        let cases = [
            ("/System/Applications/System Settings.app/Contents/MacOS/System Settings", "com.apple.systempreferences"),
            ("/System/Applications/Utilities/Activity Monitor.app/Contents/MacOS/Activity Monitor", "com.apple.ActivityMonitor"),
        ]
        for (path, bundleID) in cases {
            XCTAssertFalse(
                ProcessScanner.isProtected(pid: 5000, uid: 501, executablePath: path, bundleID: bundleID),
                "\(bundleID) must be killable"
            )
        }
    }

    func testSystemServicesAreProtected() {
        for path in ["/usr/libexec/secinitd", "/usr/sbin/cfprefsd", "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow", "/bin/zsh"] {
            XCTAssertTrue(
                ProcessScanner.isProtected(pid: 5000, uid: 501, executablePath: path, bundleID: nil),
                "\(path) must be protected"
            )
        }
    }

    func testLowPIDsAndRootProcessesAreProtected() {
        XCTAssertTrue(ProcessScanner.isProtected(pid: 1, uid: 0, executablePath: "/sbin/launchd", bundleID: nil))
        XCTAssertTrue(ProcessScanner.isProtected(pid: 42, uid: 501, executablePath: slackPath, bundleID: "com.tinyspeck.slackmacgap"))
        // Root-owned covers Anvil's own daemons, which must never kill themselves.
        XCTAssertTrue(ProcessScanner.isProtected(pid: 9000, uid: 0, executablePath: "/Library/Application Support/Anvil/bin/anvild", bundleID: nil))
    }

    func testEveryProtectedBundleIDIsActuallyProtected() {
        for bundleID in ProcessScanner.protectedBundleIDs {
            XCTAssertTrue(
                ProcessScanner.isProtected(
                    pid: 5000, uid: 501, executablePath: "/Applications/Whatever.app/Contents/MacOS/W", bundleID: bundleID
                ),
                "\(bundleID) must be protected regardless of path"
            )
        }
    }

    func testNoEscapeToolIsAlsoOnTheProtectedList() {
        // A bundle ID on both lists would make the feature a silent no-op.
        let overlap = ProcessScanner.escapeToolBundleIDs.intersection(ProcessScanner.protectedBundleIDs)
        XCTAssertTrue(overlap.isEmpty, "escape tools cannot also be protected: \(overlap)")
    }

    // MARK: - Matching

    func testMatchesOnBundleIDRegardlessOfPath() {
        let preset = Preset(name: "P", appBundleIDs: ["com.tinyspeck.slackmacgap"])
        // The renamed-and-moved case: path matching alone would miss all of these.
        let disguises = [
            "/Applications/Slack2.app/Contents/MacOS/Slack",
            "/tmp/Totally Not Slack.app/Contents/MacOS/Slack",
            "/Users/me/Applications/Slack.app/Contents/MacOS/Slack",
        ]
        for path in disguises {
            let running = process(path: path, bundleID: "com.tinyspeck.slackmacgap")
            XCTAssertTrue(ProcessScanner.matches(running, preset: preset), "should match \(path)")
        }
    }

    func testMatchesOnPathPrefixWhenBundleIDIsUnavailable() {
        let preset = Preset(name: "P", appPaths: ["/Applications/Slack.app"])
        let running = process(path: slackPath, bundleID: nil)
        XCTAssertTrue(ProcessScanner.matches(running, preset: preset))
    }

    func testMatchesOnCommandLineForBareBinaries() {
        let preset = Preset(name: "P", appBundleIDs: ["com.tinyspeck.slackmacgap"])
        let running = process(
            path: "/opt/homebrew/bin/launcher",
            command: "/opt/homebrew/bin/launcher --app com.tinyspeck.slackmacgap",
            bundleID: nil
        )
        XCTAssertTrue(ProcessScanner.matches(running, preset: preset))
    }

    func testUnrelatedProcessesDoNotMatch() {
        let preset = Preset(name: "P", appBundleIDs: ["com.tinyspeck.slackmacgap"], appPaths: ["/Applications/Slack.app"])
        let running = process(path: "/Applications/Xcode.app/Contents/MacOS/Xcode", bundleID: "com.apple.dt.Xcode")
        XCTAssertFalse(ProcessScanner.matches(running, preset: preset))
    }

    // MARK: - Kill list

    func testGuardListOutranksEveryMatchingRule() {
        // Even naming Dock explicitly in a preset must not get it killed.
        let preset = Preset(name: "Bad", appBundleIDs: ["com.apple.dock"], appPaths: ["/System/Library/"])
        let processes = [
            process(pid: 300, path: dockPath, bundleID: "com.apple.dock"),
            process(pid: 301, path: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder", bundleID: "com.apple.finder"),
        ]
        let targets = ProcessScanner.killTargets(among: processes, preset: preset, includeEscapeTools: true)
        XCTAssertTrue(targets.isEmpty, "the guard list must win over any preset")
    }

    func testEscapeToolsAreKilledOnlyWhenEnabled() {
        let preset = Preset(name: "P", domains: ["reddit.com"])
        let processes = [process(pid: 400, path: terminalPath, bundleID: "com.apple.Terminal")]

        XCTAssertEqual(
            ProcessScanner.killTargets(among: processes, preset: preset, includeEscapeTools: true).count, 1
        )
        XCTAssertTrue(
            ProcessScanner.killTargets(among: processes, preset: preset, includeEscapeTools: false).isEmpty,
            "test mode must leave the shell alone"
        )
    }

    func testBrowserDetection() {
        let processes = [
            process(pid: 500, path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", bundleID: "com.google.Chrome"),
            process(pid: 501, path: slackPath, bundleID: "com.tinyspeck.slackmacgap"),
        ]
        let browsers = ProcessScanner.runningBrowsers(among: processes)
        XCTAssertEqual(browsers.map(\.pid), [500])
    }

    // MARK: - ps parsing

    func testSplitLeadingIntHandlesPaddingAndPathsWithSpaces() {
        let line = "  501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        let first = ProcessScanner.splitLeadingInt(line)
        XCTAssertEqual(first?.0, 501)
        XCTAssertEqual(first?.1, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    }

    func testSplitLeadingIntRejectsGarbage() {
        XCTAssertNil(ProcessScanner.splitLeadingInt(""))
        XCTAssertNil(ProcessScanner.splitLeadingInt("no-numbers-here"))
    }
}
