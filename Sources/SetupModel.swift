import AppKit
import Combine
import Foundation

struct SetupResult: Decodable { let ok: Bool; let message: String; let path: String? }

func runSetup(_ options: [String: Any]) async throws -> SetupResult {
    guard let resources = Bundle.main.resourceURL else { throw BridgeFailure(message: "Os arquivos do aplicativo não foram encontrados.") }
    let data = try JSONSerialization.data(withJSONObject: options)
    return try await withCheckedThrowingContinuation { continuation in
        let process = Process(), input = Pipe(), output = Pipe()
        process.executableURL = resources.appendingPathComponent("bin/node")
        process.arguments = [resources.appendingPathComponent("Bridge/setup.mjs").path]
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        process.terminationHandler = { _ in
            let result = output.fileHandleForReading.readDataToEndOfFile()
            do { continuation.resume(returning: try JSONDecoder().decode(SetupResult.self, from: result)) }
            catch { continuation.resume(throwing: BridgeFailure(message: "A preparação não foi concluída. Confira se o app está instalado corretamente.")) }
        }
        do { try process.run(); input.fileHandleForWriting.write(data); try? input.fileHandleForWriting.close() }
        catch { process.terminationHandler = nil; continuation.resume(throwing: error) }
    }
}

@MainActor final class SetupModel: ObservableObject {
    @Published var kind = "profile"
    @Published var name = "Codex"
    @Published var source = "/Applications/Claude.app"
    @Published var root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Claude-3p").path
    @Published var activate = true
    @Published var busy = false
    @Published var result: SetupResult?
    @Published var error: String?
    func chooseSource() {
        let panel = NSOpenPanel(); panel.title = "Selecione o aplicativo oficial Claude.app"
        panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.treatsFilePackagesAsDirectories = false; panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        if panel.runModal() == .OK, let url = panel.url { source = url.path }
    }
    func chooseRoot() {
        let panel = NSOpenPanel(); panel.title = "Selecione a pasta de dados do Claude em modo 3P"
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.canCreateDirectories = true; panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        if panel.runModal() == .OK, let url = panel.url { root = url.path }
    }
    func create() {
        guard !busy else { return }; busy = true; error = nil; result = nil
        let options: [String: Any] = kind == "profile" ? ["action": "profile", "root": root, "name": name, "activate": activate] : ["action": "isolated", "source": source, "name": name]
        Task {
            defer { busy = false }
            do { let answer = try await runSetup(options); if answer.ok { result = answer } else { error = answer.message } }
            catch { self.error = error.localizedDescription }
        }
    }
    func reveal() { if let path = result?.path { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) } }
}
