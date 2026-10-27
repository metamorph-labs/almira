// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Almira",
    platforms: [.macOS(.v13), .iOS(.v16), .tvOS(.v16), .watchOS(.v9)],
    products: [
        .library(name: "Almira", targets: ["Almira"]),
        .library(name: "AlmiraServer", targets: ["AlmiraServer"]),
    ],
    targets: [
        .target(name: "Almira"),
        .target(name: "AlmiraServer", dependencies: ["Almira"]),
        .testTarget(name: "AlmiraTests", dependencies: ["Almira", "AlmiraServer"]),
    ]
)
