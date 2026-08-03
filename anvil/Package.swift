// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Anvil",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "AnvilCore"),
        .executableTarget(name: "anvild", dependencies: ["AnvilCore"]),
        .executableTarget(name: "anvil-watchdog", dependencies: ["AnvilCore"]),
        .executableTarget(name: "AnvilApp", dependencies: ["AnvilCore"]),
        .testTarget(name: "AnvilCoreTests", dependencies: ["AnvilCore"]),
    ]
)
