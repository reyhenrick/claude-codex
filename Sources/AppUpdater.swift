import AppKit
import Combine
import Sparkle

private struct UpdateFailure: LocalizedError {
    let key: String
    var errorDescription: String? { L10n.text(key) }
}

@MainActor
private final class UpdateRecoverySupport {
    let store = UpdateRecoveryStore()
    private let application: URL
    private let resources: URL

    init(application: URL, resources: URL) {
        self.application = application
        self.resources = resources
    }

    func arm() async throws {
        try store.prepareDirectory()
        let record: UpdateRecoveryRecord
        if let existing = try store.load() {
            guard existing.owner == UpdateProcessIdentity.capture(getpid()), existing.applicationPath == application.path else {
                throw UpdateRecoveryFailure.unsafeRecord
            }
            record = existing
        } else {
            var existingJob = stat()
            guard lstat(store.jobURL.path, &existingJob) != 0, errno == ENOENT else { throw UpdateRecoveryFailure.unexpectedJob }
            let installers = try await UpdateInstallerActivity.capture(application: application, userID: getuid())
            guard let owner = UpdateProcessIdentity.capture(getpid()),
                  let publicKey = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String else {
                throw UpdateRecoveryFailure.unsafeRecord
            }
            record = UpdateRecoveryRecord(version: 1, id: UUID(), userID: getuid(), applicationPath: application.path,
                                          publicUpdateKey: publicKey, owner: owner, installers: installers)
            try store.validate(record)
            let temporary = store.directory.appendingPathComponent(".UpdateRecovery.\(UUID().uuidString).tmp")
            defer { try? FileManager.default.removeItem(at: temporary) }
            try FileManager.default.copyItem(at: resources.appendingPathComponent("bin/UpdateRecovery"), to: temporary)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: temporary.path)
            let signature = try await UpdateCommand.run("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", temporary.path])
            guard signature.status == 0 else { throw UpdateRecoveryFailure.unsafeRecord }
            var previous = stat()
            if lstat(store.helperURL.path, &previous) == 0 {
                guard previous.st_uid == getuid(), previous.st_mode & S_IFMT == S_IFREG else { throw UpdateRecoveryFailure.unsafeRecord }
            } else if errno != ENOENT { throw UpdateRecoveryFailure.unsafeRecord }
            guard rename(temporary.path, store.helperURL.path) == 0 else { throw UpdateRecoveryFailure.unsafeRecord }
            try store.save(record)
        }
        var jobFile = stat()
        if lstat(store.jobURL.path, &jobFile) == 0 {
            try store.validateJobFile(record: record)
        } else {
            guard errno == ENOENT else { throw UpdateRecoveryFailure.unsafeRecord }
            try FileManager.default.createDirectory(at: store.jobURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let plist: [String: Any] = ["Label": UpdateRecoveryStore.jobLabel, "ProgramArguments": store.jobArguments(record: record),
                                        "RunAtLoad": true, "KeepAlive": ["SuccessfulExit": false], "ThrottleInterval": 30,
                                        "ProcessType": "Background", "AssociatedBundleIdentifiers": [UpdateRecoveryStore.bundleIdentifier],
                                        "StandardOutPath": "/dev/null", "StandardErrorPath": "/dev/null"]
            try store.writePrivate(PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0), to: store.jobURL)
        }
        try Task.checkCancellation()
        let current = try await UpdateCommand.run("/bin/launchctl", ["print", store.jobTarget])
        if current.status == 113 {
            let result = try await UpdateCommand.run("/bin/launchctl", ["bootstrap", "gui/\(getuid())", store.jobURL.path])
            if result.status != 0 {
                let raced = try await UpdateCommand.run("/bin/launchctl", ["print", store.jobTarget])
                guard raced.status == 0 else { throw UpdateRecoveryFailure.commandFailed }
                try validate(job: raced.output, record: record)
            }
        } else {
            guard current.status == 0 else { throw UpdateRecoveryFailure.commandFailed }
            try validate(job: current.output, record: record)
        }
        let kicked = try await UpdateCommand.run("/bin/launchctl", ["kickstart", store.jobTarget])
        guard kicked.status == 0 else { throw UpdateRecoveryFailure.commandFailed }
        for _ in 0..<20 {
            let running = try await UpdateCommand.run("/bin/launchctl", ["print", store.jobTarget])
            guard running.status == 0 else { throw UpdateRecoveryFailure.commandFailed }
            try validate(job: running.output, record: record)
            if let pid = try UpdateLaunchJob(output: running.output).pid, UpdateProcessIdentity.capture(pid) != nil { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw UpdateRecoveryFailure.commandFailed
    }

    func disarm() async throws {
        guard let record = try store.load() else { return }
        var file = stat()
        if lstat(store.jobURL.path, &file) == 0 { try store.validateJobFile(record: record) }
        else if errno != ENOENT { throw UpdateRecoveryFailure.unsafeRecord }
        let current = try await UpdateCommand.run("/bin/launchctl", ["print", store.jobTarget])
        if current.status == 0 {
            try validate(job: current.output, record: record)
            let result = try await UpdateCommand.run("/bin/launchctl", ["bootout", store.jobTarget])
            if result.status != 0 {
                let remaining = try await UpdateCommand.run("/bin/launchctl", ["print", store.jobTarget])
                guard remaining.status == 113 else { throw UpdateRecoveryFailure.commandFailed }
            }
        } else if current.status != 113 { throw UpdateRecoveryFailure.commandFailed }
        guard try store.load()?.id == record.id else { throw UpdateRecoveryFailure.unsafeRecord }
        for path in [store.jobURL, store.statusURL, store.helperURL, store.recordURL] {
            var information = stat()
            if lstat(path.path, &information) != 0 {
                if errno == ENOENT { continue }
                throw UpdateRecoveryFailure.unsafeRecord
            }
            guard information.st_uid == getuid(), information.st_mode & S_IFMT == S_IFREG else { throw UpdateRecoveryFailure.unsafeRecord }
            try FileManager.default.removeItem(at: path)
        }
        rmdir(store.directory.path)
    }

    private func validate(job output: String, record: UpdateRecoveryRecord) throws {
        let job = try UpdateLaunchJob(output: output)
        guard job.program == store.helperURL.path, job.arguments == store.jobArguments(record: record) else {
            throw UpdateRecoveryFailure.unexpectedJob
        }
    }
}

