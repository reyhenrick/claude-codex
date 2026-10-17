import AppKit
import Foundation

@main
@MainActor
struct UpdateRecoveryHelper {
    static func main() async {
        let store = UpdateRecoveryStore()
        do {
            guard CommandLine.arguments.count == 3,
                  CommandLine.arguments[1] == store.recordURL.path,
                  let transaction = UUID(uuidString: CommandLine.arguments[2]),
                  let record = try store.load(), record.id == transaction,
                  URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL == store.helperURL else {
                throw UpdateRecoveryFailure.unsafeRecord
            }
            try store.validateJobFile(record: record)
            var executable = stat()
            guard lstat(store.helperURL.path, &executable) == 0,
                  executable.st_mode & S_IFMT == S_IFREG, executable.st_uid == getuid(),
                  executable.st_mode & 0o077 == 0, executable.st_mode & 0o100 != 0 else {
                throw UpdateRecoveryFailure.unsafeRecord
            }
            let application = URL(fileURLWithPath: record.applicationPath)
            var previousNote = ""
            var previousNoteTime: TimeInterval = 0
            let supervisor = UpdateRecoverySupervisor(operations: .init(
                recordIsCurrent: {
                    guard let current = try store.load() else { return false }
                    guard current == record else { throw UpdateRecoveryFailure.unsafeRecord }
                    return true
                },
                ownerIsRunning: { record.owner.isRunning },
                installersAreRunning: {
                    try await UpdateInstallerActivity.isRunning(record: record)
                },
                applicationIsValid: {
                    guard application.resolvingSymlinksInPath() == application,
                          let data = try? Data(contentsOf: application.appendingPathComponent("Contents/Info.plist")),
                          let info = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                          info["CFBundleIdentifier"] as? String == UpdateRecoveryStore.bundleIdentifier,
                          info["SUPublicEDKey"] as? String == record.publicUpdateKey,
                          info["CFBundlePackageType"] as? String == "APPL" else { return false }
                    let signature = try await UpdateCommand.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures",
                        "-R=identifier \"\(UpdateRecoveryStore.bundleIdentifier)\"", application.path])
                    return signature.status == 0
                },
                applicationIsRunning: {
                    NSRunningApplication.runningApplications(withBundleIdentifier: UpdateRecoveryStore.bundleIdentifier)
                        .contains { $0.bundleURL?.standardizedFileURL == application }
                },
                launchApplication: {
                    let configuration = NSWorkspace.OpenConfiguration()
                    configuration.activates = false
                    configuration.hides = true
                    configuration.addsToRecentItems = false
                    configuration.arguments = ["--update-recovery"]
                    _ = try await NSWorkspace.shared.openApplication(at: application, configuration: configuration)
                },
                wait: { try await Task.sleep(for: .seconds(1)) },
                note: { reason in
                    let now = ProcessInfo.processInfo.systemUptime
                    if previousNote != reason || now - previousNoteTime >= 30 {
                        store.note(reason)
                        previousNote = reason
                        previousNoteTime = now
                    }
                },
                clock: { ProcessInfo.processInfo.systemUptime }
            ))
            let outcome = await supervisor.run()
            exit(outcome == .completed ? 0 : 75)
        } catch {
            store.note("unsafe-or-incomplete-recovery-record")
            exit(78)
        }
    }
}
