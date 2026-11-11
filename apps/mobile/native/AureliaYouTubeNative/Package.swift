// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AureliaYouTubeNative",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "AureliaYouTubeNative", targets: ["AureliaYouTubeNative"]),
        .executable(name: "AureliaYouTubeNativeProbe", targets: ["AureliaYouTubeNativeProbe"])
    ],
    dependencies: [.package(path: "../AureliaPlayback")],
    targets: [
        .binaryTarget(name: "AureliaQuack", path: "Artifacts/AureliaQuack.xcframework"),
        .target(name: "AureliaYouTubeNative", dependencies: [
            "AureliaQuack", .product(name: "AureliaPlaybackCore", package: "AureliaPlayback")
        ], linkerSettings: [.linkedLibrary("c++")]),
        .executableTarget(name: "AureliaYouTubeNativeProbe", dependencies: [
            "AureliaYouTubeNative", .product(name: "AureliaPlaybackCore", package: "AureliaPlayback")
        ])
    ]
)