@MainActor
private final class UpdateBridge {
    private let label = "com.henrick.claude-codex-bridge"
    private let resources: URL
    private let session: URLSession
    let recoverySupport: UpdateRecoverySupport
    private var target: String { "gui/\(getuid())/\(label)" }

    init(resources: URL) {
        self.resources = resources
        recoverySupport = UpdateRecoverySupport(application: Bundle.main.bundleURL, resources: resources)
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
        try BridgeAuthorization.apply(to: &request)
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
        if let record = try recoverySupport.store.load(), record.owner != UpdateProcessIdentity.capture(getpid()) {
            while !UpdateInstallerActivity.mayRecover(current: UpdateProcessIdentity.capture(getpid()), owner: record.owner,
                                                     ownerIsRunning: record.owner.isRunning,
                                                     installersAreRunning: try await UpdateInstallerActivity.isRunning(record: record)) {
                try Task.checkCancellation()
                try await Task.sleep(for: .seconds(1))
                guard try recoverySupport.store.load()?.id == record.id else { throw UpdateRecoveryFailure.unsafeRecord }
            }
        }
        try await validateOwnership()
        let result = try await runSetup(["action": "service"])
        guard result.ok else { throw UpdateFailure(key: "updater.recoveryError") }
        var failure: Error = UpdateFailure(key: "updater.recoveryError")
        for _ in 0..<15 {
            do {
                let state = try await readiness(action: "resume")
                guard !state.draining else { throw UpdateFailure(key: "updater.recoveryError") }
                try await recoverySupport.disarm()
                return
            } catch { failure = error }
            try await Task.sleep(for: .seconds(1))
        }
        throw failure
    }

    private func launchctl(_ arguments: [String]) async throws -> (status: Int32, output: String) {
        try await UpdateCommand.run("/bin/launchctl", arguments)
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
    @Published private var stagedUpdateMayInstall = false
    private var installationRequested = false
    private var terminationPending = false
    private var automaticGate = false
    private var preparationTask: Task<Void, Never>?
    private let recovery = UpdateRecoveryCoordinator()
    private let startup = UpdateStartupCoordinator()
    private lazy var bridge = UpdateBridge(resources: Bundle.main.resourceURL!)
    private lazy var preparation = UpdateServicePreparation(operations: .init(
        localReady: { [weak self] in self?.canPrepare?() ?? true },
        validateOwnership: { [unowned self] in try await bridge.validateOwnership() },
        markRecovery: { value in
            UserDefaults.standard.set(value, forKey: AppUpdater.recoveryKey)
            UserDefaults.standard.synchronize()
        },
        armRecovery: { [unowned self] in try await bridge.recoverySupport.arm() },
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

    var pendingUpdateInstallsOnQuit: Bool { stagedUpdateMayInstall && !automaticallyInstalls }

    func start() async -> Bool {
        guard installed else { return true }
        let ready = await startup.start(recover: { [weak self] in
            guard let self else { return }
            let record = try bridge.recoverySupport.store.load()
            if UserDefaults.standard.bool(forKey: Self.recoveryKey) || record != nil {
                try await preparation.recover(force: true)
            }
        }, onReady: { [weak self] in
            guard let self, !started else { return }
            lastError = nil
            started = true
            let updater = controller.updater
            updater.publisher(for: \.canCheckForUpdates).receive(on: RunLoop.main).assign(to: &$canCheckForUpdates)
            updater.publisher(for: \.automaticallyDownloadsUpdates).receive(on: RunLoop.main).assign(to: &$automaticallyInstalls)
            do { try updater.start() }
            catch { lastError = L10n.text("updater.startError", error.localizedDescription) }
        }, onFailure: { [weak self] _ in
            self?.lastError = L10n.text("updater.recoveryError")
        })
        if ready && preparation.recoveryRequired && preparationTask == nil && !preparation.prepared && !installationRequested && !recovery.isRunning {
            recoverService(force: true)
        }
        await recovery.waitUntilFinished()
        return ready && !preparation.recoveryRequired && !preparation.prepared && preparationTask == nil
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
        if recovery.isRunning || startup.isRunning { return .terminateCancel }
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
