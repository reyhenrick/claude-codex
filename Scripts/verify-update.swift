import CryptoKit
import Foundation

struct UpdateVerificationError: Error, CustomStringConvertible {
    let description: String
}

func require(_ condition: Bool, _ message: String) throws {
    guard condition else {
        throw UpdateVerificationError(description: message)
    }
}

func decoded(_ value: String, bytes: Int, name: String) throws -> Data {
    guard let result = Data(base64Encoded: value), result.count == bytes,
          result.base64EncodedString() == value else {
        throw UpdateVerificationError(description: "Invalid \(name)")
    }
    return result
}

func unsignedContent(_ feed: Data, publicKey: Curve25519.Signing.PublicKey) throws -> Data {
    let marker = Data("<!-- sparkle-signatures:\n".utf8)
    guard let signatureRange = feed.range(of: marker, options: .backwards) else {
        throw UpdateVerificationError(description: "Missing signed-feed trailer")
    }
    let content = Data(feed[..<signatureRange.lowerBound])
    try require(content.range(of: marker) == nil, "Multiple signed-feed trailers")
    guard let trailer = String(data: feed[signatureRange.lowerBound...], encoding: .utf8) else {
        throw UpdateVerificationError(description: "Invalid signed-feed trailer encoding")
    }
    let expression = try NSRegularExpression(pattern: "\\A<!-- sparkle-signatures:\\nedSignature: ([A-Za-z0-9+/]{86}==)\\nlength: ([1-9][0-9]*)\\n-->\\n?\\z")
    guard let match = expression.firstMatch(in: trailer, range: NSRange(trailer.startIndex..., in: trailer)),
          let signatureRange = Range(match.range(at: 1), in: trailer),
          let lengthRange = Range(match.range(at: 2), in: trailer),
          let expectedLength = UInt64(trailer[lengthRange]) else {
        throw UpdateVerificationError(description: "Malformed signed-feed trailer or unsigned trailing data")
    }
    try require(expectedLength == UInt64(content.count), "Signed-feed length mismatch")
    let signature = try decoded(String(trailer[signatureRange]), bytes: 64, name: "feed signature")
    try require(publicKey.isValidSignature(signature, for: content), "Feed signature verification failed")
    return content
}

func scalar(_ element: XMLElement, _ name: String, namespace: String) throws -> String {
    let matches = element.elements(forLocalName: name, uri: namespace)
    try require(matches.count == 1, "Expected one sparkle:\(name)")
    try require(!(matches[0].children ?? []).contains { $0.kind == .element }, "Invalid sparkle:\(name)")
    return (matches[0].stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
}

func verify(feedURL: URL, archiveURL: URL, key: String, build: String, version: String) throws {
    try require(build.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil, "Invalid expected build number")
    try require(version.range(of: "^[0-9]+\\.[0-9]+\\.[0-9]+$", options: .regularExpression) != nil, "Invalid expected version")
    let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: decoded(key, bytes: 32, name: "public key"))
    let feed = try Data(contentsOf: feedURL)
    let content = try unsignedContent(feed, publicKey: publicKey)
    try require(String(data: content, encoding: .utf8) != nil && !content.contains(0), "Feed must be UTF-8 XML")
    try require(content.range(of: Data("<!DOCTYPE".utf8)) == nil && content.range(of: Data("<!ENTITY".utf8)) == nil, "Feed document types and entities are not allowed")
    let document = try XMLDocument(data: content, options: [.nodeLoadExternalEntitiesNever, .nodePreserveWhitespace])
    guard let root = document.rootElement(), root.name == "rss", root.uri == nil else {
        throw UpdateVerificationError(description: "Expected an RSS feed")
    }
    let namespace = "http://www.andymatuschak.org/xml-namespaces/sparkle"
    try require(root.namespace(forPrefix: "sparkle")?.stringValue == namespace, "Unexpected Sparkle namespace")
    let channels = root.elements(forName: "channel")
    try require(channels.count == 1, "Expected one release channel")
    let items = channels[0].elements(forName: "item")
    let allItems = try document.nodes(forXPath: "//*[local-name() = 'item']")
    try require(items.count == 1 && allItems.count == 1, "Expected one release item")
    let item = items[0]
    try require(try scalar(item, "version", namespace: namespace) == build, "Feed build number does not match the application")
    try require(try scalar(item, "shortVersionString", namespace: namespace) == version, "Feed version does not match the application")
    let deltas = try document.nodes(forXPath: "//*[local-name() = 'deltas']")
    try require(deltas.isEmpty, "Delta updates are not allowed")
    let externalNotes = try document.nodes(forXPath: "//*[local-name() = 'releaseNotesLink']")
    try require(externalNotes.isEmpty, "Release notes must be embedded in the signed feed")
    let enclosures = item.elements(forName: "enclosure")
    let allEnclosures = try document.nodes(forXPath: "//*[local-name() = 'enclosure']")
    try require(enclosures.count == 1 && allEnclosures.count == 1, "Expected one update enclosure")
    let enclosure = enclosures[0]
    let expectedURL = "https://github.com/reyhenrick/claude-codex/releases/download/v\(version)/ClaudeCodex-macOS.zip"
    try require(enclosure.attribute(forName: "url")?.stringValue == expectedURL, "Update URL must use the matching immutable release tag")
    try require(enclosure.attribute(forName: "type")?.stringValue == "application/octet-stream", "Unexpected archive content type")
    try require(enclosure.attribute(forLocalName: "version", uri: namespace) == nil && enclosure.attribute(forLocalName: "shortVersionString", uri: namespace) == nil, "Enclosure version attributes are not allowed")
    try require(enclosure.attribute(forLocalName: "deltaFrom", uri: namespace) == nil, "Delta archives are not allowed")
    guard let lengthText = enclosure.attribute(forName: "length")?.stringValue,
          lengthText.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil,
          let expectedLength = UInt64(lengthText),
          let signatureText = enclosure.attribute(forLocalName: "edSignature", uri: namespace)?.stringValue else {
        throw UpdateVerificationError(description: "Missing or invalid archive signature and length")
    }
    let signature = try decoded(signatureText, bytes: 64, name: "archive signature")
    let archive = try Data(contentsOf: archiveURL, options: .mappedIfSafe)
    try require(expectedLength == UInt64(archive.count), "Archive length mismatch")
    try require(publicKey.isValidSignature(signature, for: archive), "Archive signature verification failed")
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    try require(arguments.count == 5, "Usage: xcrun swift Scripts/verify-update.swift APPCAST ZIP PUBLIC_KEY BUNDLE_VERSION SHORT_VERSION")
    try verify(feedURL: URL(fileURLWithPath: arguments[0]), archiveURL: URL(fileURLWithPath: arguments[1]), key: arguments[2], build: arguments[3], version: arguments[4])
    print("Verified signed update: Claude Codex \(arguments[4]), build \(arguments[3])")
} catch {
    FileHandle.standardError.write(Data("Update verification failed: \(error)\n".utf8))
    exit(1)
}
