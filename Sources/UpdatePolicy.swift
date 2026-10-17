import Foundation
import Darwin

struct UpdateProcessIdentity: Codable, Equatable {
    let pid: Int32
    let startSeconds: UInt64
    let startMicroseconds: UInt64

    static func capture(_ pid: Int32) -> UpdateProcessIdentity? {
        guard pid > 1 else { return nil }
        var information = proc_bsdinfo()
        let size = MemoryLayout<proc_bsdinfo>.stride
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &information, Int32(size)) == size else { return nil }
        return .init(pid: pid, startSeconds: information.pbi_start_tvsec, startMicroseconds: information.pbi_start_tvusec)
    }

    var isRunning: Bool {
        if let current = Self.capture(pid) { return current == self }
        return kill(pid, 0) == 0 || errno != ESRCH
    }
}

struct UpdateInstallerJob: Codable, Equatable {
    let target: String
    let process: UpdateProcessIdentity
}

struct UpdateRecoveryRecord: Codable, Equatable {
    let version: Int
    let id: UUID
    let userID: UInt32
    let applicationPath: String
    let publicUpdateKey: String
    let owner: UpdateProcessIdentity
    let installers: [UpdateInstallerJob]
}

enum UpdateRecoveryFailure: Error { case unsafeRecord, unexpectedJob, unavailableInstaller, commandFailed }

struct UpdateLaunchJob {
    let program: String
    let arguments: [String]
    let pid: Int32?
    let runs: Int?
    var hasFinishedOnce: Bool { pid == nil && (runs ?? 0) > 0 }

    init(output: String) throws {
        let lines = output.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }
        guard let program = lines.first(where: { $0.hasPrefix("program = ") })?.dropFirst(10),
              let beginning = lines.firstIndex(of: "arguments = {"),
              let end = lines[(beginning + 1)...].firstIndex(of: "}") else { throw UpdateRecoveryFailure.unexpectedJob }
        self.program = String(program)
        arguments = Array(lines[(beginning + 1)..<end])
        pid = lines.first(where: { $0.hasPrefix("pid = ") }).flatMap { Int32($0.dropFirst(6)) }
        runs = lines.first(where: { $0.hasPrefix("runs = ") }).flatMap { Int($0.dropFirst(7)) }
    }
}

@MainActor
enum UpdateInstallerActivity {
    static func capture(application: URL, userID: UInt32,
                        captureProcess: (Int32) -> UpdateProcessIdentity? = { UpdateProcessIdentity.capture($0) },
                        query: (String) async throws -> (status: Int32, output: String) = {
                            try await UpdateCommand.run("/bin/launchctl", ["print", $0])
                        }) async throws -> [UpdateInstallerJob] {
        var installers: [UpdateInstallerJob] = []
        for target in UpdateRecoveryStore.installerTargets(userID: userID) {
            let result = try await query(target)
            if result.status == 113 { continue }
            guard result.status == 0 else { throw UpdateRecoveryFailure.commandFailed }
            let job = try UpdateLaunchJob(output: result.output)
            if job.hasFinishedOnce { continue }
            if target.hasSuffix("-sparkle-updater") {
                let expected = application.appendingPathComponent("Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate").resolvingSymlinksInPath()
                guard URL(fileURLWithPath: job.program).resolvingSymlinksInPath() == expected,
                      job.arguments.count >= 2, job.arguments[1] == UpdateRecoveryStore.bundleIdentifier else {
                    throw UpdateRecoveryFailure.unexpectedJob
                }
            } else {
                guard job.arguments.count == 3, job.arguments[1] == application.path,
                      ["0", "1"].contains(job.arguments[2]),
                      URL(fileURLWithPath: job.program).lastPathComponent == "Updater" else {
                    throw UpdateRecoveryFailure.unexpectedJob
                }
            }
            guard let pid = job.pid, let identity = captureProcess(pid) else { throw UpdateRecoveryFailure.unavailableInstaller }
            installers.append(.init(target: target, process: identity))
        }
        guard installers.contains(where: { $0.target.hasSuffix("-sparkle-updater") }) else { throw UpdateRecoveryFailure.unavailableInstaller }
        return installers
    }

    static func isRunning(record: UpdateRecoveryRecord,
                          processIsRunning: (UpdateProcessIdentity) -> Bool = { $0.isRunning },
                          query: (String) async throws -> (status: Int32, output: String) = {
                              try await UpdateCommand.run("/bin/launchctl", ["print", $0])
                          }) async throws -> Bool {
        if record.installers.contains(where: { processIsRunning($0.process) }) { return true }
        for target in UpdateRecoveryStore.installerTargets(userID: record.userID) {
            let result = try await query(target)
            if result.status == 113 { continue }
            guard result.status == 0 else { throw UpdateRecoveryFailure.commandFailed }
            let job = try UpdateLaunchJob(output: result.output)
            if job.hasFinishedOnce { continue }
            if target.hasSuffix("-sparkle-updater") {
                guard job.arguments.count >= 2, job.arguments[1] == UpdateRecoveryStore.bundleIdentifier else {
                    throw UpdateRecoveryFailure.unexpectedJob
                }
            } else {
                guard job.arguments.count == 3, job.arguments[1] == record.applicationPath else {
                    throw UpdateRecoveryFailure.unexpectedJob
                }
            }
            return true
        }
        return false
    }

