import Foundation

struct QuotaWindow: Decodable, Hashable {
    let name: String
    let usedPercent: Double
    let windowSeconds: Double
    let resetAt: Double?
    var title: String {
        if windowSeconds == 604800 { return "Semana" }
        if windowSeconds == 18000 { return "5 horas" }
        return "\(Int(windowSeconds / 3600)) horas"
    }
    var remaining: Double { max(0, min(100, 100 - usedPercent)) }
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
    var id: String { email }
    var status: String {
        switch reason {
        case "available": return "Disponível"
        case "exhausted": return "Cota esgotada"
        case "cooldown": return "Aguardando liberação"
        case "unchecked": return "Ainda não consultada"
        case "disabled": return "Desativada"
        case "disconnected": return "Desconectada"
        case "auth_error": return "Autorização precisa de revisão"
        default: return "Consulta indisponível"
        }
    }
}

struct AccountUse: Decodable { let email: String; let at: String }
struct PendingConnection: Decodable { let email: String; let startedAt: String; let error: String? }
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
    var nextAccount: String? {
        mode == "fixed" ? fixedEmail : accounts.first(where: \.eligible)?.email
    }
}
struct LoginResponse: Decodable { let authUrl: String; let email: String }
struct ErrorResponse: Decodable {
    struct Detail: Decodable { let message: String }
    let error: Detail
}
struct BridgeFailure: LocalizedError { let message: String; var errorDescription: String? { message } }
