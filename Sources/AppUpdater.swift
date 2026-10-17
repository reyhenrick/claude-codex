import AppKit
import Combine
import Sparkle

private struct UpdateFailure: LocalizedError {
    let key: String
    var errorDescription: String? { L10n.text(key) }
}

@MainActor
private final class UpdateBridge {
    private let label = "com.henrick.claude-codex-bridge"
    private let resources: URL
    private let session: URLSession
    private var target: String { "gui/\(getuid())/\(label)" }

    init(resources: URL) {
        self.resources = resources
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 10
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        session = URLSession(configuration: configuration)
    }

    func readiness(action: String? = nil) async throws -> UpdateReadiness {
        let path = action.map { "/_bridge/update/\($0)" } ?? "/healthz"
        var request = URLRequest(url: URL(string: "http://127.0.0.1:18765\(path)")!)
        if action != nil {
            request.httpMethod = "POST"
            request.httpBody = Data("{}".utf8)
            request.setValue("http://127.0.0.1:18765", forHTTPHeaderField: "Origin")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("accounts", forHTTPHeaderField: "X-Bridge-Action")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              data.count <= 32768 else { throw UpdateFailure(key: "updater.preparationError") }
        let value = try JSONDecoder().decode(UpdateReadiness.self, from: data)
        guard value.activeRequests >= 0, value.resetRequests >= 0, value.pendingOAuth >= 0, value.pendingActions >= 0 else {
            throw UpdateFailure(key: "updater.preparationError")
        }
        return value
    }

    func validateOwnership() async throws {
        let plist = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
        let data = try Data(contentsOf: plist)
        guard let value = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              value["Label"] as? String == label,
              let arguments = value["ProgramArguments"] as? [String],
              arguments == [resources.appendingPathComponent("bin/BridgeService").path,
                            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Claude Codex Bridge/pool").path,
                            resources.appendingPathComponent("bin/node").path,
                            resources.appendingPathComponent("Bridge/pool-service.mjs").path] else {
            throw UpdateFailure(key: "updater.serviceOwnership")
        }
        let job = try await launchctl(["print", target])
        if job.status == 0 {
            guard job.output.split(separator: "\n").contains(where: {
                $0.trimmingCharacters(in: .whitespaces) == "program = \(arguments[0])"
            }) else { throw UpdateFailure(key: "updater.serviceOwnership") }
        }
    }

    func stop(localReady: () -> Bool) async throws {
        try await validateOwnership()
        let job = try await launchctl(["print", target])
        let pid = job.output.split(separator: "\n").compactMap { line -> Int32? in
            let text = line.trimmingCharacters(in: .whitespaces)
            guard text.hasPrefix("pid = ") else { return nil }
            return Int32(text.dropFirst(6))
        }.first
        try Task.checkCancellation()
        guard job.status == 0, let pid, pid > 1 else { throw UpdateFailure(key: "updater.preparationError") }
        let finalReadiness = try await readiness()
        try Task.checkCancellation()
        guard finalReadiness.canInstall else { throw UpdateFailure(key: "updater.busy") }
        guard localReady() else { throw UpdateFailure(key: "updater.busy") }
        let result = try await launchctl(["bootout", target])
        if result.status != 0 {
            let remaining = try await launchctl(["print", target])
            guard remaining.status != 0 else { throw UpdateFailure(key: "updater.preparationError") }
        }
        while true {
            try Task.checkCancellation()
            let registered = try await launchctl(["print", target]).status == 0
            let running = kill(pid, 0) == 0 || errno != ESRCH
            let responding = (try? await readiness()) != nil
            if !registered && !running && !responding { return }
            try await Task.sleep(for: .seconds(1))
        }
    }

    func recover() async throws {
        try await validateOwnership()
        let result = try await runSetup(["action": "service"])
        guard result.ok else { throw UpdateFailure(key: "updater.recoveryError") }
        var failure: Error = UpdateFailure(key: "updater.recoveryError")
        for _ in 0..<15 {
            do {
                let state = try await readiness(action: "resume")
                guard !state.draining else { throw UpdateFailure(key: "updater.recoveryError") }
                return
            } catch { failure = error }
            try await Task.sleep(for: .seconds(1))
        }
        throw failure
    }

    private func launchctl(_ arguments: [String]) async throws -> (status: Int32, output: String) {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process(), output = Pipe()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = arguments
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { process in
                let data = output.fileHandleForReading.readDataToEndOfFile()
                continuation.resume(returning: (process.terminationStatus, String(decoding: data, as: UTF8.self)))
            }
            do { try process.run() }
            catch { process.terminationHandler = nil; continuation.resume(throwing: error) }
        }
    }
}

