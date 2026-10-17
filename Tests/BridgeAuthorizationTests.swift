import Foundation
import Darwin

@main struct BridgeAuthorizationTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        defer { try? FileManager.default.removeItem(at:root) }
        let file=root.appendingPathComponent("client.key"), key=String(repeating:"S",count:64)
        var assertions=0
        func write(_ value:String, mode:Int=0o600) throws {
            try? FileManager.default.removeItem(at:file)
            try Data(value.utf8).write(to:file)
            try FileManager.default.setAttributes([.posixPermissions:mode],ofItemAtPath:file.path)
        }
        func rejected(_ message:String) {
            assertions += 1
            do { _ = try BridgeAuthorization.readKey(at:file); preconditionFailure(message) } catch {}
        }
        for value in [key,key+"\n"] {
            try write(value); let actual=try BridgeAuthorization.readKey(at:file); precondition(actual==key); assertions += 1
        }
        for value in ["",String(repeating:"S",count:63),String(repeating:"S",count:65),key+"\n\n",String(repeating:"!",count:64)] {
            try write(value); rejected("Malformed credential must be rejected")
        }
        for mode in [0o644,0o400,0o700] { try write(key,mode:mode); rejected("Credential mode must match backend contract") }
        try write(key); let alias=root.appendingPathComponent("alias.key")
        try FileManager.default.linkItem(at:file,to:alias); rejected("Hardlinked credential must be rejected")
        try FileManager.default.removeItem(at:file); try FileManager.default.createSymbolicLink(at:file,withDestinationURL:alias); rejected("Symlink credential must be rejected")
        try FileManager.default.removeItem(at:file)
        precondition(mkfifo(file.path,0o600)==0)
        let start=Date(); rejected("FIFO credential must be rejected without blocking")
        precondition(Date().timeIntervalSince(start)<2)
        print("Native authorization tests: \(assertions) cases passed; no real credential read")
    }
}
