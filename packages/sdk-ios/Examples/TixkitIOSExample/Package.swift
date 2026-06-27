// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "TixkitIOSExample",
  platforms: [
    .iOS(.v15),
    .macOS(.v12),
  ],
  dependencies: [
    .package(path: "../.."),
  ],
  targets: [
    .executableTarget(name: "TixkitIOSExample", dependencies: [
      .product(name: "TixkitIOS", package: "sdk-ios"),
    ]),
  ]
)
