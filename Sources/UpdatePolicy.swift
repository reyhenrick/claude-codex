import Foundation

struct UpdateReadiness: Decodable, Equatable {
    let activeRequests: Int
    let resetRequests: Int
    let pendingOAuth: Int
    let pendingActions: Int
    let draining: Bool

    enum CodingKeys: String, CodingKey {
        case activeRequests = "active_requests"
        case resetRequests = "reset_requests"
        case pendingOAuth = "pending_oauth"
        case pendingActions = "pending_actions"
        case draining
    }

    var canInstall: Bool {
        draining && activeRequests == 0 && resetRequests == 0 && pendingOAuth == 0 && pendingActions == 0
    }
}

@MainActor
final class UpdateInstallGate {
    private var continuation: (() -> Void)?
    var isWaiting: Bool { continuation != nil }

    func enqueue(_ continuation: @escaping () -> Void) { self.continuation = continuation }
    func cancel() { continuation = nil }

    @discardableResult
    func advance(prepared: Bool) -> Bool {
        guard prepared, let next = continuation else { return false }
        continuation = nil
        next()
        return true
    }
}

@MainActor
final class UpdateRecoveryCoordinator {
    private var task: Task<Void, Never>?
    var isRunning: Bool { task != nil }

    func start(after pending: Task<Void, Never>?,
               operation: @escaping () async throws -> Void,
               onFailure: @escaping (Error) -> Void,
               reconcile: @escaping () -> Void) {
        guard task == nil else { return }
        task = Task { [weak self] in
            await pending?.value
            guard let self else { return }
            do {
                try await operation()
                task = nil
                reconcile()
            } catch {
                task = nil
                onFailure(error)
            }
        }
    }
}

@MainActor
final class UpdateServicePreparation {
    struct Operations {
        var localReady: () -> Bool
        var validateOwnership: () async throws -> Void
        var markRecovery: (Bool) -> Void
        var drain: () async throws -> UpdateReadiness
        var poll: () async throws -> UpdateReadiness
        var stop: () async throws -> Void
        var recover: () async throws -> Void
        var wait: () async throws -> Void
    }

    private let operations: Operations
    private(set) var prepared = false
    private(set) var recoveryRequired = false

    init(operations: Operations) { self.operations = operations }

    func prepare() async throws {
        guard !prepared else { return }
        while !operations.localReady() {
            try Task.checkCancellation()
            try await operations.wait()
        }
        try Task.checkCancellation()
        try await operations.validateOwnership()
        try Task.checkCancellation()
        recoveryRequired = true
        operations.markRecovery(true)
        var readiness = try await operations.drain()
        while true {
            try Task.checkCancellation()
            if readiness.canInstall && operations.localReady() {
                try await operations.validateOwnership()
                try Task.checkCancellation()
                readiness = try await operations.poll()
                try Task.checkCancellation()
                if readiness.canInstall && operations.localReady() { break }
            }
            try await operations.wait()
            readiness = try await operations.poll()
        }
        try Task.checkCancellation()
        try await operations.stop()
        try Task.checkCancellation()
        prepared = true
    }

    func recover(force: Bool = false) async throws {
        guard force || recoveryRequired else { return }
        try await operations.recover()
        prepared = false
        recoveryRequired = false
        operations.markRecovery(false)
    }
}