@MainActor
final class AppUpdater: NSObject, ObservableObject, SPUUpdaterDelegate, @preconcurrency SPUStandardUserDriverDelegate {
    @Published private(set) var canCheckForUpdates = false
    @Published private(set) var updateAvailable = false
    @Published private(set) var automaticallyInstalls = false
    @Published private(set) var waitingForIdle = false
    @Published private(set) var lastError: String?

    var hidePanel: (() -> Void)?
    var showPanel: (() -> Void)?
    var canPrepare: (() -> Bool)?
    private static let recoveryKey = "CodexAccountsUpdateServiceRecovery"
    private let gate = UpdateInstallGate()
    private var started = false
    private var automaticUpdateQueued = false
    private var stagedUpdateMayInstall = false
    private var installationRequested = false
    private var terminationPending = false
    private var automaticGate = false
    private var preparationTask: Task<Void, Never>?
    private let recovery = UpdateRecoveryCoordinator()
    private lazy var bridge = UpdateBridge(resources: Bundle.main.resourceURL!)
    private lazy var preparation = UpdateServicePreparation(operations: .init(
        localReady: { [weak self] in self?.canPrepare?() ?? true },
        validateOwnership: { [unowned self] in try await bridge.validateOwnership() },
        markRecovery: { value in
            UserDefaults.standard.set(value, forKey: AppUpdater.recoveryKey)
            UserDefaults.standard.synchronize()
        },
        drain: { [unowned self] in try await bridge.readiness(action: "drain") },
        poll: { [unowned self] in try await bridge.readiness() },
        stop: { [unowned self] in try await bridge.stop(localReady: { self.canPrepare?() ?? true }) },
        recover: { [unowned self] in try await bridge.recover() },
        wait: { try await Task.sleep(for: .seconds(1)) }
    ))
    private lazy var controller = SPUStandardUpdaterController(startingUpdater: false,
        updaterDelegate: self, userDriverDelegate: self)

    private var installed: Bool {
        let location = Bundle.main.bundleURL.resolvingSymlinksInPath().deletingLastPathComponent().path
        return ["/Applications", FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path].contains(location)
    }

    var canPerformUpdateAction: Bool {
        !recovery.isRunning && (canCheckForUpdates || (automaticUpdateQueued && gate.isWaiting && automaticGate))
    }

    func start() {
        guard !started, installed else { return }
        started = true
        let updater = controller.updater
        updater.publisher(for: \.canCheckForUpdates).receive(on: RunLoop.main).assign(to: &$canCheckForUpdates)
        updater.publisher(for: \.automaticallyDownloadsUpdates).receive(on: RunLoop.main).assign(to: &$automaticallyInstalls)
        do { try updater.start() }
        catch { lastError = L10n.text("updater.startError", error.localizedDescription) }
        if UserDefaults.standard.bool(forKey: Self.recoveryKey) { recoverService(force: true) }
    }

    func checkForUpdates() {
        guard started else { lastError = L10n.text("updater.unavailable"); return }
        guard !recovery.isRunning else { lastError = L10n.text("updater.recoveryError"); return }
        if automaticUpdateQueued && gate.isWaiting && automaticGate {
            automaticGate = false
            attemptInstallation()
            return
        }
        guard canCheckForUpdates else { return }
        lastError = nil
        hidePanel?()
        controller.checkForUpdates(nil)
    }

    func setAutomaticallyInstalls(_ enabled: Bool) {
        guard started else { return }
        controller.updater.automaticallyDownloadsUpdates = enabled
        if enabled { attemptInstallation() }
        else if automaticGate && !terminationPending && !installationRequested { recoverService() }
    }