    static func mayRecover(current: UpdateProcessIdentity?, owner: UpdateProcessIdentity,
                           ownerIsRunning: Bool, installersAreRunning: Bool) -> Bool {
        current == owner || (!ownerIsRunning && !installersAreRunning)
    }
}

enum UpdateCommand {
    static func run(_ executable: String, _ arguments: [String]) async throws -> (status: Int32, output: String) {
        try Task.checkCancellation()
        return try await withCheckedThrowingContinuation { continuation in
            let process = Process(), output = Pipe()
            let expiration = DispatchWorkItem { [weak process] in
                if process?.isRunning == true { process?.terminate() }
            }
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { process in
                expiration.cancel()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                continuation.resume(returning: (process.terminationStatus, String(decoding: data, as: UTF8.self)))
            }
            do {
                try process.run()
                DispatchQueue.global().asyncAfter(deadline: .now() + 10, execute: expiration)
            } catch {
                expiration.cancel()
                process.terminationHandler = nil
                continuation.resume(throwing: error)
            }
        }
    }
}

struct UpdateRecoveryStore {
    static let bundleIdentifier = "com.henrick.codex-accounts"
    static let jobLabel = "com.henrick.codex-accounts.update-recovery"
    let home: URL
    var directory: URL { home.appendingPathComponent("Library/Application Support/Claude Codex Bridge/update-recovery") }
    var recordURL: URL { directory.appendingPathComponent("record.json") }
    var helperURL: URL { directory.appendingPathComponent("UpdateRecovery") }
    var statusURL: URL { directory.appendingPathComponent("status.json") }
    var jobURL: URL { home.appendingPathComponent("Library/LaunchAgents/\(Self.jobLabel).plist") }
    var jobTarget: String { "gui/\(getuid())/\(Self.jobLabel)" }

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser) { self.home = home }

    static func installerTargets(userID: UInt32) -> [String] {
        let identifier = bundleIdentifier
        return ["gui/\(userID)/\(identifier)-sparkle-updater", "user/\(userID)/\(identifier)-sparkle-updater",
                "system/\(identifier)-sparkle-updater", "gui/\(userID)/\(identifier)-sparkle-progress",
                "user/\(userID)/\(identifier)-sparkle-progress"]
    }

    func validate(_ record: UpdateRecoveryRecord) throws {
        let application = URL(fileURLWithPath: record.applicationPath).standardizedFileURL
        let parent = application.deletingLastPathComponent().path
        guard record.version == 1, record.userID == getuid(), record.owner.pid > 1, record.owner.startSeconds > 0,
              application.path == record.applicationPath, application.pathExtension == "app",
              ["/Applications", home.appendingPathComponent("Applications").path].contains(parent),
              let key = Data(base64Encoded: record.publicUpdateKey), key.count == 32,
              key.base64EncodedString() == record.publicUpdateKey,
              !record.installers.isEmpty, record.installers.contains(where: { $0.target.hasSuffix("-sparkle-updater") }),
              Set(record.installers.map(\.target)).count == record.installers.count,
              record.installers.allSatisfy({ Self.installerTargets(userID: record.userID).contains($0.target) && $0.process.pid > 1 && $0.process.startSeconds > 0 }) else {
            throw UpdateRecoveryFailure.unsafeRecord
        }
    }

    func validateDirectory() throws {
        var information = stat()
        guard lstat(directory.path, &information) == 0,
              information.st_mode & S_IFMT == S_IFDIR, information.st_uid == getuid(),
              information.st_mode & 0o077 == 0,
              directory.resolvingSymlinksInPath().path == directory.path else { throw UpdateRecoveryFailure.unsafeRecord }
    }

    func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try validateDirectory()
    }

    func load() throws -> UpdateRecoveryRecord? {
        let descriptor = open(recordURL.path, O_RDONLY | O_NOFOLLOW)
        if descriptor < 0 {
            if errno == ENOENT { return nil }
            throw UpdateRecoveryFailure.unsafeRecord
        }
        defer { close(descriptor) }
        try validateDirectory()
        var information = stat()
        guard fstat(descriptor, &information) == 0, information.st_mode & S_IFMT == S_IFREG,
              information.st_uid == getuid(), information.st_nlink == 1, information.st_mode & 0o077 == 0,
              information.st_size > 0, information.st_size <= 32768 else { throw UpdateRecoveryFailure.unsafeRecord }
        let data = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false).readDataToEndOfFile()
        guard data.count == information.st_size else { throw UpdateRecoveryFailure.unsafeRecord }
        let record = try JSONDecoder().decode(UpdateRecoveryRecord.self, from: data)
        try validate(record)
        return record
    }

    func save(_ record: UpdateRecoveryRecord) throws {
        try validate(record)
        try validateDirectory()
        try writePrivate(JSONEncoder().encode(record), to: recordURL)
    }

    func writePrivate(_ data: Data, to destination: URL) throws {
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).tmp")
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw UpdateRecoveryFailure.unsafeRecord }
        defer { close(descriptor); unlink(temporary.path) }
        try FileHandle(fileDescriptor: descriptor, closeOnDealloc: false).write(contentsOf: data)
        guard fsync(descriptor) == 0, rename(temporary.path, destination.path) == 0 else { throw UpdateRecoveryFailure.unsafeRecord }
    }

    func jobArguments(record: UpdateRecoveryRecord) -> [String] { [helperURL.path, recordURL.path, record.id.uuidString] }

    func validateJobFile(record: UpdateRecoveryRecord) throws {
        var information = stat()
        guard lstat(jobURL.path, &information) == 0, information.st_mode & S_IFMT == S_IFREG,
              information.st_uid == getuid(), information.st_nlink == 1, information.st_mode & 0o077 == 0 else { throw UpdateRecoveryFailure.unsafeRecord }
        let data = try Data(contentsOf: jobURL)
        guard let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              plist["Label"] as? String == Self.jobLabel,
              plist["ProgramArguments"] as? [String] == jobArguments(record: record) else { throw UpdateRecoveryFailure.unexpectedJob }
    }

    func note(_ reason: String) {
        guard (try? validateDirectory()) != nil,
              let data = try? JSONSerialization.data(withJSONObject: ["reason": reason, "checkedAt": Date().timeIntervalSince1970]) else { return }
        try? writePrivate(data, to: statusURL)
    }
}

