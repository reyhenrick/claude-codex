import AppKit
import Foundation
struct Profile: Decodable { let applicationPath: String; let userDataDirectory: String }
@MainActor final class Launcher: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            guard let file = Bundle.main.url(forResource: "Profile", withExtension: "json") else { throw CocoaError(.fileNoSuchFile) }
            let profile = try JSONDecoder().decode(Profile.self, from: Data(contentsOf: file))
            let app = URL(fileURLWithPath: profile.applicationPath)
            guard FileManager.default.fileExists(atPath: app.path) else { throw CocoaError(.fileNoSuchFile) }
            if let existing = NSWorkspace.shared.runningApplications.first(where: { $0.bundleURL?.standardizedFileURL == app.standardizedFileURL }) {
                existing.activate(); NSApp.terminate(nil); return
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
    private func failure() {
        let alert = NSAlert(); alert.messageText = "Não foi possível abrir o Claude separado."
        alert.informativeText = "Confira se a instalação ainda está disponível na pasta de aplicativos gerenciados do Contas Codex."
        alert.runModal()
    }
}
MainActor.assumeIsolated {
    let app = NSApplication.shared, delegate = Launcher()
    app.setActivationPolicy(.accessory); app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
