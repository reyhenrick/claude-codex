import Foundation
import Darwin

enum BridgeAuthorization {
    enum Failure: Error { case missingOrUnsafeKey }
    static func readKey(at file: URL? = nil) throws -> String {
        let path = (file ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Claude Codex Bridge/pool/client.key")).path
        let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw Failure.missingOrUnsafeKey }
        defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == getuid(), info.st_nlink == 1, info.st_mode & 0o777 == 0o600,
              [64, 65].contains(info.st_size) else { throw Failure.missingOrUnsafeKey }
        var bytes = [UInt8](repeating: 0, count: 67)
        let count = read(descriptor, &bytes, bytes.count)
        guard count == info.st_size, let value = String(bytes: bytes.prefix(count), encoding: .utf8) else { throw Failure.missingOrUnsafeKey }
        let key = value.hasSuffix("\n") ? String(value.dropLast()) : value
        guard key.count == 64, key.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }) else { throw Failure.missingOrUnsafeKey }
        return key
    }
    static func apply(to request: inout URLRequest) throws {
        request.setValue("Bearer " + (try readKey()), forHTTPHeaderField: "Authorization")
    }
}
