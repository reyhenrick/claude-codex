import Foundation

struct QuotaWindow: Decodable, Hashable {
    let name: String
    let usedPercent: Double
    let windowSeconds: Double
    let resetAt: Double?
    var title: String {
        let group: String
        switch name.trimmingCharacters(in: .whitespacesAndNewlines) {
        case "": return periodTitle
        case "Uso do Codex": group = L10n.text("quota.codex")
        case "Limite adicional": group = L10n.text("quota.additional")
        default: group = name
        }
        return L10n.text("quota.namedWindow", group, periodTitle)
    }
    private var periodTitle: String {
        if windowSeconds == 604800 { return L10n.text("quota.week") }
        if windowSeconds == 18000 { return L10n.text("quota.fiveHours") }
        guard windowSeconds.isFinite, windowSeconds > 0,
              let seconds = Int(exactly: windowSeconds.rounded(.up)) else { return L10n.text("quota.unknownPeriod") }
        if seconds < 60 { return L10n.text("quota.seconds", String(seconds)) }
        if seconds < 3600 { return L10n.text("quota.minutes", String(seconds / 60)) }
        return L10n.text("quota.hours", String(seconds / 3600))
    }
    var remaining: Double { max(0, min(100, 100 - usedPercent)) }
}

struct AccountCredits: Decodable, Hashable {
    let known: Bool
    let hasCredits: Bool?
    let unlimited: Bool?
    let balance: String?
    let eligible: Bool
    var label: String {
        guard known else { return L10n.text("credits.unknown") }
        if unlimited == true { return L10n.text("credits.unlimited") }
        if let balance {
            let number = NSDecimalNumber(string: balance, locale: Locale(identifier: "en_US_POSIX"))
            let formatter = NumberFormatter(); formatter.locale = L10n.locale; formatter.numberStyle = .decimal
            formatter.minimumFractionDigits = 0; formatter.maximumFractionDigits = 12
            let displayed = number == .notANumber ? balance : formatter.string(from: number) ?? balance
            return L10n.text("credits.balance", displayed)
        }
        if hasCredits == false { return L10n.text("credits.empty") }
        return L10n.text("credits.unreported")
    }
}

struct ResetOperation: Decodable, Hashable {
    let status: String
    let result: String?
    let source: String
    let updatedAt: String
    let message: String
    let verified: Bool
    var title: String {
        switch status {
        case "pending": return L10n.text("reset.pendingTitle")
        case "uncertain": return L10n.text("reset.uncertainTitle")
        case "succeeded": return L10n.text(verified ? "reset.confirmedTitle" : "reset.unverifiedTitle")
        case "not_applied": return L10n.text("reset.notAppliedTitle")
        default: return L10n.text("reset.statusTitle")
        }
    }
    var displayMessage: String {
        if status == "pending" { return L10n.text("reset.pendingMessage") }
        if status == "uncertain" { return L10n.text("reset.uncertainMessage") }
        if status == "succeeded", !verified { return L10n.text("reset.unverifiedMessage") }
        switch result {
        case "reset": return L10n.text("reset.appliedMessage")
        case "already_redeemed": return L10n.text("reset.redeemedMessage")
        case "no_credit": return L10n.text("reset.noCreditMessage")
        case "nothing_to_reset": return L10n.text("reset.nothingMessage")
        default: return L10n.text("reset.notAppliedMessage")
        }
    }
    var needsAttention: Bool { status == "uncertain" || status == "not_applied" || (status == "succeeded" && !verified) }
}

