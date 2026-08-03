import XCTest
@testable import AnvilCore

final class SessionPolicyTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_700_000_000)

    func preset(name: String = "Test", domains: [String] = ["reddit.com"], apps: [String] = []) -> Preset {
        Preset(name: name, appBundleIDs: apps, domains: domains, defaultMinutes: 60)
    }

    // MARK: - Duration cap

    func testDurationCapIsEnforced() {
        let request = StartRequest(preset: preset(), minutes: Limits.maxMinutes + 1)
        XCTAssertThrowsError(try SessionPolicy.apply(request: request, to: nil, now: now)) { error in
            XCTAssertEqual(error as? SessionPolicy.Rejection, .durationOutOfRange(Limits.maxMinutes + 1))
        }
    }

    func testExactlyTheCapIsAllowed() {
        let request = StartRequest(preset: preset(), minutes: Limits.maxMinutes)
        XCTAssertNoThrow(try SessionPolicy.apply(request: request, to: nil, now: now))
    }

    func testZeroAndNegativeDurationsAreRejected() {
        for minutes in [0, -1, -600] {
            let request = StartRequest(preset: preset(), minutes: minutes)
            XCTAssertThrowsError(try SessionPolicy.apply(request: request, to: nil, now: now))
        }
    }

    func testEmptyPresetCannotStartASession() {
        let request = StartRequest(preset: Preset(name: "Nothing"), minutes: 30)
        XCTAssertThrowsError(try SessionPolicy.apply(request: request, to: nil, now: now)) { error in
            XCTAssertEqual(error as? SessionPolicy.Rejection, .emptyBlocklist)
        }
    }

    // MARK: - The no-early-exit property

    func testDeadlineCannotBeShortened() {
        let current = Session(
            startedAt: now,
            endsAt: now.addingTimeInterval(3600),
            preset: preset()
        )
        // Asking for one minute while sixty remain is the obvious way out, and the
        // protocol has to refuse it. This is the single most important test here.
        let request = StartRequest(preset: preset(), minutes: 1)
        XCTAssertThrowsError(
            try SessionPolicy.apply(request: request, to: current, now: now)
        ) { error in
            XCTAssertEqual(error as? SessionPolicy.Rejection, .wouldNotStrengthen)
        }
    }

    func testDeadlineCanBeExtended() {
        let current = Session(startedAt: now, endsAt: now.addingTimeInterval(600), preset: preset())
        let request = StartRequest(preset: preset(), minutes: 60)
        let updated = try? SessionPolicy.apply(request: request, to: current, now: now)
        XCTAssertEqual(updated?.endsAt, now.addingTimeInterval(3600))
    }

    func testStartedAtSurvivesAnExtension() {
        let started = now.addingTimeInterval(-1800)
        let current = Session(startedAt: started, endsAt: now.addingTimeInterval(600), preset: preset())
        let request = StartRequest(preset: preset(), minutes: 60)
        let updated = try? SessionPolicy.apply(request: request, to: current, now: now)
        XCTAssertEqual(updated?.startedAt, started)
    }

    func testEmptyPresetExtendsAnActiveSessionWithoutChangingTheBlocklist() {
        let current = Session(startedAt: now, endsAt: now.addingTimeInterval(600), preset: preset())
        let request = StartRequest(preset: Preset(name: "Extension"), minutes: 60)
        let updated = try? SessionPolicy.apply(request: request, to: current, now: now)
        XCTAssertEqual(updated?.endsAt, now.addingTimeInterval(3600))
        XCTAssertEqual(updated?.preset.domains, ["reddit.com"])
    }

    // MARK: - Blocklists only widen

    func testShorterRequestStillWidensTheBlocklist() {
        let current = Session(startedAt: now, endsAt: now.addingTimeInterval(3600), preset: preset())
        let request = StartRequest(preset: preset(domains: ["x.com"]), minutes: 5)
        let updated = try? SessionPolicy.apply(request: request, to: current, now: now)
        XCTAssertEqual(updated?.preset.domains, ["reddit.com", "x.com"])
        XCTAssertEqual(updated?.endsAt, now.addingTimeInterval(3600), "the deadline must not move earlier")
    }

    func testANarrowerPresetNeverRemovesEntries() {
        let wide = preset(domains: ["reddit.com", "x.com"], apps: ["com.tinyspeck.slackmacgap"])
        let current = Session(startedAt: now, endsAt: now.addingTimeInterval(3600), preset: wide)
        let request = StartRequest(preset: preset(domains: ["reddit.com"]), minutes: 120)
        let updated = try? SessionPolicy.apply(request: request, to: current, now: now)
        XCTAssertEqual(updated?.preset.domains, ["reddit.com", "x.com"])
        XCTAssertEqual(updated?.preset.appBundleIDs, ["com.tinyspeck.slackmacgap"])
    }

    // MARK: - Expiry

    func testAnExpiredSessionIsTreatedAsNoSession() {
        let expired = Session(
            startedAt: now.addingTimeInterval(-7200),
            endsAt: now.addingTimeInterval(-60),
            preset: preset(domains: ["old.com"])
        )
        let request = StartRequest(preset: preset(domains: ["new.com"]), minutes: 30)
        let updated = try? SessionPolicy.apply(request: request, to: expired, now: now)
        XCTAssertEqual(updated?.preset.domains, ["new.com"], "an expired blocklist must not linger")
        XCTAssertEqual(updated?.startedAt, now)
    }

    func testIsActiveBoundary() {
        let session = Session(startedAt: now, endsAt: now.addingTimeInterval(60), preset: preset())
        XCTAssertTrue(session.isActive(at: now))
        XCTAssertFalse(session.isActive(at: now.addingTimeInterval(60)))
        XCTAssertFalse(session.isActive(at: now.addingTimeInterval(61)))
    }

    // MARK: - Codec

    func testRequestRoundTrips() throws {
        let request = StartRequest(preset: preset(domains: ["a.com"], apps: ["com.x.y"]), minutes: 45)
        let data = try SessionStore.encodeRequest(request)
        let decoded = try SessionStore.decodeRequest(data)
        XCTAssertEqual(decoded.minutes, 45)
        XCTAssertEqual(decoded.preset.domains, ["a.com"])
        XCTAssertEqual(decoded.preset.appBundleIDs, ["com.x.y"])
    }

    func testMalformedPayloadIsRejected() {
        XCTAssertThrowsError(try SessionStore.decodeRequest(Data("not json".utf8)))
        XCTAssertThrowsError(try SessionStore.decodeRequest(Data(#"{"minutes":5}"#.utf8)))
    }

    func testARequestStaysWellUnderTheSocketCap() throws {
        let big = Preset(
            name: String(repeating: "n", count: 60),
            appBundleIDs: (0..<20).map { "com.example.app\($0)" },
            domains: (0..<20).map { "domain\($0).com" },
            defaultMinutes: 60
        )
        let data = try SessionStore.encodeRequest(StartRequest(preset: big, minutes: 60))
        XCTAssertLessThan(data.count, Limits.maxRequestBytes)
    }
}
