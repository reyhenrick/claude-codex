import Foundation

private enum FixtureFailure: Error { case expected }

@MainActor
private final class Fixture {
    var events: [String] = []
    var snapshots: [UpdateReadiness] = []
    var localReady = true
    var ownershipFailure = false
    var armFailure = false
    var drainFailure = false
    var stopFailure = false
    var recoveryFailure = false
    var recoveryAction: (() async throws -> Void)?
    var cancelWait = false
    var waitAction: (() -> Void)?
    var marker = false
    var ownershipAction: (() -> Void)?
    var lastReadiness: UpdateReadiness?
    var stopObservations: [UpdateReadiness] = []

    func state(active: Int = 0, resets: Int = 0, oauth: Int = 0, actions: Int = 0, draining: Bool = true) -> UpdateReadiness {
        UpdateReadiness(activeRequests: active, resetRequests: resets, pendingOAuth: oauth, pendingActions: actions, draining: draining)
    }

    func nextState() -> UpdateReadiness {
        let value = snapshots.isEmpty ? state() : snapshots.removeFirst()
        lastReadiness = value
        return value
    }

    func coordinator() -> UpdateServicePreparation {
        UpdateServicePreparation(operations: .init(
            localReady: { self.localReady },
            validateOwnership: {
                self.events.append("validate")
                if self.ownershipFailure { throw FixtureFailure.expected }
                self.ownershipAction?()
            },
            markRecovery: {
                self.marker = $0
                self.events.append($0 ? "mark" : "clear")
            },
            armRecovery: {
                self.events.append("arm")
                if self.armFailure { throw FixtureFailure.expected }
            },
            drain: {
                self.events.append("drain")
                if self.drainFailure { throw FixtureFailure.expected }
                return self.nextState()
            },
            poll: { self.events.append("poll"); return self.nextState() },
            stop: {
                self.events.append("stop")
                if let lastReadiness = self.lastReadiness { self.stopObservations.append(lastReadiness) }
                if self.stopFailure { throw FixtureFailure.expected }
            },
            recover: {
                self.events.append("recover")
                if self.recoveryFailure { throw FixtureFailure.expected }
                try await self.recoveryAction?()
            },
            wait: {
                self.events.append("wait")
                if self.cancelWait { throw CancellationError() }
                self.waitAction?()
            }
        ))
    }
}

@main
@MainActor
struct UpdatePolicyTests {
    private static var assertions = 0

    static func expect(_ value: @autoclosure () -> Bool, _ message: String) {
        assertions += 1
        guard value() else { fatalError(message) }
    }