struct AccountResets: Decodable, Hashable {
    let known: Bool
    let availableCount: Int?
    let applicableCount: Int?
    let canApply: Bool
    let reason: String
    let autoEnabled: Bool
    let thresholdPercent: Int
    let operation: ResetOperation?
    var label: String {
        guard known else { return L10n.text("resets.unknown") }
        guard let availableCount else { return L10n.text("resets.unreported") }
        let available = L10n.text(availableCount == 1 ? "resets.availableOne" : "resets.availableMany", String(availableCount))
        guard let applicableCount, applicableCount != availableCount else { return available }
        let applicable = L10n.text(applicableCount == 1 ? "resets.applicableOne" : "resets.applicableMany", String(applicableCount))
        return "\(available) · \(applicable)"
    }
    var availability: String {
        switch reason {
        case "available": return L10n.text("reset.available")
        case "not_eligible": return L10n.text("reset.notEligible")
        case "retry": return L10n.text("reset.retryHelp")
        case "no_resets": return L10n.text("reset.noneAvailable")
        case "pending": return L10n.text("reset.pendingMessage")
        case "identity_changed": return L10n.text("reset.identityChanged")
        default: return L10n.text("reset.unknownEligibility")
        }
    }
}

struct Account: Decodable, Identifiable, Hashable {
    let email: String
    let plan: String?
    let connected: Bool
    let eligible: Bool
    let reason: String
    let windows: [QuotaWindow]
    let checkedAt: String?
    let activeRequests: Int?
    let subscriptionStatus: String
    let consumptionSource: String?
    let credits: AccountCredits
    let resets: AccountResets
    var id: String { email }
    var status: String {
        switch reason {
        case "available": return L10n.text(consumptionSource == "credits" ? "account.creditsAvailable" : "account.available")
        case "credits": return L10n.text("account.creditsAvailable")
        case "exhausted": return L10n.text("account.exhausted")
        case "cooldown": return L10n.text("account.cooldown")
        case "unchecked": return L10n.text("account.unchecked")
        case "disabled": return L10n.text("account.disabled")
        case "disconnected": return L10n.text("account.disconnected")
        case "auth_error": return L10n.text("account.authError")
        default: return L10n.text("account.queryUnavailable")
        }
    }
}

struct AccountUse: Decodable { let email: String; let at: String }
struct PendingConnection: Decodable {
    let email: String
    let startedAt: String
    let error: String?
    let errorCode: String?
    let url: String?
    var hasError: Bool { error != nil || errorCode != nil }
    var canRetry: Bool { hasError && errorCode != "oauth.reconnect_busy" }
    var title: String {
        canRetry ? L10n.text("connection.retryTitle") : L10n.text("connection.connecting", email)
    }
    var description: String {
        guard hasError else { return L10n.text("connection.description") }
        return Self.localizedError(code: errorCode) ?? L10n.text("connection.retryDescription")
    }
    static func localizedError(code: String?) -> String? {
        switch code {
        case "oauth.account_mismatch": return L10n.text("connection.error.account_mismatch")
        case "oauth.expired": return L10n.text("connection.error.expired")
        case "oauth.import_failed": return L10n.text("connection.error.import_failed")
        case "oauth.reconnect_busy": return L10n.text("connection.error.reconnect_busy")
        case "oauth.session_unavailable": return L10n.text("connection.error.session_unavailable")
        default: return nil
        }
    }
    static func authorizationURL(_ value: String?) -> URL? {
        guard let value, let components = URLComponents(string: value),
              components.scheme?.lowercased() == "https", components.host?.lowercased() == "auth.openai.com",
              components.path == "/oauth/authorize", components.user == nil, components.password == nil,
              components.port == nil || components.port == 443, components.fragment == nil else { return nil }
        return components.url
    }
}
struct PoolSnapshot: Decodable {
    let mode: String
    let fixedEmail: String?
    let priorityOrder: [String]
    let revision: Int
    let lastUsed: AccountUse?
    let lastConnection: AccountUse?
    let connection: PendingConnection?
    let accounts: [Account]
    let activeRequests: Int?
    let allowExtraCredits: Bool
    let autoResetEmails: [String]
    let autoResetThresholdPercent: Int
    let creditPhase: Bool
    let creditBlockReason: String
    let nextEligibleAccount: String?
}

struct LoginResponse: Decodable { let authUrl: String; let email: String }
struct ErrorResponse: Decodable {
    struct Detail: Decodable { let code: String?; let message: String }
    let error: Detail
}
struct BridgeFailure: LocalizedError { let message: String; var errorDescription: String? { message } }