    func terminationReply() -> NSApplication.TerminateReply {
        if recovery.isRunning { return .terminateCancel }
        guard installationRequested || automaticUpdateQueued || stagedUpdateMayInstall || gate.isWaiting else { return .terminateNow }
        if preparation.prepared { return .terminateNow }
        guard !terminationPending else { return .terminateLater }
        terminationPending = true
        waitingForIdle = true
        attemptInstallation()
        return .terminateLater
    }

    private func enqueue(_ continuation: @escaping () -> Void, automatic: Bool = false) {
        automaticGate = automatic
        gate.enqueue(continuation)
        waitingForIdle = true
        attemptInstallation()
    }

    private func attemptInstallation() {
        guard (gate.isWaiting || terminationPending), preparationTask == nil, !recovery.isRunning else { return }
        guard terminationPending || !automaticGate || controller.updater.automaticallyDownloadsUpdates else { return }
        waitingForIdle = true
        preparationTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    try await preparation.prepare()
                    try Task.checkCancellation()
                    preparationTask = nil
                    waitingForIdle = false
                    lastError = nil
                    if terminationPending {
                        terminationPending = false
                        gate.cancel()
                        NSApp.reply(toApplicationShouldTerminate: true)
                    } else { gate.advance(prepared: preparation.prepared) }
                    return
                } catch is CancellationError { return }
                catch {
                    lastError = error is UpdateFailure ? error.localizedDescription : L10n.text("updater.preparationError")
                    if terminationPending {
                        terminationPending = false
                        NSApp.reply(toApplicationShouldTerminate: false)
                        if !gate.isWaiting {
                            preparationTask = nil
                            recoverService()
                            return
                        }
                    }
                    do { try await Task.sleep(for: .seconds(5)) }
                    catch { return }
                }
            }
        }
    }

    private func recoverService(force: Bool = false) {
        let pending = preparationTask
        pending?.cancel()
        preparationTask = nil
        recovery.start(after: pending, operation: { [weak self] in
            guard let self else { return }
            try await preparation.recover(force: force)
            waitingForIdle = gate.isWaiting
            lastError = nil
        }, onFailure: { [weak self] _ in
            self?.lastError = L10n.text("updater.recoveryError")
        }, reconcile: { [weak self] in
            self?.attemptInstallation()
        })
    }

    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        guard installed else { throw UpdateFailure(key: "updater.unavailable") }
        guard !recovery.isRunning else { throw UpdateFailure(key: "updater.recoveryError") }
    }

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) { updateAvailable = true }
    func updater(_ updater: SPUUpdater, didExtractUpdate item: SUAppcastItem) { stagedUpdateMayInstall = true }

    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock handler: @escaping () -> Void) -> Bool {
        automaticUpdateQueued = true
        updateAvailable = true
        enqueue(handler, automatic: true)
        return true
    }

    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
                 untilInvokingBlock handler: @escaping () -> Void) -> Bool {
        if preparation.prepared { return false }
        enqueue(handler)
        showPanel?()
        return true
    }

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) { installationRequested = true }

    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        gate.cancel()
        waitingForIdle = false
        installationRequested = false
        automaticUpdateQueued = false
        stagedUpdateMayInstall = false
        if terminationPending {
            terminationPending = false
            NSApp.reply(toApplicationShouldTerminate: false)
        }
        recoverService()
        let failure = error as NSError
        if failure.domain == SUSparkleErrorDomain && failure.code == 1001 { updateAvailable = false }
    }

    var supportsGentleScheduledUpdateReminders: Bool { true }

    func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool,
                                                   forUpdate update: SUAppcastItem,
                                                   state: SPUUserUpdateState) {
        updateAvailable = true
        if state.userInitiated { hidePanel?() }
    }

    func standardUserDriverWillFinishUpdateSession() {
        if !automaticUpdateQueued && !installationRequested && !gate.isWaiting { updateAvailable = false }
    }

    func standardUserDriverWillShowModalAlert() { hidePanel?() }
}
