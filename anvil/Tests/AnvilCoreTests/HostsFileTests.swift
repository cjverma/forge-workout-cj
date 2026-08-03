import XCTest
@testable import AnvilCore

final class HostsFileTests: XCTestCase {
    let userContent = """
    ##
    # Host Database
    ##
    127.0.0.1	localhost
    255.255.255.255	broadcasthost
    ::1             localhost
    10.0.0.5        my-nas.local
    """

    func testNormalizeStripsSchemePathPortAndWWW() {
        XCTAssertEqual(HostsFile.normalize("https://www.Reddit.com/r/all"), "reddit.com")
        XCTAssertEqual(HostsFile.normalize("http://news.ycombinator.com"), "news.ycombinator.com")
        XCTAssertEqual(HostsFile.normalize("example.com:8080"), "example.com")
        XCTAssertEqual(HostsFile.normalize("  EXAMPLE.com.  "), "example.com")
    }

    func testNormalizeRejectsNonDomains() {
        XCTAssertNil(HostsFile.normalize(""))
        XCTAssertNil(HostsFile.normalize("   "))
        XCTAssertNil(HostsFile.normalize("# a comment"))
        XCTAssertNil(HostsFile.normalize("localhost"))
        XCTAssertNil(HostsFile.normalize("two words.com"))
    }

    func testExpandCoversApexAndWWW() {
        let hosts = HostsFile.expand(domains: ["reddit.com"], includeDoHEndpoints: false)
        XCTAssertEqual(hosts, ["reddit.com", "www.reddit.com"])
    }

    func testExpandDeduplicatesEquivalentInputs() {
        let hosts = HostsFile.expand(
            domains: ["reddit.com", "www.reddit.com", "https://reddit.com/r/x"],
            includeDoHEndpoints: false
        )
        XCTAssertEqual(hosts, ["reddit.com", "www.reddit.com"])
    }

    func testExpandAddsDoHEndpointsOnlyWhenBlocking() {
        XCTAssertTrue(HostsFile.expand(domains: [], includeDoHEndpoints: true).isEmpty)
        let hosts = HostsFile.expand(domains: ["reddit.com"], includeDoHEndpoints: true)
        XCTAssertTrue(hosts.contains("mozilla.cloudflare-dns.com"))
        XCTAssertTrue(hosts.contains("dns.google"))
    }

    func testApplyingPreservesUserContent() {
        let result = HostsFile.applying(domains: ["reddit.com"], to: userContent)
        XCTAssertTrue(result.contains("127.0.0.1\tlocalhost"))
        XCTAssertTrue(result.contains("10.0.0.5        my-nas.local"))
        XCTAssertTrue(result.contains("0.0.0.0 reddit.com"))
        XCTAssertTrue(result.contains(":: www.reddit.com"))
    }

    func testApplyingIsIdempotent() {
        let once = HostsFile.applying(domains: ["reddit.com", "x.com"], to: userContent)
        let twice = HostsFile.applying(domains: ["reddit.com", "x.com"], to: once)
        XCTAssertEqual(once, twice, "a second pass must not stack a second managed block")
    }

    func testApplyingIsStableAcrossInputOrdering() {
        let a = HostsFile.applying(domains: ["x.com", "reddit.com"], to: userContent)
        let b = HostsFile.applying(domains: ["reddit.com", "x.com"], to: userContent)
        XCTAssertEqual(a, b, "reordering the blocklist must not look like drift")
    }

    func testStripRestoresOriginal() {
        let blocked = HostsFile.applying(domains: ["reddit.com"], to: userContent)
        let stripped = HostsFile.stripManagedSection(blocked)
        XCTAssertEqual(stripped, userContent + "\n")
    }

    func testStripRemovesDuplicateSectionsLeftByACrash() {
        var doubled = HostsFile.applying(domains: ["reddit.com"], to: userContent)
        doubled += HostsFile.renderManagedSection(domains: ["x.com"]) + "\n"
        let stripped = HostsFile.stripManagedSection(doubled)
        XCTAssertFalse(stripped.contains("0.0.0.0"))
        XCTAssertEqual(stripped, userContent + "\n")
    }

    func testUnterminatedSectionStripsToEndOfFile() {
        let broken = userContent + "\n" + HostsFile.beginMarker + "\n0.0.0.0 reddit.com\n"
        let stripped = HostsFile.stripManagedSection(broken)
        XCTAssertEqual(stripped, userContent + "\n")
    }

    func testStripOnFileWithNoMarkersChangesNothingMeaningful() {
        XCTAssertEqual(HostsFile.stripManagedSection(userContent), userContent + "\n")
    }

    func testEmptyDomainListWritesNoSection() {
        let result = HostsFile.applying(domains: [], to: userContent)
        XCTAssertFalse(result.contains(HostsFile.beginMarker))
    }
}
