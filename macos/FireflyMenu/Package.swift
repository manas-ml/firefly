// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FireflyMenu",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "FireflyMenu", path: "Sources/FireflyMenu")
    ]
)
