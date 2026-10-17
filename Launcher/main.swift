import AppKit
import Foundation
struct Profile: Decodable { let applicationPath: String; let userDataDirectory: String; let profileId: String? }
@MainActor final class Launcher: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { await launch() }
    }
    private func launch() async {
        do {
            guard let file = Bundle.main.url(forResource: "Profile", withExtension: "json") else { throw CocoaError(.fileNoSuchFile) }
            let profile = try JSONDecoder().decode(Profile.self, from: Data(contentsOf: file))
            let app = URL(fileURLWithPath: profile.applicationPath)
            guard FileManager.default.fileExists(atPath: app.path) else { throw CocoaError(.fileNoSuchFile) }
            if let existing = NSWorkspace.shared.runningApplications.first(where: { $0.bundleURL?.standardizedFileURL == app.standardizedFileURL }) {
                existing.activate(); NSApp.terminate(nil); return
            }
            if let profileId = profile.profileId {
                do { try await refreshProfileCatalog(dataDirectory: profile.userDataDirectory, profileId: profileId) }
                catch { connectionFailure(); NSApp.terminate(nil); return }
            }
            let config = NSWorkspace.OpenConfiguration()
            config.createsNewApplicationInstance = true
            config.arguments = ["--user-data-dir=\(profile.userDataDirectory)"]
            config.environment = ["CLAUDE_CONFIG_DIR": profile.userDataDirectory + "/claude-code"]
            NSWorkspace.shared.openApplication(at: app, configuration: config) { _, error in
                Task { @MainActor in
                    if error != nil { self.failure() }
                    NSApp.terminate(nil)
                }
            }
        } catch { failure(); NSApp.terminate(nil) }
    }
    private func connectionFailure() {
        let alert = NSAlert(); alert.messageText = L10n.text("launcher.connectionRequired")
        alert.informativeText = L10n.text("launcher.connectAccounts")
        alert.runModal()
    }
    private func failure() {
        let alert = NSAlert(); alert.messageText = L10n.text("launcher.openFailed")
        alert.informativeText = L10n.text("launcher.checkInstallation")
        alert.runModal()
    }
}
MainActor.assumeIsolated {
    let app = NSApplication.shared, delegate = Launcher()
    app.setActivationPolicy(.accessory); app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
