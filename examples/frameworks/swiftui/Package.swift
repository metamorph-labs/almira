// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AlmiraSwiftUIExample",
    platforms: [.macOS(.v13)],
    dependencies: [.package(path: "../../../sdks/swift")],
    targets: [
        .executableTarget(
            name: "AlmiraSwiftUIExample",
            dependencies: [.product(name: "Almira", package: "swift")]
        ),
    ]
)
