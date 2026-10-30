import AppKit
import Combine
import Foundation
import ServiceManagement

enum AccountConfirmation {
    case disconnect(Account)
    case extraCredits
    case autoReset(Account, revision: Int)
    case reset(Account, revision: Int)

    var title: String {
        switch self {
        case .disconnect: return L10n.text("confirm.disconnectTitle")
        case .extraCredits: return L10n.text("confirm.creditsTitle")
        case .autoReset: return L10n.text("confirm.autoResetTitle")
        case .reset(let account, _): return L10n.text(account.resets.reason == "retry" ? "confirm.retryTitle" : "confirm.resetTitle")
        }
    }
    var message: String {
        switch self {
        case .disconnect(let account): return L10n.text("confirm.disconnectMessage", account.email)
        case .extraCredits: return L10n.text("confirm.creditsMessage")
        case .autoReset(let account, _): return L10n.text("confirm.autoResetMessage", account.email, String(account.resets.thresholdPercent))
        case .reset(let account, _): return L10n.text(account.resets.reason == "retry" ? "confirm.retryMessage" : "confirm.resetMessage", account.email)
        }
    }
    var actionTitle: String {
        switch self {
        case .disconnect: return L10n.text("action.disconnect")
        case .extraCredits: return L10n.text("action.allowCredits")
        case .autoReset: return L10n.text("action.enableAutoReset")
        case .reset(let account, _): return L10n.text(account.resets.reason == "retry" ? "action.checkAttempt" : "action.applyReset")
        }
    }
    var isDestructive: Bool {
        if case .disconnect = self { return true }
        return false
    }
}

@MainActor
final class AccountsModel: ObservableObject {
    @Published var snapshot: PoolSnapshot?
    @Published var queryError: String?
    @Published var actionError: String?
    @Published var refreshing = false { didSet { if !refreshing { refreshInvalidatedSnapshot() } } }
    @Published var applying = false { didSet { if !applying { refreshInvalidatedSnapshot() } } }
    @Published var showingConnectionForm = false
    @Published var connectionEmail = ""
    @Published var confirmation: AccountConfirmation?
    @Published var openAtLogin = SMAppService.mainApp.status == .enabled
    @Published var lastRefresh: Date?
    @Published private(set) var maintenancePending: Bool
    @Published private(set) var maintenanceMessage: String?
    @Published private(set) var maintenanceNeedsAttention = false
    @Published private(set) var preparingService = false
    var beforeServicePreparation: (() async -> Bool)?
    private var loginURL: URL?
    private var loginEmail: String?
    private var polling: Task<Void, Never>?
    private var updates: Task<Void, Never>?
    private var updateLoad: Task<Void, Never>?
    private var snapshotInvalidated = false
    private var stopped = false
    private let isStaging: Bool
    private let session: URLSession
    private let eventSession: URLSession
    private let openURL: (URL) -> Bool
    private let setupExecutor: ([String: Any]) async throws -> SetupResult
    private let expectedServiceBuild: String?
    private var awaitingServiceTransition = false
    let baseURL: URL

    init(staging: Bool = false, session suppliedSession: URLSession? = nil,
         eventSession suppliedEventSession: URLSession? = nil,
         expectedServiceBuild: String? = ServiceReadiness.expectedBuild,
         setupExecutor suppliedSetup: (([String: Any]) async throws -> SetupResult)? = nil,
         openURL: @escaping (URL) -> Bool = { NSWorkspace.shared.open($0) }) {
        isStaging = staging; self.openURL = openURL
        self.expectedServiceBuild = expectedServiceBuild
        maintenancePending = !staging
        if let suppliedSetup { setupExecutor = suppliedSetup }
        else if staging { setupExecutor = { _ in throw BridgeFailure(message: L10n.text("error.localService")) } }
        else { setupExecutor = runSetup }
        baseURL = URL(string: staging ? "http://127.0.0.1:18769" : "http://127.0.0.1:18765")!
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 45
        config.timeoutIntervalForResource = 60
        session = suppliedSession ?? URLSession(configuration: config)
        let eventsConfig = suppliedSession?.configuration ?? URLSessionConfiguration.ephemeral
        eventsConfig.timeoutIntervalForRequest = 45
        eventsConfig.timeoutIntervalForResource = 24 * 60 * 60
        eventSession = suppliedEventSession ?? URLSession(configuration: eventsConfig)
    }
    func start() {
        guard polling == nil, !stopped else { return }
        updates = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, !self.stopped else { return }
                do { try await self.consumeUpdates() } catch {}
                guard !Task.isCancelled, !self.stopped else { return }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if !self.isStaging, self.snapshot == nil { await self.load(refreshNewAccounts: false) }
                if !self.isStaging { await self.checkServiceReadiness() }
                guard !Task.isCancelled else { return }
                await self.load(refresh: self.snapshot == nil && !self.maintenancePending)
                let interval = self.snapshot?.connection == nil && !self.maintenancePending ? 15 : 2
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }
    func stop() {
        stopped = true; snapshotInvalidated = false
        polling?.cancel(); polling = nil
        updates?.cancel(); updates = nil
        updateLoad?.cancel(); updateLoad = nil
        session.invalidateAndCancel(); eventSession.invalidateAndCancel()
    }

