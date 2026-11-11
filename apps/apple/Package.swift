// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AureliaApple",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "AureliaAppleUI", targets: ["AureliaAppleUI"]),
        .executable(name: "AureliaMac", targets: ["AureliaMac"])
    ],
    dependencies: [
        .package(path: "../mobile/native/AureliaPlayback"),
        .package(path: "../mobile/native/AureliaYouTubeNative")
    ],
    targets: [
        .target(name: "AureliaCloud"),
        .target(name: "AureliaAppleUI", dependencies: [
            "AureliaCloud",
            .product(name: "AureliaPlaybackCore", package: "AureliaPlayback")
        ], resources: [.copy("Resources/Audio"), .process("Resources/Art")]),
        .executableTarget(name: "AureliaMac", dependencies: ["AureliaAppleUI",
            .product(name: "AureliaYouTubeNative", package: "AureliaYouTubeNative")
        ]),
        .executableTarget(name: "AureliaAppleChecks", dependencies: ["AureliaAppleUI", "AureliaCloud",
            .product(name: "AureliaPlaybackCore", package: "AureliaPlayback")
        ], path: "Tests/AureliaAppleChecks"),
        .executableTarget(name: "AureliaCloudChecks", dependencies: ["AureliaCloud"], path: "Tests/AureliaCloudChecks")
    ]
)