@MainActor
final class UpdateRecoverySupervisor {
    enum Outcome: Equatable { case completed, retry }
    struct Operations {
        var recordIsCurrent: () throws -> Bool
        var ownerIsRunning: () -> Bool
        var installersAreRunning: () async throws -> Bool
        var applicationIsValid: () async throws -> Bool
        var applicationIsRunning: () -> Bool
        var launchApplication: () async throws -> Void
        var wait: () async throws -> Void
        var note: (String) -> Void
        var clock: () -> TimeInterval
    }
    private let operations: Operations
    init(operations: Operations) { self.operations = operations }

    func run(maximumChecks: Int = 120, duration: TimeInterval = 120) async -> Outcome {
        let deadline = operations.clock() + duration
        for _ in 0..<maximumChecks {
            guard !Task.isCancelled, operations.clock() < deadline else { return .retry }
            do {
                guard try operations.recordIsCurrent() else { return .completed }
                if operations.ownerIsRunning() { operations.note("waiting-for-owner") }
                else if try await operations.installersAreRunning() { operations.note("waiting-for-installer") }
                else if try await !operations.applicationIsValid() { operations.note("waiting-for-valid-application") }
                else if !operations.applicationIsRunning() {
                    guard try operations.recordIsCurrent() else { return .completed }
                    if try await !operations.installersAreRunning() {
                        try await operations.launchApplication()
                        operations.note("application-recovery-requested")
                    }
                } else { operations.note("waiting-for-service-recovery") }
            } catch { operations.note("recovery-will-retry") }
            do { try await operations.wait() } catch { return .retry }
        }
        return .retry
    }
}

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

    func waitUntilFinished() async { await task?.value }

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
final class UpdateStartupCoordinator {
    private var task: Task<Bool, Never>?
    private(set) var isReady = false
    var isRunning: Bool { task != nil }

    func start(recover: @escaping () async throws -> Void,
               onReady: @escaping () -> Void,
               onFailure: @escaping (Error) -> Void) async -> Bool {
        if isReady { return true }
        if let task { return await task.value }
        let pending = Task { [weak self] in
            guard let self else { return false }
            do {
                try await recover()
                isReady = true
                task = nil
                onReady()
                return true
            } catch {
                task = nil
                onFailure(error)
                return false
            }
        }
        task = pending
        return await pending.value
    }
}

@MainActor
final class UpdateServicePreparation {
    struct Operations {
        var localReady: () -> Bool
        var validateOwnership: () async throws -> Void
        var markRecovery: (Bool) -> Void
        var armRecovery: () async throws -> Void
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
        try await operations.armRecovery()
        try Task.checkCancellation()
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
