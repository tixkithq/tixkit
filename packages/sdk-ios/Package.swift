// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "TixkitIOS",
  platforms: [
    .iOS(.v15),
    .macOS(.v12),
  ],
  products: [
    .library(name: "TixkitIOS", targets: ["TixkitIOS"]),
  ],
  targets: [
    .target(name: "TixkitIOS"),
    .testTarget(name: "TixkitIOSTests", dependencies: ["TixkitIOS"]),
  ]
)
