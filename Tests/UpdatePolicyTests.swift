import Foundation

private enum FixtureFailure: Error { case expected }

@MainActor
private final class Fixture {
    var events: [String] = []
    var snapshots: [UpdateReadiness] = []
    var localReady = true
    var ownershipFailure = false
    var drainFailure = false
    var stopFailure = false
    var recoveryFailure = false
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
        expect(idle.events == ["validate", "mark", "drain", "validate", "poll", "stop"], "Readiness must be refreshed after ownership verification")
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
        expect(lateLocal.events == ["validate", "mark", "drain", "validate", "poll", "wait", "poll", "validate", "poll", "stop"], "Local work beginning during ownership verification must postpone stop")


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
        print("Update policy tests: \(assertions) assertions passed")
    }
}