    private func consumeUpdates() async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("_bridge/events"))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if !isStaging { try BridgeAuthorization.apply(to: &request) }
        let (bytes, response) = try await eventSession.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() == "text/event-stream" else {
            throw URLError(.badServerResponse)
        }
        var event = ""
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard line.utf8.count <= 4096 else { throw URLError(.cannotDecodeRawData) }
            if line.isEmpty { event = ""; continue }
            if line.hasPrefix(":") { continue }
            let fields = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            guard fields.count == 2 else { continue }
            let value = fields[1].trimmingCharacters(in: .whitespaces)
            if fields[0] == "event" { event = value }
            else if fields[0] == "data" {
                if event == "changed", let data = value.data(using: .utf8),
                   let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any], payload.isEmpty {
                    serviceDidChange()
                }
                event = ""
            }
        }
    }

    func serviceDidChange() {
        guard !stopped else { return }
        snapshotInvalidated = true
        refreshInvalidatedSnapshot()
    }

    private func refreshInvalidatedSnapshot() {
        guard snapshotInvalidated, !refreshing, !applying, updateLoad == nil, !stopped else { return }
        updateLoad = Task { [weak self] in
            await Task.yield()
            guard let self else { return }
            defer { self.updateLoad = nil; self.refreshInvalidatedSnapshot() }
            guard !Task.isCancelled, !self.stopped, !self.refreshing, !self.applying else { return }
            self.snapshotInvalidated = false
            await self.load(refreshNewAccounts: false)
        }
    }

    private func call<T: Decodable>(_ path: String, body: [String: Any]? = nil) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if !isStaging { try BridgeAuthorization.apply(to: &request) }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(baseURL.absoluteString, forHTTPHeaderField: "Origin")
            request.setValue("accounts", forHTTPHeaderField: "X-Bridge-Action")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let response = response as? HTTPURLResponse else { throw BridgeFailure(message: L10n.text("error.serviceAction")) }
        guard (200..<300).contains(response.statusCode) else {
            let detail = try? decoder.decode(ErrorResponse.self, from: data)
            let fallback: String
            switch response.statusCode {
            case 400, 422: fallback = "error.invalidRequest"
            case 401, 403: fallback = "error.authorization"
            case 404: fallback = "error.unavailableAction"
            case 409: fallback = "error.conflict"
            default: fallback = "error.serviceAction"
            }
            let connectionMessage = path.hasPrefix("_bridge/connect") ? PendingConnection.localizedError(code: detail?.error.code) : nil
            throw BridgeFailure(message: connectionMessage ?? L10n.serviceMessage(code: detail?.error.code, fallback: fallback))
        }
        return try decoder.decode(T.self, from: data)
    }
    @discardableResult
    func load(refresh: Bool = false, refreshNewAccounts: Bool = true) async -> Bool {
        guard !refreshing, !applying else { return false }
        refreshing = true
        defer { refreshing = false }
        do {
            var result: PoolSnapshot = try await call(refresh ? "_bridge/refresh" : "_bridge/accounts", body: refresh ? [:] : nil)
            let previousAccounts = Set(snapshot?.accounts.map(\.email) ?? [])
            let connectedAccount = result.connection == nil && snapshot?.connection != nil
            let addedAccount = result.accounts.contains { !previousAccounts.contains($0.email) }
            if refreshNewAccounts && !refresh && (connectedAccount || addedAccount) {
                snapshot = result
                result = try await call("_bridge/refresh", body: [:])
                lastRefresh = Date()
            }
            snapshot = result
            if refresh { lastRefresh = Date() }
            if result.connection == nil { loginURL = nil; loginEmail = nil }
            queryError = nil
            return true
        } catch is CancellationError { return false } catch {
            if Task.isCancelled || stopped { return false }
            queryError = userMessage(error)
            return false
        }
    }
    private func userMessage(_ error: Error) -> String {
        if let failure = error as? BridgeFailure { return failure.message }
        if error is DecodingError { return L10n.text("error.unexpectedData") }
        return L10n.text("error.localService")
    }
    private func mutate(_ path: String, body: [String: Any]) {
        guard !applying, !refreshing else { return }
        applying = true; actionError = nil
        Task {
            defer { applying = false }
            do {
                let result: PoolSnapshot = try await call(path, body: body)
                snapshot = result; queryError = nil
                if result.connection == nil { loginURL = nil; loginEmail = nil }
            } catch {
                if path == "_bridge/reset", !(error is BridgeFailure) {
                    actionError = L10n.text("error.resetUncertain")
                } else { actionError = userMessage(error) }
            }
        }
    }
    func setAutomatic() {
        guard let snapshot else { return }
        mutate("_bridge/settings", body: ["revision": snapshot.revision, "mode": "automatic"])
    }
    func fix(_ account: Account) {
        guard let snapshot else { return }
        mutate("_bridge/settings", body: ["revision": snapshot.revision, "mode": "fixed", "fixed_email": account.email])
    }
    func move(_ account: Account, by delta: Int) {
        guard let snapshot, let index = snapshot.priorityOrder.firstIndex(of: account.email) else { return }
        let next = index + delta
        guard snapshot.priorityOrder.indices.contains(next) else { return }
        var order = snapshot.priorityOrder; order.swapAt(index, next)
        mutate("_bridge/settings", body: ["revision": snapshot.revision, "priority_order": order])
    }
    func prioritize(_ account: Account) {
        guard let snapshot else { return }
        let order = [account.email] + snapshot.priorityOrder.filter { $0 != account.email }
        mutate("_bridge/settings", body: ["revision": snapshot.revision, "mode": "automatic", "priority_order": order])
    }
    func setExtraCredits(_ enabled: Bool) {
        guard let snapshot, !applying, !refreshing, enabled != snapshot.allowExtraCredits else { return }
        if enabled { confirmation = .extraCredits }
        else { mutate("_bridge/settings", body: ["revision": snapshot.revision, "allow_extra_credits": false]) }
    }
    func setAutoReset(_ account: Account, enabled: Bool) {
        guard let snapshot, !applying, !refreshing,
            let current = snapshot.accounts.first(where: { $0.email == account.email }), enabled != current.resets.autoEnabled else { return }
        if enabled { confirmation = .autoReset(current, revision: snapshot.revision) }
        else { updateAutoReset(email: account.email, enabled: false) }
    }
    private func updateAutoReset(email: String, enabled: Bool) {
        guard let snapshot, snapshot.accounts.contains(where: { $0.email == email }) else { return }
        var emails = snapshot.autoResetEmails.filter { $0 != email }
        if enabled { emails.append(email) }
        mutate("_bridge/settings", body: ["revision": snapshot.revision, "auto_reset_emails": emails])
    }
    func applyReset(_ account: Account) {
        guard let snapshot, let current = snapshot.accounts.first(where: { $0.email == account.email }),
            !applying, !refreshing, current.resets.canApply else { return }
        confirmation = .reset(current, revision: snapshot.revision)
    }
    func confirmAction(_ confirmation: AccountConfirmation) {
        guard !applying, !refreshing else { return }
        self.confirmation = nil
        switch confirmation {
        case .disconnect(let account): disconnect(account)
        case .extraCredits:
            guard let snapshot else { return }
            mutate("_bridge/settings", body: ["revision": snapshot.revision, "allow_extra_credits": true])
        case .autoReset(let account, let revision):
            guard let snapshot, snapshot.revision == revision, snapshot.accounts.contains(where: { $0.email == account.email }) else {
                actionError = L10n.text("error.resetChanged"); return
            }
            updateAutoReset(email: account.email, enabled: true)
        case .reset(let account, let revision):
            guard let snapshot, snapshot.revision == revision,
                  let current = snapshot.accounts.first(where: { $0.email == account.email }), current.resets.canApply,
                  current.resets == account.resets else {
                actionError = L10n.text("error.resetChanged")
                return
            }
            mutate("_bridge/reset", body: ["revision": revision, "email": account.email])
        }
    }
    func connect() {
        guard !applying, !refreshing else { return }
        let email = connectionEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !email.isEmpty else { actionError = L10n.text("error.emailRequired"); return }
        applying = true; actionError = nil
        Task {
            do {
                let result: LoginResponse = try await call("_bridge/connect", body: ["email": email])
                guard let url = PendingConnection.authorizationURL(result.authUrl) else {
                    throw BridgeFailure(message: L10n.text("error.authorizationURL"))
                }
                loginURL = url; loginEmail = result.email; showingConnectionForm = false; connectionEmail = ""
                if !openURL(url) { actionError = L10n.text("error.openBrowser") }
                applying = false; await load()
            } catch {
                applying = false; actionError = userMessage(error)
                let refreshed = await load(refreshNewAccounts: false)
                if refreshed, let connection = snapshot?.connection, connection.email.lowercased() == email.lowercased() {
                    showingConnectionForm = false; connectionEmail = ""
                    if !(error is BridgeFailure) { actionError = nil }
                }
            }
        }
    }
    func cancelConnectionForm() {
        guard !applying else { return }
        showingConnectionForm = false; connectionEmail = ""
    }
    private var continuationURL: URL? {
        guard let connection = snapshot?.connection, !connection.hasError else { return nil }
        if connection.url != nil { return PendingConnection.authorizationURL(connection.url) }
        guard loginEmail?.lowercased() == connection.email.lowercased() else { return nil }
        return loginURL
    }
    func continueLogin() {
        guard !applying, !refreshing, let url = continuationURL else { return }
        actionError = openURL(url) ? nil : L10n.text("error.openBrowser")
    }
    var canContinueLogin: Bool { continuationURL != nil }
    func retryConnection() {
        guard !applying, !refreshing, let connection = snapshot?.connection, connection.canRetry else { return }
        let email = connection.email
        applying = true; actionError = nil
        Task {
            defer { applying = false }
            do {
                let result: PoolSnapshot = try await call("_bridge/connect/cancel", body: [:])
                snapshot = result; queryError = nil
                guard result.connection == nil else {
                    actionError = L10n.text("connection.cancelUnconfirmed")
                    return
                }
                loginURL = nil; loginEmail = nil
                connectionEmail = email; showingConnectionForm = true
            } catch { actionError = userMessage(error) }
        }
    }
    func cancelConnection() {
        guard !applying, !refreshing else { return }
        mutate("_bridge/connect/cancel", body: [:])
    }
    private func disconnect(_ account: Account) { mutate("_bridge/disconnect", body: ["email": account.email]) }
    func setOpenAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            openAtLogin = SMAppService.mainApp.status == .enabled
            if SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        } catch { actionError = L10n.text("error.loginItem", error.localizedDescription) }
    }
    private struct ServiceHealth: Decodable {
        let backend: String
        let service: ServiceIdentity?
        let draining: Bool?
    }
    private func currentServiceIsReady() async -> Bool {
        guard let health: ServiceHealth = try? await call("healthz"), health.backend == "codex-pool" else { return false }
        return ServiceReadiness.isCurrent(health.service, draining: health.draining != false, expectedBuild: expectedServiceBuild)
    }
    func checkServiceReadiness(forcePreparation: Bool = false) async {
        guard !preparingService else { return }
        preparingService = true
        defer { preparingService = false }
        if await currentServiceIsReady() {
            maintenancePending = false; maintenanceMessage = nil; maintenanceNeedsAttention = false; awaitingServiceTransition = false
            return
        }
        maintenancePending = true
        maintenanceNeedsAttention = false
        maintenanceMessage = L10n.text("service.maintenancePending")
        do {
            try Task.checkCancellation()
            let action = !forcePreparation && awaitingServiceTransition ? "service-status" : "service"
            if action == "service", let beforeServicePreparation, await beforeServicePreparation() == false {
                throw BridgeFailure(message: L10n.text("error.localService"))
            }
            awaitingServiceTransition = true
            let result = try await setupExecutor(["action": action])
            try Task.checkCancellation()
            if result.service?.status == .legacy {
                maintenanceMessage = L10n.text("service.maintenanceLegacy")
                maintenanceNeedsAttention = true
            } else if result.ok, result.service?.isReady == true {
                if await currentServiceIsReady() {
                    maintenancePending = false; maintenanceMessage = nil; maintenanceNeedsAttention = false; awaitingServiceTransition = false
                }
            } else if !(result.ok && result.service?.isPending == true) {
                throw BridgeFailure(message: result.localizedMessage(fallback: "error.setup"))
            }
        } catch is CancellationError {} catch {
            maintenanceMessage = userMessage(error)
            maintenanceNeedsAttention = true
        }
    }
    func restoreConnection() {
        guard !applying, !refreshing, !preparingService else { return }
        actionError = nil
        Task {
            await checkServiceReadiness(forcePreparation: true)
            await load(refresh: !maintenancePending)
        }
    }
    func openSetup() { NotificationCenter.default.post(name: Notification.Name("ShowClaudeSetup"), object: nil) }
}
