import XCTest
@testable import AnvilCore

final class PFAnchorTests: XCTestCase {
    let applePFConf = """
    #
    # Default pf.conf
    #
    scrub-anchor "com.apple/*"
    nat-anchor "com.apple/*"
    rdr-anchor "com.apple/*"
    dummynet-anchor "com.apple/*"
    anchor "com.apple/*"
    load anchor "com.apple" from "/etc/pf.anchors/com.apple"
    """

    func testAnchorIsAppendedAfterExistingRules() {
        let result = PFAnchor.applying(to: applePFConf)
        let ourAnchor = result.range(of: "anchor \"anvil\"")
        let appleAnchor = result.range(of: "load anchor \"com.apple\"")
        XCTAssertNotNil(ourAnchor)
        XCTAssertNotNil(appleAnchor)
        // Filter anchors have to come last in a pf ruleset or the load fails.
        XCTAssertTrue(appleAnchor!.lowerBound < ourAnchor!.lowerBound)
    }

    func testApplyingIsIdempotent() {
        let once = PFAnchor.applying(to: applePFConf)
        let twice = PFAnchor.applying(to: once)
        XCTAssertEqual(once, twice)
    }

    func testStripRestoresAppleDefault() {
        let modified = PFAnchor.applying(to: applePFConf)
        XCTAssertEqual(PFAnchor.stripManagedSection(modified), applePFConf + "\n")
    }

    func testStripRemovesDuplicateSections() {
        var doubled = PFAnchor.applying(to: applePFConf)
        doubled = PFAnchor.applying(to: doubled) + PFAnchor.beginMarker + "\njunk\n" + PFAnchor.endMarker + "\n"
        XCTAssertEqual(PFAnchor.stripManagedSection(doubled), applePFConf + "\n")
    }

    func testAnchorBodyCoversBothTransports() {
        // QUIC rides UDP 443. Blocking only TCP leaves a browser a clean way around
        // the hosts file for any address it has already learned.
        XCTAssertTrue(PFAnchor.anchorBody.contains("proto tcp"))
        XCTAssertTrue(PFAnchor.anchorBody.contains("proto udp"))
        XCTAssertTrue(PFAnchor.anchorBody.contains("443"))
        XCTAssertTrue(PFAnchor.anchorBody.contains("table <anvil_blocked> persist"))
    }

    func testLiteralAddressDetection() {
        XCTAssertTrue(PFAnchor.isLiteralAddress("151.101.1.140"))
        XCTAssertTrue(PFAnchor.isLiteralAddress("2606:4700::6810:85e5"))
        XCTAssertFalse(PFAnchor.isLiteralAddress("reddit.com."))
        XCTAssertFalse(PFAnchor.isLiteralAddress(""))
        XCTAssertFalse(PFAnchor.isLiteralAddress("10 IN A"))
    }
}

final class BrowserPolicyTests: XCTestCase {
    func testPolicyDisablesBothBypassRoutes() {
        XCTAssertEqual(BrowserPolicy.managedKeys["DnsOverHttpsMode"] as? String, "off")
        XCTAssertEqual(BrowserPolicy.managedKeys["QuicAllowed"] as? Bool, false)
    }

    func testPolicyPlistIsSerialisable() throws {
        // Catches a non-plist value being added to managedKeys, which would fail at
        // runtime as root and leave the browser layer silently unapplied.
        let data = try PropertyListSerialization.data(
            fromPropertyList: BrowserPolicy.managedKeys, format: .xml, options: 0
        )
        XCTAssertFalse(data.isEmpty)
    }

    func testEveryChromiumTargetLivesInManagedPreferences() {
        for target in BrowserPolicy.chromiumTargets {
            XCTAssertTrue(target.plistPath.hasPrefix("/Library/Managed Preferences/"))
            XCTAssertTrue(target.plistPath.hasSuffix(".plist"))
        }
    }
}

final class LaunchdPlistTests: XCTestCase {
    func testGeneratedPlistParses() throws {
        let xml = LaunchdPlist.daemon
        let data = Data(xml.utf8)
        let parsed = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        let dict = try XCTUnwrap(parsed as? [String: Any])
        XCTAssertEqual(dict["Label"] as? String, Paths.daemonLabel)
        XCTAssertEqual(dict["KeepAlive"] as? Bool, true)
        XCTAssertEqual(dict["RunAtLoad"] as? Bool, true)
        XCTAssertEqual((dict["ProgramArguments"] as? [String])?.first, Paths.daemonBinary)
    }

    func testWatchdogPlistPointsAtTheWatchdog() throws {
        let data = Data(LaunchdPlist.watchdog.utf8)
        let parsed = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        let dict = try XCTUnwrap(parsed as? [String: Any])
        XCTAssertEqual(dict["Label"] as? String, Paths.watchdogLabel)
        XCTAssertEqual((dict["ProgramArguments"] as? [String])?.first, Paths.watchdogBinary)
    }

    func testTheTwoDaemonsPointAtEachOtherAndNotThemselves() {
        // A copy-paste slip here would leave each daemon watching itself, which looks
        // fine until something kills one and nothing brings it back.
        XCTAssertNotEqual(Paths.daemonLabel, Paths.watchdogLabel)
        XCTAssertNotEqual(Paths.daemonPlist, Paths.watchdogPlist)
        XCTAssertTrue(LaunchdPlist.daemon.contains(Paths.daemonBinary))
        XCTAssertTrue(LaunchdPlist.watchdog.contains(Paths.watchdogBinary))
        XCTAssertFalse(LaunchdPlist.daemon.contains(Paths.watchdogBinary))
    }
}
