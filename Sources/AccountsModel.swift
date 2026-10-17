import AppKit
import Combine
import Foundation
import ServiceManagement

@MainActor
final class AccountsModel: ObservableObject {
    @Published var snapshot: PoolSnapshot?
    @Published var error: String?
    @Published var refreshing = false
    @Published var applying = false
    @Published var showingConnectionForm = false
    @Published var connectionEmail = ""
    @Published var disconnectCandidate: Account?
    @Published var openAtLogin = SMAppService.mainApp.status == .enabled
    @Published var lastRefresh: Date?
    private var loginURL: URL?
    private var polling: Task<Void, Never>?
    private let session: URLSession
    let baseURL: URL

    init(staging: Bool = false) {
        baseURL = URL(string: staging ? "http://127.0.0.1:18769" : "http://127.0.0.1:18765")!
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 45
        config.timeoutIntervalForResource = 60
        session = URLSession(configuration: config)
    }
    func start() {
        polling = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.load(refresh: self.snapshot == nil)
                let interval = self.snapshot?.connection == nil ? 15 : 2
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }
    func stop() { polling?.cancel(); polling = nil; session.invalidateAndCancel() }

    private func call<T: Decodable>(_ path: String, body: [String: Any]? = nil) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(baseURL.absoluteString, forHTTPHeaderField: "Origin")
            request.setValue("accounts", forHTTPHeaderField: "X-Bridge-Action")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            let detail = try? decoder.decode(ErrorResponse.self, from: data)
            throw BridgeFailure(message: detail?.error.message ?? "O serviço de contas não respondeu. Tente novamente.")
        }
        return try decoder.decode(T.self, from: data)
    }
    func load(refresh: Bool = false) async {
        guard !refreshing, !applying else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            let result: PoolSnapshot = try await call(refresh ? "_bridge/refresh" : "_bridge/accounts", body: refresh ? [:] : nil)
            snapshot = result
            if refresh { lastRefresh = Date() }
            if result.connection == nil { loginURL = nil }
            error = nil
        } catch is CancellationError {} catch {
            self.error = userMessage(error)
        }
    }
    private func userMessage(_ error: Error) -> String {
        if let failure = error as? BridgeFailure { return failure.message }
        if error is DecodingError { return "O serviço retornou dados inesperados. Atualize o app e tente novamente." }
        return "Não foi possível acessar o serviço local. Use “Preparar serviço” e tente novamente."
    }
    private func mutate(_ path: String, body: [String: Any]) {
        guard !applying, !refreshing else { return }
        applying = true; error = nil
        Task {
            defer { applying = false }
            do { let result: PoolSnapshot = try await call(path, body: body); snapshot = result }
            catch { self.error = userMessage(error) }
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
    func connect() {
        guard !applying, !refreshing else { return }
        let email = connectionEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !email.isEmpty else { error = "Informe o e-mail da conta."; return }
        applying = true; error = nil
        Task {
            do {
                let result: LoginResponse = try await call("_bridge/connect", body: ["email": email])
                guard let url = URL(string: result.authUrl), url.scheme == "https", url.host == "auth.openai.com", url.path == "/oauth/authorize" else {
                    throw BridgeFailure(message: "O endereço de autorização não é válido.")
                }
                loginURL = url; showingConnectionForm = false; connectionEmail = ""
                if !NSWorkspace.shared.open(url) { error = "Não foi possível abrir o navegador. Use “Continuar login”." }
                applying = false; await load()
            } catch { applying = false; self.error = userMessage(error) }
        }
    }
    func continueLogin() { if let loginURL { NSWorkspace.shared.open(loginURL) } }
    var canContinueLogin: Bool { loginURL != nil }
    func cancelConnection() { loginURL = nil; mutate("_bridge/connect/cancel", body: [:]) }
    func disconnect(_ account: Account) { mutate("_bridge/disconnect", body: ["email": account.email]) }
    func setOpenAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            openAtLogin = SMAppService.mainApp.status == .enabled
            if SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        } catch { self.error = "Não foi possível alterar o início de sessão: \(error.localizedDescription)" }
    }
    func startService() {
        guard !applying, !refreshing else { return }
        applying = true; error = nil
        Task {
            do {
                let result = try await runSetup(["action": "service"])
                if !result.ok { throw BridgeFailure(message: result.message) }
                try? await Task.sleep(for: .seconds(2))
                applying = false; await load(refresh: true)
            } catch { applying = false; self.error = error.localizedDescription }
        }
    }
    func openSetup() { NotificationCenter.default.post(name: Notification.Name("ShowClaudeSetup"), object: nil) }
    func openBrowserPanel() { NSWorkspace.shared.open(baseURL.appendingPathComponent("accounts")) }
}
