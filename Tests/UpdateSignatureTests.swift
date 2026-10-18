import CryptoKit
import Foundation

@main
struct UpdateSignatureTests {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else { fatalError("Pass the compiled verify-update executable") }
        let verifier = URL(fileURLWithPath: CommandLine.arguments[1])
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("codex-ultra-signatures-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let archive = directory.appendingPathComponent("ClaudeCodex-macOS.zip")
        let feed = directory.appendingPathComponent("appcast.xml")
        let payload = Data("test archive bytes".utf8)
        let key = Curve25519.Signing.PrivateKey()
        let publicKey = key.publicKey.rawRepresentation.base64EncodedString()
        let archiveSignature = try key.signature(for: payload).base64EncodedString()
        let validXML = """
        <?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Claude Codex</title><item><sparkle:version>2</sparkle:version><sparkle:shortVersionString>1.0.0</sparkle:shortVersionString><enclosure url="https://github.com/reyhenrick/claude-codex/releases/download/v1.0.0/ClaudeCodex-macOS.zip" type="application/octet-stream" length="\(payload.count)" sparkle:edSignature="\(archiveSignature)"/></item></channel></rss>
        """
        func signed(_ xml: String) throws -> Data {
            let content = Data((xml + "\n").utf8)
            let signature = try key.signature(for: content).base64EncodedString()
            return content + Data("<!-- sparkle-signatures:\nedSignature: \(signature)\nlength: \(content.count)\n-->\n".utf8)
        }
        var tests = 0
        func verify(_ name: String, bytes: Data, archiveBytes: Data = payload, trustedKey: String = publicKey, succeeds: Bool = false) throws {
            try bytes.write(to: feed)
            try archiveBytes.write(to: archive)
            let process = Process()
            process.executableURL = verifier
            process.arguments = [feed.path, archive.path, trustedKey, "2", "1.0.0"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            process.waitUntilExit()
            guard (process.terminationStatus == 0) == succeeds else { fatalError("Signature test failed: \(name)") }
            tests += 1
        }
        let valid = try signed(validXML)
        try verify("valid feed and archive", bytes: valid, succeeds: true)
        try verify("unsigned feed", bytes: Data(validXML.utf8))
        try verify("appended unsigned data", bytes: valid + Data("unsigned".utf8))
        try verify("changed signed XML", bytes: Data(String(decoding: valid, as: UTF8.self).replacingOccurrences(of: "Claude Codex", with: "Other Product").utf8))
        try verify("tampered archive same length", bytes: valid, archiveBytes: Data(repeating: 65, count: payload.count))
        try verify("tampered archive length", bytes: valid, archiveBytes: payload + Data([1]))
        try verify("wrong trusted key", bytes: valid, trustedKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString())
        try verify("signed wrong download URL", bytes: signed(validXML.replacingOccurrences(of: "reyhenrick/claude-codex", with: "someone/else")))
        try verify("signed wrong version", bytes: signed(validXML.replacingOccurrences(of: "<sparkle:version>2", with: "<sparkle:version>3")))
        try verify("signed external release notes", bytes: signed(validXML.replacingOccurrences(of: "</item>", with: "<sparkle:releaseNotesLink>https://example.com</sparkle:releaseNotesLink></item>")))
        try verify("signed delta element", bytes: signed(validXML.replacingOccurrences(of: "</item>", with: "<sparkle:deltas/></item>")))
        try verify("signed document type", bytes: signed(validXML.replacingOccurrences(of: "<rss ", with: "<!DOCTYPE rss><rss ")))
        print("Update signature tests: \(tests) cases passed")
    }
}