    static func main() async throws {
        let valid = Data(#"{"active_requests":0,"reset_requests":0,"pending_oauth":0,"pending_actions":0,"draining":true}"#.utf8)
        let decoded = try JSONDecoder().decode(UpdateReadiness.self, from: valid)
        expect(decoded.canInstall, "Idle draining service must be installable")
        for json in [#"{"ready":true}"#, #"{"active_requests":false,"reset_requests":0,"pending_oauth":0,"pending_actions":0,"draining":true}"#, #"{"active_requests":0,"reset_requests":0,"pending_oauth":0,"pending_actions":0}"#, #"{"active_requests":0,"reset_requests":0,"pending_oauth":0,"draining":true}"#] {
            expect((try? JSONDecoder().decode(UpdateReadiness.self, from: Data(json.utf8))) == nil, "Incomplete or malformed readiness must fail closed")
        }
        let idle = Fixture()
        for state in [idle.state(active: 1), idle.state(resets: 1), idle.state(oauth: 1), idle.state(actions: 1), idle.state(draining: false), idle.state(active: -1), idle.state(actions: -1)] {
            expect(!state.canInstall, "Non-idle or invalid readiness cannot install")
        }
        let restartedService = Fixture()
        restartedService.ownershipAction = {
            if restartedService.events.contains("drain") {
                restartedService.snapshots = [restartedService.state(active: 1, draining: false), restartedService.state()]
                restartedService.ownershipAction = nil
            }
        }
        try await restartedService.coordinator().prepare()
        expect(restartedService.events.contains("wait"), "Restarted service losing its drain cannot use the previous idle snapshot")
        expect(restartedService.stopObservations.count == 1 && restartedService.stopObservations.allSatisfy(\.canInstall), "Restarted service must regain idle drain before stop")


        let direct = idle.coordinator()
        try await direct.prepare()
        expect(idle.events == ["validate", "mark", "arm", "drain", "validate", "poll", "stop"], "Readiness must be refreshed after ownership verification")
        expect(direct.prepared && direct.recoveryRequired && idle.marker, "Prepared service must retain recovery intent")
        try await direct.prepare()
        expect(idle.events.filter { $0 == "stop" }.count == 1, "Preparing twice cannot stop twice")
        try await direct.recover()
        expect(!direct.prepared && !direct.recoveryRequired && !idle.marker, "Recovery must clear prepared state and marker")
        expect(idle.events.suffix(2) == ["recover", "clear"], "Marker is cleared only after recovery")

        let busy = Fixture()
        busy.snapshots = [busy.state(active: 1), busy.state(resets: 1), busy.state(oauth: 1), busy.state(actions: 1), busy.state(draining: false), busy.state()]
        let pending = busy.coordinator()
        try await pending.prepare()
        expect(busy.events.filter { $0 == "poll" }.count == 6, "Every active operation and missing drain must postpone stop")
        expect(busy.events.last == "stop", "Stop occurs only after all busy states")

        let local = Fixture()
        local.localReady = false
        local.waitAction = { local.localReady = true }
        let localPreparation = local.coordinator()
        try await localPreparation.prepare()
        expect(local.events.first == "wait", "Local setup must complete before draining")

        let lateLocal = Fixture()
        lateLocal.ownershipAction = {
            if lateLocal.events.contains("drain") { lateLocal.localReady = false; lateLocal.ownershipAction = nil }
        }
        lateLocal.waitAction = { lateLocal.localReady = true }
        try await lateLocal.coordinator().prepare()
        expect(lateLocal.events == ["validate", "mark", "arm", "drain", "validate", "poll", "wait", "poll", "validate", "poll", "stop"], "Local work beginning during ownership verification must postpone stop")


        let ownership = Fixture()
        ownership.ownershipFailure = true
        do { try await ownership.coordinator().prepare(); fatalError("Ownership failure accepted") } catch FixtureFailure.expected {}
        expect(ownership.events == ["validate"] && !ownership.marker, "Unowned services cannot be drained or stopped")

        let failedDrain = Fixture()
        failedDrain.drainFailure = true
        let drainPreparation = failedDrain.coordinator()
        do { try await drainPreparation.prepare(); fatalError("Drain failure accepted") } catch FixtureFailure.expected {}
        expect(failedDrain.marker && drainPreparation.recoveryRequired && !drainPreparation.prepared, "Uncertain drain must retain recovery intent")
        expect(!failedDrain.events.contains("stop"), "Drain failure cannot stop service")
        try await drainPreparation.recover()
        expect(!failedDrain.marker, "Aborted drain resumes and clears marker")

        let failedStop = Fixture()
        failedStop.stopFailure = true
        let stopPreparation = failedStop.coordinator()
        do { try await stopPreparation.prepare(); fatalError("Stop failure accepted") } catch FixtureFailure.expected {}
        expect(!stopPreparation.prepared && failedStop.marker, "Failed service shutdown cannot approve installation")
        failedStop.recoveryFailure = true
        do { try await stopPreparation.recover(); fatalError("Recovery failure accepted") } catch FixtureFailure.expected {}
        expect(failedStop.marker && stopPreparation.recoveryRequired, "Recovery failure must preserve durable retry intent")
        failedStop.recoveryFailure = false
        try await stopPreparation.recover()
        expect(!failedStop.marker, "Retry can restore service after recovery failure")

        let cancelled = Fixture()
        cancelled.snapshots = [cancelled.state(active: 1)]
        cancelled.cancelWait = true
        let cancelledPreparation = cancelled.coordinator()
        do { try await cancelledPreparation.prepare(); fatalError("Cancellation ignored") } catch is CancellationError {}
        expect(!cancelled.events.contains("stop") && !cancelledPreparation.prepared, "Cancellation cannot stop an active service")
        try await cancelledPreparation.recover()
        expect(!cancelled.marker, "Cancellation recovers the draining service")

        let relaunched = Fixture()
        let relaunchedPreparation = relaunched.coordinator()
        try await relaunchedPreparation.recover(force: true)
        expect(relaunched.events == ["recover", "clear"], "Durable marker restores service after app relaunch")

        let gate = UpdateInstallGate()
        var calls: [Int] = []
        gate.enqueue { calls.append(1); gate.enqueue { calls.append(2) } }
        expect(!gate.advance(prepared: false) && calls.isEmpty, "Unprepared continuation cannot run")
        expect(gate.advance(prepared: true) && calls == [1] && gate.isWaiting, "Reentrant stage must keep its own continuation")
        expect(gate.advance(prepared: true) && calls == [1, 2] && !gate.isWaiting, "Second stage runs exactly once")
        expect(!gate.advance(prepared: true), "Finished continuation cannot repeat")
        gate.enqueue { calls.append(3) }
        gate.cancel()
        expect(!gate.advance(prepared: true) && calls == [1, 2], "Cancelled continuation cannot install")

        let recovery = UpdateRecoveryCoordinator()
        let automaticGate = UpdateInstallGate()
        var automaticallyInstalls = false
        var resumedInstalls = 0
        var reconciliations = 0
        var releaseRecovery: CheckedContinuation<Void, Never>?
        automaticGate.enqueue { resumedInstalls += 1 }
        recovery.start(after: nil, operation: {
            await withCheckedContinuation { releaseRecovery = $0 }
        }, onFailure: { _ in fatalError("Unexpected recovery failure") }, reconcile: {
            expect(!recovery.isRunning, "Recovery must release its busy state before reconciling installation")
            reconciliations += 1
            if automaticallyInstalls { automaticGate.advance(prepared: true) }
        })
        while releaseRecovery == nil { await Task.yield() }
        automaticallyInstalls = true
        expect(recovery.isRunning && resumedInstalls == 0, "Enabling installation during recovery must keep the pending continuation")
        recovery.start(after: nil, operation: { fatalError("Concurrent recovery started") }, onFailure: { _ in }, reconcile: {})
        releaseRecovery?.resume()
        while recovery.isRunning { await Task.yield() }
        expect(reconciliations == 1 && resumedInstalls == 1 && !automaticGate.isWaiting, "Latest enabled preference must resume a queued installation after successful recovery")

        automaticallyInstalls = false
        automaticGate.enqueue { resumedInstalls += 1 }
        recovery.start(after: nil, operation: {}, onFailure: { _ in fatalError("Unexpected recovery failure") }, reconcile: {
            if automaticallyInstalls { automaticGate.advance(prepared: true) }
        })
        while recovery.isRunning { await Task.yield() }
        expect(resumedInstalls == 1 && automaticGate.isWaiting, "A preference left disabled must retain the queued installation")

        var recoveryFailures = 0
        recovery.start(after: nil, operation: { throw FixtureFailure.expected }, onFailure: { _ in
            recoveryFailures += 1
            expect(!recovery.isRunning, "Failed recovery must release its busy state")
        }, reconcile: { fatalError("Failed recovery reconciled an installation") })
        while recovery.isRunning { await Task.yield() }
        expect(recoveryFailures == 1 && automaticGate.isWaiting, "Failed recovery cannot release the queued update")
        try await startupTests()
        try await supervisorTests()
        try await recordAndInstallerTests()
        print("Update policy tests: \(assertions) assertions passed")
    }

    static func startupTests() async throws {
        let fixture = Fixture()
        var release: CheckedContinuation<Void, Never>?
        fixture.recoveryAction = { await withCheckedContinuation { release = $0 } }
        let preparation = fixture.coordinator()
        let startup = UpdateStartupCoordinator()
        var starts = 0
        let first = Task {
            await startup.start(recover: { try await preparation.recover(force: true) }, onReady: {
                fixture.events.append("start")
                starts += 1
            }, onFailure: { _ in fatalError("Startup recovery failed") })
        }
        while release == nil { await Task.yield() }
        let second = Task {
            await startup.start(recover: { fatalError("Concurrent startup ran recovery twice") }, onReady: {
                fatalError("Concurrent startup initialized twice")
            }, onFailure: { _ in fatalError("Concurrent startup failed") })
        }
        await Task.yield()
        expect(startup.isRunning && !startup.isReady && starts == 0, "Connection preparation must stay behind pending update recovery")
        release?.resume()
        let results = await (first.value, second.value)
        expect(results.0 && results.1 && starts == 1, "Concurrent startup clients must share successful recovery")
        expect(fixture.events == ["recover", "clear", "start"], "Startup cannot begin before recovery and marker clearing")

        let retry = UpdateStartupCoordinator()
        var failures = 0
        let failed = await retry.start(recover: { throw FixtureFailure.expected }, onReady: { fatalError("Failed startup proceeded") }, onFailure: { _ in failures += 1 })
        expect(!failed && !retry.isReady && !retry.isRunning && failures == 1, "Failed startup must remain retryable without allowing preparation")
        let recovered = await retry.start(recover: {}, onReady: { starts += 1 }, onFailure: { _ in fatalError("Startup retry failed") })
        expect(recovered && retry.isReady && starts == 2, "A later startup attempt must recover from an earlier failure")

        let armFailure = Fixture()
        armFailure.armFailure = true
        let guarded = armFailure.coordinator()
        do { try await guarded.prepare(); fatalError("Missing independent recovery was accepted") } catch FixtureFailure.expected {}
        expect(!armFailure.events.contains("drain") && !armFailure.events.contains("stop"), "Independent recovery must be armed before the service is drained")
        expect(armFailure.marker && guarded.recoveryRequired, "Failed recovery arming must retain durable recovery intent")
        try await guarded.recover()
        expect(!armFailure.marker, "Recovery after failed arming can safely clear the marker")
    }

    static func supervisorTests() async throws {
        for installationSucceeded in [true, false] {
            let fixture = Fixture()
            fixture.marker = true
            let preparation = fixture.coordinator()
            let startup = UpdateStartupCoordinator()
            var phase = 0
            var currentRecord = true
            var launches = 0
            var notes: [String] = []
            var runningApplication = false
            let availableVersion = installationSucceeded ? "new" : "restored-original"
            var openedVersion: String?
            let supervisor = UpdateRecoverySupervisor(operations: .init(
                recordIsCurrent: { currentRecord },
                ownerIsRunning: { phase == 0 },
                installersAreRunning: { phase == 1 },
                applicationIsValid: { phase >= 3 },
                applicationIsRunning: { runningApplication },
                launchApplication: {
                    expect(phase >= 3, "Helper cannot open an app before owner exit, installer completion and bundle validation")
                    launches += 1
                    openedVersion = availableVersion
                    let started = await startup.start(recover: {
                        try await preparation.recover(force: true)
                        currentRecord = false
                    }, onReady: { runningApplication = true }, onFailure: { _ in fatalError("Helper-launched startup failed") })
                    expect(started, "Helper-launched application must complete serialized recovery")
                },
                wait: { phase += 1 },
                note: { notes.append($0) },
                clock: { Double(phase) }
            ))
            let result = await supervisor.run(maximumChecks: 10, duration: 10)
            expect(result == .completed && launches == 1 && runningApplication, "Helper must recover a quit without Sparkle relaunch")
            expect(!fixture.marker && !currentRecord && fixture.events == ["recover", "clear"], "Helper recovery must resume service and clear only completed recovery state")
            expect(openedVersion == availableVersion, "A failed installation must recover through the restored original app")
            expect(notes.prefix(3) == ["waiting-for-owner", "waiting-for-installer", "waiting-for-valid-application"], "Helper must retain every installation barrier")
        }

        var clock: TimeInterval = 0
        var launches = 0
        var marker = true
        let waiting = UpdateRecoverySupervisor(operations: .init(
            recordIsCurrent: { marker }, ownerIsRunning: { false }, installersAreRunning: { true },
            applicationIsValid: { fatalError("Active installer was bypassed") }, applicationIsRunning: { false },
            launchApplication: { launches += 1 }, wait: { clock += 1 }, note: { _ in }, clock: { clock }
        ))
        let pending = await waiting.run(maximumChecks: 100, duration: 3)
        expect(pending == .retry && clock == 3 && launches == 0 && marker, "Each helper run must be bounded while preserving recovery for launchd retry")
        marker = false
        let finished = await waiting.run(maximumChecks: 1, duration: 3)
        expect(finished == .completed && launches == 0, "Completed recovery must not reopen the app")

        var attempts = 0
        clock = 0
        let failures = UpdateRecoverySupervisor(operations: .init(
            recordIsCurrent: { true }, ownerIsRunning: { false }, installersAreRunning: { false },
            applicationIsValid: { true }, applicationIsRunning: { false },
            launchApplication: { attempts += 1; throw FixtureFailure.expected },
            wait: { clock += 1 }, note: { _ in }, clock: { clock }
        ))
        let failed = await failures.run(maximumChecks: 3, duration: 10)
        expect(failed == .retry && attempts == 3, "Launch failures must preserve durable retry without hanging a helper run")
    }

    static func recordAndInstallerTests() async throws {
        guard let identity = UpdateProcessIdentity.capture(getpid()) else { fatalError("Cannot inspect test process identity") }
        expect(identity.isRunning, "Current PID birth identity must be recognized")
        let reused = UpdateProcessIdentity(pid: identity.pid, startSeconds: identity.startSeconds + 1, startMicroseconds: identity.startMicroseconds)
        expect(!reused.isRunning, "PID reuse must not be confused with the original update owner")
        let directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("codex-ultra-recovery-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = UpdateRecoveryStore(home: directory)
        try store.prepareDirectory()
        let record = UpdateRecoveryRecord(version: 1, id: UUID(), userID: getuid(),
            applicationPath: directory.appendingPathComponent("Applications/Claude Codex.app").path,
            publicUpdateKey: Data(repeating: 7, count: 32).base64EncodedString(), owner: identity,
            installers: [.init(target: "gui/\(getuid())/com.henrick.codex-accounts-sparkle-updater", process: identity)])
        try store.save(record)
        let loaded = try store.load()
        expect(loaded == record, "Private recovery record must round-trip without losing PID birth identities")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: store.recordURL.path)
        expect((try? store.load()) == nil, "World-readable recovery record must fail closed")
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: store.recordURL.path)
        let hardlink = directory.appendingPathComponent("linked-record")
        try FileManager.default.linkItem(at: store.recordURL, to: hardlink)
        expect((try? store.load()) == nil, "Hard-linked recovery record must fail closed")
        try FileManager.default.removeItem(at: hardlink)
        try FileManager.default.removeItem(at: store.recordURL)
        let external = directory.appendingPathComponent("outside.json")
        try JSONEncoder().encode(record).write(to: external)
        try FileManager.default.createSymbolicLink(at: store.recordURL, withDestinationURL: external)
        expect((try? store.load()) == nil, "Symlinked recovery record must fail closed")
        try FileManager.default.removeItem(at: store.recordURL)
        try store.save(record)

        expect(UpdateInstallerActivity.mayRecover(current: identity, owner: identity, ownerIsRunning: true, installersAreRunning: true), "The same live owner must be able to resume after cancelling its deferred update")
        expect(!UpdateInstallerActivity.mayRecover(current: reused, owner: identity, ownerIsRunning: true, installersAreRunning: false), "Another app process cannot bypass the active original owner")
        expect(!UpdateInstallerActivity.mayRecover(current: reused, owner: identity, ownerIsRunning: false, installersAreRunning: true), "Manual startup cannot resume the bridge while Sparkle still installs")
        expect(UpdateInstallerActivity.mayRecover(current: reused, owner: identity, ownerIsRunning: false, installersAreRunning: false), "Replacement startup can recover after both original owner and installer finish")

        var queries = 0
        let capturedAlive = try await UpdateInstallerActivity.isRunning(record: record, processIsRunning: { _ in true }, query: { _ in queries += 1; return (113, "") })
        expect(capturedAlive && queries == 0, "Captured installer process must block recovery even when launchd might already remove its label")
        let running = try await UpdateInstallerActivity.isRunning(record: record, processIsRunning: { _ in false }, query: { target in
            if target == record.installers[0].target {
                return (0, "job = {\nprogram = /Applications/Claude Codex.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate\narguments = {\n/Applications/Claude Codex.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate\ncom.henrick.codex-accounts\n}\npid = 4242\nruns = 1\n}")
            }
            return (113, "")
        })
        expect(running, "A replacement job with a live PID must keep recovery paused")
        let exited = try await UpdateInstallerActivity.isRunning(record: record, processIsRunning: { _ in false }, query: { target in
            if target == record.installers[0].target {
                return (0, "job = {\nprogram = /Applications/Claude Codex.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate\narguments = {\n/Applications/Claude Codex.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate\ncom.henrick.codex-accounts\n}\nruns = 1\nlast exit code = 0\n}")
            }
            return (113, "")
        })
        expect(!exited, "A finished LaunchOnlyOnce job must not block recovery merely because its label is still registered")
        let queued = try await UpdateInstallerActivity.isRunning(record: record, processIsRunning: { _ in false }, query: { target in
            if target == record.installers[0].target {
                return (0, "job = {\nprogram = /Applications/Claude Codex.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate\narguments = {\n/Applications/Claude Codex.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate\ncom.henrick.codex-accounts\n}\nruns = 0\n}")
            }
            return (113, "")
        })
        expect(queued, "A queued installer with no PID yet cannot be mistaken for an exited job")

        let application = URL(fileURLWithPath: record.applicationPath)
        let installerPath = application.appendingPathComponent("Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate").path
        let activeTarget = "gui/\(getuid())/com.henrick.codex-accounts-sparkle-updater"
        let captured = try await UpdateInstallerActivity.capture(application: application, userID: getuid(), captureProcess: { pid in
            UpdateProcessIdentity(pid: pid, startSeconds: 42, startMicroseconds: 0)
        }, query: { target in
            if target == activeTarget {
                return (0, "job = {\nprogram = \(installerPath)\narguments = {\n\(installerPath)\ncom.henrick.codex-accounts\n}\npid = 4242\nruns = 1\n}")
            }
            if target.hasPrefix("system/") {
                return (0, "job = {\nprogram = /Applications/Previous Name.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate\narguments = {\n/Applications/Previous Name.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate\ncom.henrick.codex-accounts\n}\nruns = 1\n}")
            }
            return (113, "")
        })
        expect(captured.count == 1 && captured[0].target == activeTarget && captured[0].process.pid == 4242, "Arming must ignore terminal jobs in another domain while binding the current live installer")
        do {
            _ = try await UpdateInstallerActivity.capture(application: application, userID: getuid(), query: { _ in (113, "") })
            fatalError("Recovery armed without a live installer")
        } catch UpdateRecoveryFailure.unavailableInstaller {
            expect(true, "Recovery cannot arm using missing or terminal-only jobs")
        }
    }
}
