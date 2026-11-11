// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AureliaPlayback",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [.library(name: "AureliaPlaybackCore", targets: ["AureliaPlaybackCore"])],
    targets: [
        .target(name: "AureliaPlaybackCore"),
        .executableTarget(
            name: "AureliaPlaybackCoreChecks", dependencies: ["AureliaPlaybackCore"],
            path: "Tests/AureliaPlaybackCoreTests"
        )
    ]
)
