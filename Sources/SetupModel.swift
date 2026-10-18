import AppKit
import Combine
import Foundation

struct MigrationSummary: Decodable {
    let copiedFiles: Int
    let skippedFiles: Int
    let warnings: [String]
    let reportPath: String?
}

struct SetupResult: Decodable {
    let ok: Bool
    let code: String?
    let message: String
    let path: String?
    let migration: MigrationSummary?
    let service: ServiceReadiness?
    func localizedMessage(fallback: String) -> String { L10n.serviceMessage(code: code, fallback: fallback) }
}

func runSetup(_ options: [String: Any]) async throws -> SetupResult {
    guard let resources = Bundle.main.resourceURL else { throw BridgeFailure(message: L10n.text("error.appFiles")) }
    let data = try JSONSerialization.data(withJSONObject: options)
    return try await withCheckedThrowingContinuation { continuation in
        let process = Process(), input = Pipe(), output = Pipe()
        process.executableURL = resources.appendingPathComponent("bin/node")
        process.arguments = [resources.appendingPathComponent("Bridge/setup.mjs").path]
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        process.terminationHandler = { _ in
            let result = output.fileHandleForReading.readDataToEndOfFile()
            do {
                let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
                continuation.resume(returning: try decoder.decode(SetupResult.self, from: result))
            }
            catch { continuation.resume(throwing: BridgeFailure(message: L10n.text("error.setupInstallation"))) }
        }
        do { try process.run(); input.fileHandleForWriting.write(data); try? input.fileHandleForWriting.close() }
        catch { process.terminationHandler = nil; continuation.resume(throwing: error) }
    }
}

@MainActor final class SetupModel: ObservableObject {
    @Published var name = "Claude Codex Workspace"
    @Published var source = "/Applications/Claude.app"
    @Published var migrateData = true
    @Published var sourceDataRoot = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Claude").path
    @Published var sourceCodeRoot = ""
    @Published var busy = false
    @Published var result: SetupResult?
    @Published var error: String?
    private let setupExecutor: ([String: Any]) async throws -> SetupResult
    init(staging: Bool = false, setupExecutor suppliedSetup: (([String: Any]) async throws -> SetupResult)? = nil) {
        if let suppliedSetup { setupExecutor = suppliedSetup }
        else if staging { setupExecutor = { _ in throw BridgeFailure(message: L10n.text("setup.previewUnavailable")) } }
        else { setupExecutor = runSetup }
    }
    var resultMessage: String? {
        guard let result, result.ok else { return nil }
        return result.localizedMessage(fallback: "setup.isolatedCreated")
    }
    func chooseSource() {
        let panel = NSOpenPanel(); panel.title = L10n.text("setup.chooseClaude")
        panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.treatsFilePackagesAsDirectories = false; panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        if panel.runModal() == .OK, let url = panel.url { source = url.path }
    }
    func chooseSourceDataRoot() {
        let panel = NSOpenPanel(); panel.title = L10n.text("setup.chooseSourceData")
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.canCreateDirectories = false; panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        if panel.runModal() == .OK, let url = panel.url { sourceDataRoot = url.path }
    }
    func chooseSourceCodeRoot() {
        let panel = NSOpenPanel(); panel.title = L10n.text("setup.chooseCodeData")
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.canCreateDirectories = false; panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
        if panel.runModal() == .OK, let url = panel.url { sourceCodeRoot = url.path }
    }
    func create() {
        guard !busy else { return }; busy = true; error = nil; result = nil
        var options: [String: Any] = ["action": "isolated", "source": source, "name": name, "migrate_data": migrateData, "source_data_root": sourceDataRoot]
        if !sourceCodeRoot.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { options["source_code_root"] = sourceCodeRoot }
        Task {
            defer { busy = false }
            do { accept(try await setupExecutor(options)) }
            catch { self.error = error.localizedDescription }
        }
    }
    func accept(_ answer: SetupResult) {
        result = answer
        error = answer.ok ? nil : answer.localizedMessage(fallback: "error.setup")
    }
    func revealMigrationReport() {
        if let path = result?.migration?.reportPath { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
    }
    func reveal() { if let path = result?.path { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) } }
}
