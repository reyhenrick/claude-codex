import Foundation

final class AccountURLProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> Data)?
    nonisolated(unsafe) static var requests: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); Self.requests.append(request); let handler = Self.handler; Self.lock.unlock()
        do {
            guard let handler else { throw URLError(.unsupportedURL) }
            let data = try handler(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
    static func install(_ action: @escaping (URLRequest) throws -> Data) {
        lock.lock(); handler = action; requests = []; lock.unlock()
    }
    static func captured() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests }
}

@main @MainActor struct AccountsModelTests {
    static var assertions = 0
    static func expect(_ value: @autoclosure () -> Bool, _ message: String) {
        assertions += 1; precondition(value(), message)
    }
    static func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    static func fixture(revision: Int = 1, reason: String = "available", pending: Bool = false, connected: Bool = true) -> [String: Any] {
        let email = "synthetic@example.invalid"
        var row: [String: Any] = ["email": email, "plan":"pro", "connected":true, "eligible":true, "reason":"available", "windows":[], "subscription_status":"available", "credits":["known":false,"eligible":false], "resets":["known":true,"available_count":2,"applicable_count":1,"can_apply":true,"reason":reason,"auto_enabled":false,"threshold_percent":5]]
        if reason == "retry" {
            row["resets"] = ["known":true,"available_count":2,"applicable_count":1,"can_apply":true,"reason":"retry","auto_enabled":false,"threshold_percent":5,"operation":["status":"uncertain","source":"manual","updated_at":"2026-10-17T00:00:00Z","message":"synthetic","verified":false]]
        }
        var value: [String: Any] = ["revision":revision, "mode":"automatic", "priority_order":connected ? [email] : [],"accounts":connected ? [row] : [],"allow_extra_credits":false,"auto_reset_emails":[],"auto_reset_threshold_percent":5,"credit_phase":false,"credit_block_reason":"disabled"]
        if pending { value["connection"] = ["email":email,"started_at":"2026-10-17T00:00:00Z"] }
        return value
    }
    static func snapshot(_ value: [String: Any]) throws -> PoolSnapshot {
        let decoder=JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(PoolSnapshot.self, from: json(value))
    }
    static func makeModel() -> AccountsModel {
        let config=URLSessionConfiguration.ephemeral; config.protocolClasses=[AccountURLProtocol.self]
        return AccountsModel(staging:true, session:URLSession(configuration:config), openURL:{ _ in true })
    }
    static func settle(_ model: AccountsModel) async {
        for _ in 0..<1000 {
            if !model.applying && !model.refreshing { return }
            try? await Task.sleep(for:.milliseconds(2))
        }
        preconditionFailure("Synthetic request did not settle")
    }
    static func main() async throws {
        AccountURLProtocol.install { _ in try json(fixture()) }
        let stale = makeModel(); defer { stale.stop() }
        stale.snapshot = try snapshot(fixture(reason:"retry")); stale.applyReset(stale.snapshot!.accounts[0])
        let oldConfirmation = stale.confirmation!
        stale.snapshot = try snapshot(fixture(revision:4)); stale.confirmAction(oldConfirmation)
        await settle(stale)
        expect(AccountURLProtocol.captured().isEmpty,"A stale retry confirmation must never send a new reset")
        expect(stale.actionError != nil,"Changed consent must explain why no reset was sent")

        stale.actionError=nil; stale.applyReset(stale.snapshot!.accounts[0]); let consent=stale.confirmation!
        var changed = fixture(revision:4); var row = (changed["accounts"] as! [[String:Any]])[0]
        var resets=row["resets"] as! [String:Any]; resets["available_count"]=1; row["resets"]=resets; changed["accounts"]=[row]
        stale.snapshot=try snapshot(changed); stale.confirmAction(consent)
        expect(AccountURLProtocol.captured().isEmpty,"Changed reset eligibility must invalidate consent even at same revision")

        AccountURLProtocol.install { _ in try json(fixture(revision:5)) }
        stale.snapshot=try snapshot(fixture(revision:4)); stale.applyReset(stale.snapshot!.accounts[0]); stale.confirmAction(stale.confirmation!)
        await settle(stale)
        expect(AccountURLProtocol.captured().count == 1,"Unchanged consent sends exactly one request")
        expect(AccountURLProtocol.captured().first?.url?.path == "/_bridge/reset","Confirmed reset uses reset endpoint")

        AccountURLProtocol.install { _ in try json(fixture(revision:6)) }
        stale.snapshot=try snapshot(fixture(revision:5))
        stale.setAutoReset(stale.snapshot!.accounts[0], enabled:true); let oldAutoConsent=stale.confirmation!
        stale.snapshot=try snapshot(fixture(revision:6)); stale.confirmAction(oldAutoConsent); await settle(stale)
        expect(AccountURLProtocol.captured().isEmpty,"Stale automatic-reset consent cannot change settings")
        expect(stale.actionError != nil,"Stale automatic-reset consent reports the conflict")
        stale.setAutoReset(stale.snapshot!.accounts[0], enabled:true); stale.confirmAction(stale.confirmation!); await settle(stale)
        expect(AccountURLProtocol.captured().map { $0.url!.path } == ["/_bridge/settings"],"Fresh automatic-reset consent sends exactly one settings change")

        AccountURLProtocol.install { request in
            if request.url!.path == "/_bridge/connect" { return try json(["auth_url":"https://auth.openai.com/oauth/authorize?synthetic=true","email":"synthetic@example.invalid"]) }
            return try json(fixture(pending:true, connected:false))
        }
        let oauth=makeModel(); defer { oauth.stop() }
        oauth.snapshot=try snapshot(fixture(connected:false)); oauth.connectionEmail="synthetic@example.invalid"; oauth.connect(); await settle(oauth)
        expect(oauth.canContinueLogin,"Successful synthetic authorization retains continuation URL")
        let before=AccountURLProtocol.captured().count; oauth.refreshing=true; oauth.cancelConnection()
        expect(AccountURLProtocol.captured().count == before && oauth.canContinueLogin,"Cancel during polling preserves URL and does not discard the operation")
        oauth.refreshing=false
        AccountURLProtocol.install { _ in throw URLError(.notConnectedToInternet) }
        oauth.cancelConnection(); await settle(oauth)
        expect(oauth.canContinueLogin && oauth.actionError != nil,"A failed cancellation preserves continuation URL")
        AccountURLProtocol.install { _ in try json(fixture(connected:false)) }
        oauth.cancelConnection(); await settle(oauth)
        expect(!oauth.canContinueLogin,"Only confirmed cancellation clears continuation URL")

        AccountURLProtocol.install { _ in try json(fixture()) }
        let connection=makeModel(); defer { connection.stop() }
        connection.snapshot=try snapshot(fixture(pending:true, connected:false)); await connection.load()
        expect(AccountURLProtocol.captured().map { $0.url!.path } == ["/_bridge/accounts","/_bridge/refresh"],"OAuth completion immediately refreshes new-account quota")
        expect(connection.lastRefresh != nil,"Connection refresh records freshness")
        AccountURLProtocol.install { _ in throw URLError(.cannotConnectToHost) }
        await connection.load()
        expect(connection.snapshot != nil && connection.queryError != nil,"Lost service retains previous data and error for recovery UI")

        let setup=SetupModel()
        let failureData=try json(["ok":false,"code":"setup.migration_failed","message":"synthetic","migration":["copied_files":0,"skipped_files":1,"warnings":["migration.synthetic"],"report_path":"/synthetic/report.json"]])
        let decoder=JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        setup.accept(try decoder.decode(SetupResult.self,from:failureData))
        expect(setup.result?.migration?.reportPath == "/synthetic/report.json","Failed migration retains the diagnostic report")
        expect(setup.resultMessage == nil && setup.error != nil,"Failed migration is never represented as a successful installation")
        print("Native account state tests: \(assertions) assertions passed; all network requests intercepted")
    }
}
