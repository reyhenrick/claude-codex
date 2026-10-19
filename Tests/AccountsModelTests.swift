import Foundation

final class AccountURLProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> Data)?
    nonisolated(unsafe) static var statusCode = 200
    nonisolated(unsafe) static var statusForRequest: ((URLRequest) -> Int)?
    nonisolated(unsafe) static var requests: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); Self.requests.append(request); let handler = Self.handler; let defaultStatus = Self.statusCode; let statusForRequest = Self.statusForRequest; Self.lock.unlock()
        let statusCode = statusForRequest?(request) ?? defaultStatus
        do {
            guard let handler else { throw URLError(.unsupportedURL) }
            let data = try handler(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: statusCode, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
    static func install(status: Int = 200, statusForRequest: ((URLRequest) -> Int)? = nil, _ action: @escaping (URLRequest) throws -> Data) {
        lock.lock(); handler = action; statusCode = status; Self.statusForRequest = statusForRequest; requests = []; lock.unlock()
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
    static func makeModel(expectedServiceBuild: String? = nil,
                          setupExecutor: (([String: Any]) async throws -> SetupResult)? = nil,
                          openURL: @escaping (URL) -> Bool = { _ in true }) -> AccountsModel {
        let config=URLSessionConfiguration.ephemeral; config.protocolClasses=[AccountURLProtocol.self]
        return AccountsModel(staging:true, session:URLSession(configuration:config), expectedServiceBuild:expectedServiceBuild,
                             setupExecutor:setupExecutor, openURL:openURL)
    }
    static func settle(_ model: AccountsModel) async {
        for _ in 0..<1000 {
            if !model.applying && !model.refreshing { return }
            try? await Task.sleep(for:.milliseconds(2))
        }
        preconditionFailure("Synthetic request did not settle")
    }
    static func settleSetup(_ model: SetupModel) async {
        for _ in 0..<1000 {
            if !model.busy { return }
            try? await Task.sleep(for:.milliseconds(2))
        }
        preconditionFailure("Synthetic setup did not settle")
    }
    static func requestBody(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating:0,count:1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer,maxLength:buffer.count)
                if count <= 0 { break }
                data.append(contentsOf:buffer.prefix(count))
            }
        }
        return try JSONSerialization.jsonObject(with:data) as! [String:Any]
    }
    static func accountBehaviorMatrix() async throws {
        let emails = ["first@example.invalid","second@example.invalid","third@example.invalid"]
        var state = fixture(revision:100)
        let sample = (state["accounts"] as! [[String:Any]])[0]
        var rows = emails.map { email -> [String:Any] in
            var row = sample; row["email"] = email; row["active_requests"] = 0
            return row
        }
        state["accounts"] = rows; state["priority_order"] = emails
        let model = makeModel(); defer { model.stop() }; model.snapshot = try snapshot(state)
        AccountURLProtocol.install { _ in try json(state) }
        model.move(model.snapshot!.accounts[0],by:-1); model.move(model.snapshot!.accounts[2],by:1)
        expect(AccountURLProtocol.captured().isEmpty,"Moving the first account up or last account down never sends an invalid order")

        state["mode"] = "fixed"; state["fixed_email"] = emails[2]; state["revision"] = 101
        AccountURLProtocol.install { _ in try json(state) }
        model.fix(model.snapshot!.accounts[2]); await settle(model)
        var body = try requestBody(AccountURLProtocol.captured()[0])
        expect(body["mode"] as? String == "fixed" && body["fixed_email"] as? String == emails[2],"Choosing a fixed account targets the selected email")
        expect(body["revision"] as? Int == 100 && model.snapshot?.priorityOrder == emails,"Fixed mode uses the visible revision and preserves the priority order")

        state["mode"] = "automatic"; state["revision"] = 102
        AccountURLProtocol.install { _ in try json(state) }
        model.setAutomatic(); await settle(model)
        body = try requestBody(AccountURLProtocol.captured()[0])
        expect(body["mode"] as? String == "automatic" && body["fixed_email"] == nil,"Switching to automatic does not silently replace the remembered fixed account")

        let promotedOrder = [emails[2],emails[0],emails[1]]
        state["priority_order"] = promotedOrder; state["accounts"] = [rows[2],rows[0],rows[1]]; state["revision"] = 103
        AccountURLProtocol.install { _ in try json(state) }
        model.prioritize(model.snapshot!.accounts[2]); await settle(model)
        body = try requestBody(AccountURLProtocol.captured()[0])
        expect(body["priority_order"] as? [String] == promotedOrder && body["mode"] as? String == "automatic","Use first promotes the chosen account and selects automatic mode")

        let movedOrder = [emails[0],emails[2],emails[1]]
        state["priority_order"] = movedOrder; state["accounts"] = [rows[0],rows[2],rows[1]]; state["revision"] = 104
        AccountURLProtocol.install { _ in try json(state) }
        model.move(model.snapshot!.accounts[1],by:-1); await settle(model)
        body = try requestBody(AccountURLProtocol.captured()[0])
        expect(body["priority_order"] as? [String] == movedOrder && body["mode"] == nil,"Reordering changes only priority and does not silently change consumption mode")

        AccountURLProtocol.install { _ in try json(state) }
        model.setExtraCredits(true)
        expect(model.confirmation != nil && AccountURLProtocol.captured().isEmpty,"Enabling extra credits requires explicit consent before any settings request")
        model.confirmation = nil
        expect(model.snapshot?.allowExtraCredits == false,"Cancelling credit consent keeps consumption forbidden")
        state["allow_extra_credits"] = true; state["revision"] = 105
        model.setExtraCredits(true); model.confirmAction(model.confirmation!); await settle(model)
        body = try requestBody(AccountURLProtocol.captured()[0])
        expect(body["allow_extra_credits"] as? Bool == true && body["revision"] as? Int == 104,"Confirmed credit permission changes only the currently displayed revision")
        state["allow_extra_credits"] = false; state["revision"] = 106
        AccountURLProtocol.install { _ in try json(state) }
        model.setExtraCredits(false); await settle(model)
        body = try requestBody(AccountURLProtocol.captured()[0])
        expect(body["allow_extra_credits"] as? Bool == false && model.confirmation == nil,"Revoking extra credits is immediate and never asks for spending consent")

        AccountURLProtocol.install(status:409) { _ in try json(["error":["message":"synthetic stale revision"]]) }
        let originalOrder = model.snapshot!.priorityOrder
        model.move(model.snapshot!.accounts[0],by:1); await settle(model)
        expect(model.snapshot?.priorityOrder == originalOrder && model.actionError == L10n.text("error.conflict"),"A rejected stale order never appears successfully applied")
        expect(AccountURLProtocol.captured().count == 1,"A revision conflict never retries a mutation without new user intent")

        state["mode"] = "fixed"; state["fixed_email"] = emails[2]; state["revision"] = 107
        model.snapshot = try snapshot(state)
        let removed = model.snapshot!.accounts.first { $0.email == emails[2] }!
        state["mode"] = "automatic"; state.removeValue(forKey:"fixed_email"); state["priority_order"] = [emails[0],emails[1]]
        state["accounts"] = [rows[0],rows[1]]; state["revision"] = 108
        AccountURLProtocol.install { _ in try json(state) }
        model.confirmation = .disconnect(removed); model.confirmation = nil
        expect(AccountURLProtocol.captured().isEmpty,"Dismissing the removal confirmation never disconnects an account")
        model.confirmAction(.disconnect(removed)); await settle(model)
        body = try requestBody(AccountURLProtocol.captured()[0])
        expect(AccountURLProtocol.captured()[0].url?.path == "/_bridge/disconnect" && body["email"] as? String == emails[2],"Removal targets the specifically confirmed account")
        expect(model.snapshot?.mode == "automatic" && model.snapshot?.fixedEmail == nil && model.snapshot?.accounts.count == 2,"A confirmed fixed-account removal displays the backend's automatic-mode result")

        rows[0]["active_requests"] = 1; state["accounts"] = [rows[0],rows[1]]; model.snapshot = try snapshot(state)
        AccountURLProtocol.install(status:409) { _ in try json(["error":["message":"synthetic active account"]]) }
        model.confirmAction(.disconnect(model.snapshot!.accounts[0])); await settle(model)
        expect(model.snapshot?.accounts.count == 2 && model.actionError == L10n.text("error.conflict"),"An active-account removal rejection keeps the account visible and explains the conflict")

        let unknownCredits = AccountCredits(known:false,hasCredits:nil,unlimited:nil,balance:nil,eligible:false)
        let emptyCredits = AccountCredits(known:true,hasCredits:false,unlimited:false,balance:nil,eligible:false)
        let unreportedCredits = AccountCredits(known:true,hasCredits:true,unlimited:false,balance:nil,eligible:true)
        expect(Set([unknownCredits.label,emptyCredits.label,unreportedCredits.label]).count == 3,"Unknown, empty and unreported credit balances remain distinct")

        for iteration in 0..<24 {
            state["revision"] = 200 + iteration; state["mode"] = "automatic"; state["allow_extra_credits"] = false
            model.snapshot = try snapshot(state)
            let refreshState = state, refreshRelease = DispatchSemaphore(value:0)
            AccountURLProtocol.install { _ in
                guard refreshRelease.wait(timeout:.now()+5) == .success else { throw URLError(.timedOut) }
                if iteration % 3 == 0 { throw URLError(.notConnectedToInternet) }
                return try json(refreshState)
            }
            let refreshTask = Task { await model.load(refresh:true) }
            for _ in 0..<1000 {
                if model.refreshing { break }
                try? await Task.sleep(for:.milliseconds(2))
            }
            expect(model.refreshing,"The stress refresh actually reaches an in-flight state")
            model.fix(model.snapshot!.accounts[0]); model.setExtraCredits(true); model.move(model.snapshot!.accounts[0],by:1)
            expect(!model.applying && model.confirmation == nil,"Polling blocks overlapping actions without queuing hidden mutations")
            refreshRelease.signal(); _ = await refreshTask.value
            expect(AccountURLProtocol.captured().map { $0.url?.path } == ["/_bridge/refresh"],"Only the intended refresh was sent during concurrent action attempts")
            expect((model.queryError != nil) == (iteration % 3 == 0),"Successful and failed concurrent refreshes preserve the correct feedback")

            let mutationRelease = DispatchSemaphore(value:0)
            var appliedState = state
            appliedState["mode"] = "fixed"; appliedState["fixed_email"] = model.snapshot!.accounts[iteration % 2].email
            appliedState["revision"] = 201 + iteration
            let mutationState = appliedState
            let mutationSucceeds = iteration % 2 == 0
            let mutationStatus = mutationSucceeds ? 200 : 409
            AccountURLProtocol.install(status:mutationStatus) { _ in
                guard mutationRelease.wait(timeout:.now()+5) == .success else { throw URLError(.timedOut) }
                if mutationSucceeds { return try json(mutationState) }
                return try json(["error":["message":"synthetic stale revision"]])
            }
            model.fix(model.snapshot!.accounts[iteration % 2])
            expect(model.applying,"The stress mutation actually reaches an in-flight state")
            await model.load(refresh:true)
            model.setAutomatic(); model.prioritize(model.snapshot!.accounts[0])
            mutationRelease.signal(); await settle(model)
            expect(AccountURLProtocol.captured().map { $0.url?.path } == ["/_bridge/settings"],"A refresh or second action cannot overwrite an applying mutation")
            expect((model.actionError != nil) == (iteration % 2 != 0),"Alternating mutation success and conflict outcomes settle without hidden retries")
        }
    }
    static func main() async throws {
        var zeroMeterFixture = fixture()
        var zeroMeterRow = (zeroMeterFixture["accounts"] as! [[String: Any]])[0]
        zeroMeterRow["ordinary_allowed"] = true; zeroMeterRow["remaining_percent"] = 0
        zeroMeterFixture["accounts"] = [zeroMeterRow]
        var decodedZeroMeter = try snapshot(zeroMeterFixture).accounts[0]
        expect(decodedZeroMeter.serviceAllowsAtDisplayedLimit,
               "A zero meter must disclose the provider's continuing subscription permission")
        zeroMeterRow["remaining_percent"] = 10; zeroMeterFixture["accounts"] = [zeroMeterRow]
        decodedZeroMeter = try snapshot(zeroMeterFixture).accounts[0]
        expect(!decodedZeroMeter.serviceAllowsAtDisplayedLimit, "Ordinary positive meters need no special note")
        zeroMeterRow["remaining_percent"] = 0; zeroMeterRow["eligible"] = false; zeroMeterFixture["accounts"] = [zeroMeterRow]
        decodedZeroMeter = try snapshot(zeroMeterFixture).accounts[0]
        expect(!decodedZeroMeter.serviceAllowsAtDisplayedLimit, "Blocked accounts cannot claim permission")
        zeroMeterRow["eligible"] = true; zeroMeterRow["subscription_status"] = "unknown"; zeroMeterFixture["accounts"] = [zeroMeterRow]
        decodedZeroMeter = try snapshot(zeroMeterFixture).accounts[0]
        expect(!decodedZeroMeter.serviceAllowsAtDisplayedLimit, "Unknown allowance cannot claim subscription permission")
        let legacyAllowanceAccount = try snapshot(fixture()).accounts[0]
        expect(!legacyAllowanceAccount.serviceAllowsAtDisplayedLimit, "Older snapshots without permission fields remain compatible")
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

        let form = makeModel(); defer { form.stop() }
        form.showingConnectionForm = true; form.connectionEmail = "synthetic@example.invalid"; form.applying = true
        form.cancelConnectionForm()
        expect(form.showingConnectionForm && !form.connectionEmail.isEmpty,"The connection form cannot be cancelled while its request is applying")
        form.applying = false; form.cancelConnectionForm()
        expect(!form.showingConnectionForm && form.connectionEmail.isEmpty,"Cancelling an idle connection form closes and clears it")

        let authorizationURL = "https://auth.openai.com/oauth/authorize?state=synthetic"
        var resumable = fixture(pending:true, connected:false)
        resumable["connection"] = ["email":"synthetic@example.invalid", "started_at":"2026-10-18T00:00:00Z", "url":authorizationURL]
        var openedURLs: [URL] = []; var browserAvailable = true
        let reopened = makeModel(openURL: { url in openedURLs.append(url); return browserAvailable }); defer { reopened.stop() }
        AccountURLProtocol.install { _ in try json(resumable) }
        await reopened.load()
        expect(reopened.canContinueLogin,"A fresh manager resumes authorization from the validated pending-connection URL")
        reopened.continueLogin()
        expect(openedURLs.last?.absoluteString == authorizationURL,"Continue sign-in opens the pending session's authorization URL")
        browserAvailable = false; reopened.continueLogin()
        expect(reopened.actionError == L10n.text("error.openBrowser"),"A browser failure remains recoverable when continuing a reopened login")
        browserAvailable = true; reopened.continueLogin()
        expect(reopened.actionError == nil,"Successful browser reopening clears the earlier failure")
        reopened.refreshing = true; let openCount = openedURLs.count; reopened.continueLogin(); reopened.refreshing = false
        expect(openedURLs.count == openCount,"Continue sign-in cannot race a pending status refresh")

        let invalidAuthorizationURLs = ["http://auth.openai.com/oauth/authorize", "https://auth.openai.com.evil.invalid/oauth/authorize", "https://example.invalid/oauth/authorize", "https://user@auth.openai.com/oauth/authorize", "https://auth.openai.com:444/oauth/authorize", "https://auth.openai.com/oauth/authorize#unexpected", "https://auth.openai.com/other", "not a URL"]
        for invalidURL in invalidAuthorizationURLs {
            var unsafe = resumable
            unsafe["connection"] = ["email":"synthetic@example.invalid", "started_at":"2026-10-18T00:00:00Z", "url":invalidURL]
            reopened.snapshot = try snapshot(unsafe)
            expect(!reopened.canContinueLogin,"Unsafe authorization URLs are never offered for continuation")
            let count = openedURLs.count; reopened.continueLogin()
            expect(openedURLs.count == count,"Unsafe authorization URLs never reach the browser")
        }
        expect(PendingConnection.authorizationURL("https://auth.openai.com:443/oauth/authorize?state=synthetic") != nil,"The standard explicit HTTPS port remains valid")

        let oauthErrors = ["account_mismatch", "expired", "import_failed", "reconnect_busy", "session_unavailable"]
        for errorCode in oauthErrors {
            var failed = resumable
            failed["connection"] = ["email":"synthetic@example.invalid", "started_at":"2026-10-18T00:00:00Z", "url":authorizationURL, "error_code":"oauth.\(errorCode)"]
            reopened.snapshot = try snapshot(failed)
            expect(reopened.snapshot!.connection!.description == L10n.text("connection.error.\(errorCode)"),"Each OAuth error has its actionable localized explanation")
            expect(reopened.snapshot!.connection!.hasError && !reopened.canContinueLogin,"An OAuth error code without raw error text disables continuation")
            AccountURLProtocol.install(status:409) { _ in try json(["error":["code":"oauth.\(errorCode)","message":"Do not expose arbitrary service text"]]) }
            form.connectionEmail = "synthetic@example.invalid"; form.connect(); await settle(form)
            expect(form.actionError == L10n.text("connection.error.\(errorCode)"),"OAuth action errors use the same stable code mapping")
        }
        var unknownFailure = resumable
        unknownFailure["connection"] = ["email":"synthetic@example.invalid", "started_at":"2026-10-18T00:00:00Z", "error_code":"oauth.future_code", "error":"untrusted detail"]
        reopened.snapshot = try snapshot(unknownFailure)
        expect(reopened.snapshot!.connection!.description == L10n.text("connection.retryDescription"),"Unknown error codes use the generic retry explanation")
        unknownFailure["connection"] = ["email":"synthetic@example.invalid", "started_at":"2026-10-18T00:00:00Z", "error":"legacy detail"]
        reopened.snapshot = try snapshot(unknownFailure)
        expect(reopened.snapshot!.connection!.description == L10n.text("connection.retryDescription"),"Legacy snapshots without an error code retain the generic retry explanation")

        AccountURLProtocol.install { request in
            if request.url!.path == "/_bridge/connect" { return try json(["auth_url":authorizationURL,"email":"synthetic@example.invalid"]) }
            return try json(fixture(pending:true, connected:false))
        }
        form.connectionEmail = "synthetic@example.invalid"; form.connect(); await settle(form)
        expect(form.canContinueLogin,"A same-session legacy response can still use the locally retained authorization URL")
        var changedSession = fixture(pending:true, connected:false)
        changedSession["connection"] = ["email":"other@example.invalid", "started_at":"2026-10-18T00:00:00Z"]
        form.snapshot = try snapshot(changedSession)
        expect(!form.canContinueLogin,"A locally retained URL is never reused for another account")

        var recoveredBrowserOpens = 0
        let lostResponse = makeModel(openURL: { _ in recoveredBrowserOpens += 1; return true }); defer { lostResponse.stop() }
        AccountURLProtocol.install { request in
            if request.url?.path == "/_bridge/connect" { throw URLError(.networkConnectionLost) }
            return try json(resumable)
        }
        lostResponse.showingConnectionForm = true; lostResponse.connectionEmail = " SYNTHETIC@example.invalid "
        lostResponse.connect(); await settle(lostResponse)
        expect(!lostResponse.showingConnectionForm && lostResponse.connectionEmail.isEmpty && lostResponse.canContinueLogin && lostResponse.actionError == nil,"A lost connect response recovers the matching durable OAuth receipt without retaining a stale network error")
        expect(recoveredBrowserOpens == 0,"Recovering a pending OAuth receipt after an error never opens its URL automatically")
        expect(AccountURLProtocol.captured().map { $0.url?.path } == ["/_bridge/connect","/_bridge/accounts"],"Connect error recovery performs one read-only receipt check")

        AccountURLProtocol.install { request in
            if request.url?.path == "/_bridge/connect" { throw URLError(.networkConnectionLost) }
            return try json(fixture(connected:false))
        }
        lostResponse.showingConnectionForm = true; lostResponse.connectionEmail = "missing@example.invalid"
        lostResponse.connect(); await settle(lostResponse)
        expect(lostResponse.showingConnectionForm && lostResponse.connectionEmail == "missing@example.invalid" && lostResponse.actionError != nil,"A connect failure without a confirmed pending receipt keeps the editable form and its cause")

        lostResponse.snapshot = try snapshot(resumable)
        AccountURLProtocol.install { _ in throw URLError(.notConnectedToInternet) }
        lostResponse.connectionEmail = "synthetic@example.invalid"; lostResponse.connect(); await settle(lostResponse)
        expect(lostResponse.showingConnectionForm,"An older cached receipt is not treated as confirmed when the recovery read fails")

        var importFailure = resumable
        importFailure["connection"] = ["email":"synthetic@example.invalid","started_at":"2026-10-18T00:00:00Z","error_code":"oauth.import_failed"]
        AccountURLProtocol.install(statusForRequest: { $0.url?.path == "/_bridge/connect" ? 503 : 200 }) { request in
            if request.url?.path == "/_bridge/connect" { return try json(["error":["code":"oauth.import_failed","message":"Synthetic import failure"]]) }
            return try json(importFailure)
        }
        lostResponse.connect(); await settle(lostResponse)
        expect(!lostResponse.showingConnectionForm && lostResponse.snapshot?.connection?.hasError == true,"A confirmed failed OAuth import returns to the pending-connection recovery controls")
        expect(lostResponse.actionError == L10n.text("connection.error.import_failed") && !lostResponse.canContinueLogin && recoveredBrowserOpens == 0,"The specific OAuth error survives recovery and never opens an unavailable authorization session")

        AccountURLProtocol.install { _ in try json(fixture(connected:false)) }
        lostResponse.retryConnection(); lostResponse.retryConnection(); await settle(lostResponse)
        expect(AccountURLProtocol.captured().map { $0.url?.path } == ["/_bridge/connect/cancel"],"Retry cancels the prior OAuth operation exactly once before opening a new form")
        expect(lostResponse.showingConnectionForm && lostResponse.connectionEmail == "synthetic@example.invalid" && lostResponse.snapshot?.connection == nil,"Only a confirmed cancellation opens the retry form with the original email")
        expect(recoveredBrowserOpens == 0,"Retry preparation never opens the authorization browser automatically")

        lostResponse.showingConnectionForm = false; lostResponse.connectionEmail = ""; lostResponse.snapshot = try snapshot(importFailure)
        AccountURLProtocol.install { _ in throw URLError(.networkConnectionLost) }
        lostResponse.retryConnection(); await settle(lostResponse)
        expect(!lostResponse.showingConnectionForm && lostResponse.snapshot?.connection != nil && lostResponse.actionError != nil,"An uncertain cancellation preserves the pending operation and does not permit a new login")
        AccountURLProtocol.install { _ in try json(importFailure) }
        lostResponse.retryConnection(); await settle(lostResponse)
        expect(!lostResponse.showingConnectionForm && lostResponse.actionError == L10n.text("connection.cancelUnconfirmed"),"A cancellation response that still contains pending OAuth cannot open the retry form")

        var waitingForCalls = importFailure
        waitingForCalls["connection"] = ["email":"synthetic@example.invalid","started_at":"2026-10-18T00:00:00Z","error_code":"oauth.reconnect_busy"]
        lostResponse.snapshot = try snapshot(waitingForCalls)
        AccountURLProtocol.install { _ in try json(fixture(connected:false)) }
        lostResponse.retryConnection()
        expect(AccountURLProtocol.captured().isEmpty && lostResponse.snapshot?.connection?.canRetry == false,"A reconnection waiting for active requests never offers or executes Retry")
        expect(lostResponse.snapshot?.connection?.title == L10n.text("connection.connecting","synthetic@example.invalid"),"Automatic reconnect waiting is presented as in progress instead of a failed login")
        lostResponse.cancelConnection(); await settle(lostResponse)
        expect(AccountURLProtocol.captured().map { $0.url?.path } == ["/_bridge/connect/cancel"],"A busy reconnection still permits explicit cancellation")

        let primaryWindow = QuotaWindow(name:"Uso do Codex", usedPercent:10, windowSeconds:18000, resetAt:nil)
        let additionalWindow = QuotaWindow(name:"Reviews", usedPercent:100, windowSeconds:18000, resetAt:nil)
        expect(primaryWindow.title != additionalWindow.title,"Different quota groups remain distinguishable at the same duration")
        expect(additionalWindow.title.contains("Reviews") && additionalWindow.title.contains(L10n.text("quota.fiveHours")),"A named limit retains both its group and period")
        for invalidPeriod in [Double.nan, Double.infinity, -Double.infinity, -1, 0, 1e30, Double(Int.max)] {
            let window = QuotaWindow(name:"", usedPercent:0, windowSeconds:invalidPeriod, resetAt:nil)
            expect(window.title == L10n.text("quota.unknownPeriod"),"Invalid and out-of-range periods cannot trap during numeric conversion")
        }
        let shortWindow = QuotaWindow(name:"", usedPercent:0, windowSeconds:1800, resetAt:nil)
        expect(shortWindow.title == L10n.text("quota.minutes", "30"),"Short periods are not rounded down to zero hours")
        let secondsWindow = QuotaWindow(name:"", usedPercent:0, windowSeconds:30, resetAt:nil)
        expect(secondsWindow.title == L10n.text("quota.seconds", "30"),"Sub-minute periods retain a meaningful unit")

        let setup=SetupModel()
        let failureData=try json(["ok":false,"code":"setup.migration_failed","message":"synthetic","migration":["copied_files":0,"skipped_files":1,"warnings":["migration.synthetic"],"report_path":"/synthetic/report.json"]])
        let decoder=JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        setup.accept(try decoder.decode(SetupResult.self,from:failureData))
        expect(setup.result?.migration?.reportPath == "/synthetic/report.json","Failed migration retains the diagnostic report")
        expect(setup.resultMessage == nil && setup.error != nil,"Failed migration is never represented as a successful installation")
        for code in ["invalid_name", "destination_exists", "source_invalid", "source_untrusted", "paths_conflict"] {
            setup.accept(try decoder.decode(SetupResult.self, from: json(["ok":false,"code":"setup.\(code)","message":"Do not expose arbitrary subprocess text"])))
            expect(setup.error == L10n.text("service.setup.\(code)"),"Recoverable setup failures preserve their specific localized guidance")
            expect(setup.resultMessage == nil,"A setup validation failure never becomes a success message")
        }

        AccountURLProtocol.install { _ in try json(fixture(pending:true)) }
        let preflight = makeModel(); defer { preflight.stop() }
        await preflight.load(refreshNewAccounts:false)
        expect(preflight.snapshot?.connection != nil && AccountURLProtocol.captured().map { $0.url?.path } == ["/_bridge/accounts"],"Startup can publish pending OAuth through a read-only preflight before awaiting service preparation")

        var activeBuild = "5", activeProtocol = 1, draining = false
        var readinessStatus = "pending", preparationActions: [String] = []
        AccountURLProtocol.install { request in
            if request.url!.path == "/healthz" {
                return try json(["backend":"codex-pool","draining":draining,"service":["build":activeBuild,"protocol":activeProtocol]])
            }
            return try json(fixture(connected:false))
        }
        let lifecycle = makeModel(expectedServiceBuild:"6", setupExecutor: { options in
            preparationActions.append(options["action"] as! String)
            return try decoder.decode(SetupResult.self, from: json(["ok":true,"code":readinessStatus == "ready" ? "setup.service_ready" : "setup.service_update_pending", "message":"synthetic",
                "service":["status":readinessStatus,"expected_build":"6","active_build":activeBuild,"protocol":1]]))
        }); defer { lifecycle.stop() }
        await lifecycle.checkServiceReadiness()
        expect(preparationActions == ["service"],"A healthy backend with an older build initiates service preparation")
        expect(lifecycle.maintenancePending && !lifecycle.applying && !lifecycle.preparingService,"Waiting for an update never keeps account actions disabled")
        expect(lifecycle.maintenanceMessage == L10n.text("service.maintenancePending"),"Pending service preparation has an explicit banner")
        lifecycle.snapshot = try snapshot(fixture(pending:true,connected:false))
        lifecycle.cancelConnection(); await settle(lifecycle)
        expect(AccountURLProtocol.captured().contains { $0.url?.path == "/_bridge/connect/cancel" },"An open OAuth session can be cancelled while the service update is pending")
        expect(lifecycle.snapshot?.connection == nil && lifecycle.maintenancePending,"OAuth cancellation completes without falsely completing service maintenance")
        await lifecycle.checkServiceReadiness()
        expect(preparationActions == ["service","service-status"],"Pending progress is checked through the read-only setup status action")
        readinessStatus = "ready"; await lifecycle.checkServiceReadiness()
        expect(lifecycle.maintenancePending,"A helper readiness claim alone cannot activate an old backend")
        activeBuild = "6"; let actionsBeforeReady = preparationActions.count; await lifecycle.checkServiceReadiness()
        expect(!lifecycle.maintenancePending && lifecycle.maintenanceMessage == nil,"Matching build and protocol plus an undrained health response completes maintenance")
        expect(preparationActions.count == actionsBeforeReady,"A verified current service does not trigger redundant preparation")
        activeProtocol = 2; await lifecycle.checkServiceReadiness()
        expect(lifecycle.maintenancePending,"The expected build with an unsupported protocol is not accepted")
        activeProtocol = 1; draining = true; await lifecycle.checkServiceReadiness()
        expect(lifecycle.maintenancePending,"A service still draining is not reported ready")
        draining = false; await lifecycle.checkServiceReadiness()
        expect(!lifecycle.maintenancePending,"Completion of draining is verified before clearing maintenance")

        var legacyActions: [String] = []
        AccountURLProtocol.install { request in
            if request.url!.path == "/healthz" { return try json(["backend":"codex-pool"]) }
            return try json(fixture())
        }
        let legacy = makeModel(expectedServiceBuild:"6", setupExecutor: { options in
            legacyActions.append(options["action"] as! String)
            return try decoder.decode(SetupResult.self, from: json(["ok":false,"code":"setup.service_legacy_pending","message":"synthetic","service":["status":"legacy"]]))
        }); defer { legacy.stop() }
        await legacy.checkServiceReadiness(); await legacy.load()
        expect(legacy.maintenancePending && legacy.maintenanceNeedsAttention && legacy.maintenanceMessage == L10n.text("service.maintenanceLegacy"),"A legacy backend is identified and exposes recovery without claiming that the new service is active")
        expect(legacy.snapshot != nil && !legacy.applying,"Legacy maintenance leaves readable account data and account actions available")
        await legacy.checkServiceReadiness()
        expect(legacyActions == ["service","service-status"],"A legacy connection is observed without repeatedly attempting preparation")

        let failClosed = makeModel(expectedServiceBuild:"6"); defer { failClosed.stop() }
        await failClosed.checkServiceReadiness()
        expect(failClosed.maintenancePending && failClosed.maintenanceMessage == L10n.text("error.localService"),"Staging never executes the real setup subprocess without an explicitly injected executor")

        var setupContinuation: CheckedContinuation<SetupResult, Error>?
        let preparing = makeModel(expectedServiceBuild:"6", setupExecutor: { _ in
            try await withCheckedThrowingContinuation { setupContinuation = $0 }
        }); defer { preparing.stop() }
        preparing.snapshot = try snapshot(fixture(pending:true,connected:false))
        AccountURLProtocol.install { request in
            if request.url!.path == "/healthz" { return try json(["backend":"codex-pool","draining":false,"service":["build":"5","protocol":1]]) }
            return try json(fixture(connected:false))
        }
        let preparingTask = Task { await preparing.checkServiceReadiness() }
        for _ in 0..<1000 {
            if setupContinuation != nil { break }
            try? await Task.sleep(for:.milliseconds(2))
        }
        expect(setupContinuation != nil && preparing.preparingService && !preparing.applying,"Even an unfinished preparation subprocess does not occupy the account action gate")
        preparing.cancelConnection(); await settle(preparing)
        expect(preparing.snapshot?.connection == nil,"OAuth can be cancelled while preparation is still awaiting its subprocess result")
        setupContinuation?.resume(returning: try decoder.decode(SetupResult.self, from: json(["ok":true,"code":"setup.service_update_pending","message":"synthetic","service":["status":"pending"]])))
        await preparingTask.value
        expect(preparing.maintenancePending && !preparing.preparingService,"Finishing preparation returns to nonblocking readiness polling")

        let previewSetup = SetupModel(staging:true)
        previewSetup.create(); await settleSetup(previewSetup)
        expect(previewSetup.error == L10n.text("setup.previewUnavailable") && previewSetup.result == nil && !previewSetup.busy,"A preview rejects real installation creation through its safe executor before launching setup")
        var capturedSetupOptions: [[String:Any]] = [], createContinuation: CheckedContinuation<SetupResult,Error>?
        var rejectSetup = false
        let simulatedSetup = SetupModel(staging:true,setupExecutor: { options in
            capturedSetupOptions.append(options)
            if rejectSetup {
                return try decoder.decode(SetupResult.self,from:json(["ok":false,"code":"setup.invalid_name","message":"Synthetic validation failure"]))
            }
            return try await withCheckedThrowingContinuation { createContinuation = $0 }
        })
        simulatedSetup.name = "Preview Workspace"; simulatedSetup.source = "/synthetic/Claude.app"
        simulatedSetup.migrateData = false; simulatedSetup.sourceDataRoot = "/synthetic/source"; simulatedSetup.sourceCodeRoot = "   "
        simulatedSetup.create()
        for _ in 0..<1000 {
            if createContinuation != nil { break }
            try? await Task.sleep(for:.milliseconds(2))
        }
        expect(createContinuation != nil && simulatedSetup.busy,"Synthetic installation exposes its pending state until the executor returns")
        simulatedSetup.create()
        expect(capturedSetupOptions.count == 1,"A second create action does not launch a duplicate installation")
        expect(capturedSetupOptions[0]["migrate_data"] as? Bool == false && capturedSetupOptions[0]["source_code_root"] == nil,"Disabled migration and a blank optional Code root preserve the requested setup contract")
        createContinuation?.resume(returning: try decoder.decode(SetupResult.self,from:json(["ok":true,"code":"setup.isolated_created","message":"Synthetic success","path":"/synthetic/Preview Workspace.app"])))
        await settleSetup(simulatedSetup)
        expect(simulatedSetup.result?.ok == true && simulatedSetup.error == nil && simulatedSetup.resultMessage != nil,"Confirmed synthetic installation leaves a success result with no stale error")
        rejectSetup = true; simulatedSetup.name = "bad/name"; simulatedSetup.migrateData = true; simulatedSetup.sourceCodeRoot = "/synthetic/code"
        simulatedSetup.create()
        expect(simulatedSetup.result == nil,"A new setup attempt clears the previous successful installation before awaiting its outcome")
        await settleSetup(simulatedSetup)
        expect(capturedSetupOptions.count == 2 && capturedSetupOptions[1]["source_code_root"] as? String == "/synthetic/code","An explicitly selected Code root reaches the injected setup executor")
        expect(simulatedSetup.error == L10n.text("service.setup.invalid_name") && simulatedSetup.resultMessage == nil,"A subsequent validation failure cannot retain the previous success message")
        try await accountBehaviorMatrix()
        print("Native account state tests: \(assertions) assertions passed; all network requests intercepted")
    }
}
