import SwiftUI

struct AccountsPanel: View {
    @ObservedObject var model: AccountsModel
    @ObservedObject var updater: AppUpdater
    var onQuit: () -> Void
    static let cornerRadius: CGFloat = 22

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if model.showingConnectionForm {
                connectionForm
            } else {
                mainContent
                footer
            }
        }
        .padding(16)
        .frame(width: 420, height: model.showingConnectionForm ? 340 : 650)
        .glassEffect(.regular, in: .rect(cornerRadius: Self.cornerRadius))
        .alert(model.confirmation?.title ?? L10n.text("confirm.defaultTitle"), isPresented: Binding(
            get: { model.confirmation != nil },
            set: { if !$0 { model.confirmation = nil } }
        ), presenting: model.confirmation) { confirmation in
            Button(confirmation.actionTitle, role: confirmation.isDestructive ? .destructive : nil) { model.confirmAction(confirmation) }
                .disabled(model.applying || model.refreshing)
            Button(L10n.text("action.cancel"), role: .cancel) { model.confirmation = nil }
        } message: { confirmation in
            Text(confirmation.message)
        }
    }
    private var header: some View {
        HStack(spacing: 9) {
            Image(systemName: "terminal").font(.title2.weight(.semibold)).foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 2) {
                Text("Claude Codex").font(.headline)
                Text(L10n.text("panel.subtitle")).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if model.refreshing || model.applying {
                ProgressView().controlSize(.small).accessibilityLabel(model.applying ? L10n.text("panel.applying") : L10n.text("panel.refreshing"))
            }
            Button { Task { await model.load(refresh: true) } } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless).help(L10n.text("action.refresh")).accessibilityLabel(L10n.text("action.refresh"))
                .disabled(model.applying || model.refreshing)
        }
    }
    @ViewBuilder private var mainContent: some View {
        if let snapshot = model.snapshot {
            Picker(L10n.text("panel.mode"), selection: Binding(get: { snapshot.mode }, set: { mode in
                if mode == "automatic" { model.setAutomatic() }
                else if let account = snapshot.accounts.first(where: { $0.email == snapshot.fixedEmail }) ?? snapshot.accounts.first(where: \.eligible) ?? snapshot.accounts.first { model.fix(account) }
            })) {
                Text(L10n.text("mode.automatic")).tag("automatic")
                Text(L10n.text("mode.fixed")).tag("fixed")
            }.pickerStyle(.segmented).labelsHidden().disabled(model.applying || model.refreshing || snapshot.accounts.isEmpty)
            Text(snapshot.mode == "automatic" ? L10n.text("mode.automaticDescription") : L10n.text("mode.fixedDescription"))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            creditsPolicy(snapshot)
            if let connection = snapshot.connection { pendingConnection(connection) }
            errors
            HStack {
                Text(L10n.text("accounts.available", String(snapshot.accounts.filter(\.eligible).count), String(snapshot.accounts.count)))
                Spacer()
                if let requests = snapshot.activeRequests, requests > 0 { Text(L10n.text("accounts.activeRequests", String(requests))) }
            }.font(.caption2).foregroundStyle(.secondary)
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(Array(snapshot.accounts.enumerated()), id: \.element.id) { index, account in
                        AccountRow(account: account, index: index, count: snapshot.accounts.count,
                            selected: (snapshot.mode == "fixed" ? snapshot.fixedEmail : snapshot.nextEligibleAccount) == account.email,
                            fixed: snapshot.mode == "fixed", model: model)
                        if index < snapshot.accounts.count - 1 { Divider().padding(.vertical, 10) }
                    }
                    if snapshot.accounts.isEmpty {
                        ContentUnavailableView(L10n.text("accounts.empty"), systemImage: "person.crop.circle.badge.plus", description: Text(L10n.text("accounts.emptyDescription")))
                    }
                }.padding(.vertical, 4).padding(.horizontal, 1)
            }.frame(minHeight: 100)
            if let used = snapshot.lastUsed {
                Text(L10n.text("accounts.lastUsed", used.email)).font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
        } else {
            Spacer()
            if model.queryError != nil || model.actionError != nil {
                errors
                Button(L10n.text("action.restoreConnection"), action: model.restoreConnection).buttonStyle(.borderedProminent).disabled(model.applying || model.refreshing)
            } else {
                HStack { Spacer(); ProgressView(L10n.text("panel.loading")); Spacer() }
            }
            Spacer()
        }
    }
    private func creditsPolicy(_ snapshot: PoolSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Toggle(L10n.text("credits.toggle"), isOn: Binding(get: { snapshot.allowExtraCredits }, set: model.setExtraCredits))
                .toggleStyle(.switch).controlSize(.mini).font(.caption.weight(.medium))
                .disabled(model.applying || model.refreshing)
            Text(L10n.text("credits.policy"))
                .font(.system(size: 10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if snapshot.creditPhase {
                Label(L10n.text("credits.released"), systemImage: "bolt.circle").font(.caption2).foregroundStyle(.orange)
            } else if snapshot.allowExtraCredits, snapshot.creditBlockReason == "unconfirmed" {
                Text(L10n.text("credits.blockedUnknown")).font(.caption2).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            } else if snapshot.allowExtraCredits, snapshot.creditBlockReason == "no_credits" {
                Text(L10n.text("credits.noAccounts")).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
    @ViewBuilder private var errors: some View {
        if let message = model.queryError {
            errorView(message)
            if model.snapshot != nil {
                Button(L10n.text("action.restoreConnection"), action: model.restoreConnection)
                    .buttonStyle(.bordered).disabled(model.applying || model.refreshing)
            }
        }
        if let message = model.actionError {
            HStack(alignment: .top, spacing: 6) {
                errorView(message)
                Spacer(minLength: 0)
                Button { model.actionError = nil } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless).accessibilityLabel(L10n.text("action.dismissNotice"))
            }
        }
    }
    private func errorView(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
    }
    private func pendingConnection(_ connection: PendingConnection) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(connection.error == nil ? L10n.text("connection.connecting", connection.email) : L10n.text("connection.retryTitle"))
                .font(.caption.weight(.semibold)).lineLimit(2)
            Text(L10n.text(connection.error == nil ? "connection.description" : "connection.retryDescription"))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                if connection.error != nil {
                    Button(L10n.text("action.retry")) { model.connectionEmail = connection.email; model.showingConnectionForm = true }
                } else if model.canContinueLogin { Button(L10n.text("action.continueLogin"), action: model.continueLogin) }
                Spacer()
                Button(L10n.text("action.cancel"), action: model.cancelConnection)
            }.controlSize(.small).disabled(model.applying || model.refreshing)
        }.padding(10).background(Color.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
    private var connectionForm: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n.text("action.connect")).font(.title3.weight(.semibold))
            Text(L10n.text("connection.instructions"))
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextField(L10n.text("connection.email"), text: $model.connectionEmail)
                .textFieldStyle(.roundedBorder).accessibilityLabel(L10n.text("connection.email"))
                .onSubmit(model.connect).disabled(model.applying)
            errors
            Spacer(minLength: 0)
            HStack {
                Button(L10n.text("action.cancel")) { model.showingConnectionForm = false; model.connectionEmail = "" }
                Spacer()
                Button(L10n.text("action.continueBrowser"), action: model.connect).buttonStyle(.borderedProminent)
                    .disabled(model.applying || model.refreshing || model.connectionEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(.top, 8)
    }
    private var footer: some View {
        VStack(spacing: 10) {
            Divider()
            if updater.waitingForIdle {
                Text(L10n.text("updater.busy")).font(.system(size: 10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else if let error = updater.lastError {
                Text(error).font(.system(size: 10)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            } else if updater.updateAvailable {
                HStack {
                    Text(L10n.text("updater.available")).font(.caption)
                    Spacer()
                    Button(L10n.text("updater.show"), action: updater.checkForUpdates)
                        .controlSize(.small).disabled(!updater.canPerformUpdateAction)
                }
            }
            if updater.pendingUpdateInstallsOnQuit {
                Text(L10n.text("updater.stagedOnQuit")).font(.system(size: 10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button { model.showingConnectionForm = true } label: { Label(L10n.text("action.connect"), systemImage: "plus") }
                    .buttonStyle(.bordered).disabled(model.applying || model.snapshot?.connection != nil)
                Spacer()
                Menu {
                    Toggle(L10n.text("settings.openAtLogin"), isOn: Binding(get: { model.openAtLogin }, set: model.setOpenAtLogin))
                    Button(L10n.text("action.setupClaude"), action: model.openSetup)
                    Divider()
                    Toggle(L10n.text("updater.installAutomatically"), isOn: Binding(get: { updater.automaticallyInstalls }, set: updater.setAutomaticallyInstalls))
                    Button(L10n.text("updater.check"), action: updater.checkForUpdates)
                        .disabled(!updater.canCheckForUpdates || !updater.canPerformUpdateAction)
                    Divider()
                    Button(L10n.text("action.quit"), action: onQuit)
                } label: { Image(systemName: "gearshape") }
                .menuStyle(.borderlessButton).fixedSize().accessibilityLabel(L10n.text("settings.title"))
            }
            Text(L10n.text("panel.admissionNotice"))
                .font(.system(size: 10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct AccountRow: View {
    let account: Account
    let index: Int
    let count: Int
    let selected: Bool
    let fixed: Bool
    @ObservedObject var model: AccountsModel

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(index + 1)").font(.caption.monospacedDigit()).foregroundStyle(.tertiary).frame(width: 15).padding(.top, 2)
            VStack(alignment: .leading, spacing: 7) {
                selectionButton
                Text(account.credits.label).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text(account.resets.label).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if !account.resets.canApply, account.resets.reason == "not_eligible" {
                    Text(L10n.text("reset.notApplicable")).font(.system(size: 10)).foregroundStyle(.tertiary)
                }
                HStack(alignment: .center, spacing: 10) {
                    Button(account.resets.reason == "retry" ? L10n.text("action.checkAttemptMenu") : L10n.text("action.applyResetMenu")) { model.applyReset(account) }
                        .controlSize(.small).font(.caption2).fixedSize()
                        .disabled(model.applying || model.refreshing || !account.resets.canApply)
                        .help(account.resets.availability)
                        .accessibilityLabel(L10n.text(account.resets.reason == "retry" ? "reset.checkForAccount" : "reset.applyForAccount", account.email))
                    Toggle(L10n.text("reset.autoToggle"), isOn: Binding(
                        get: { account.resets.autoEnabled }, set: { model.setAutoReset(account, enabled: $0) }
                    )).toggleStyle(.switch).controlSize(.small).font(.caption2)
                        .disabled(model.applying || model.refreshing)
                        .accessibilityLabel(L10n.text("reset.autoForAccount", String(account.resets.thresholdPercent), account.email))
                }
                if let operation = account.resets.operation { resetReceipt(operation) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            Menu {
                Button(L10n.text("account.useOnly")) { model.fix(account) }
                Button(L10n.text("account.useFirst")) { model.prioritize(account) }.disabled(index == 0 && !fixed)
                Divider()
                Button(L10n.text("account.moveUp")) { model.move(account, by: -1) }.disabled(index == 0)
                Button(L10n.text("account.moveDown")) { model.move(account, by: 1) }.disabled(index == count - 1)
                Divider()
                Button(L10n.text("action.disconnectMenu"), role: .destructive) { model.confirmation = .disconnect(account) }.disabled((account.activeRequests ?? 0) > 0)
            } label: { Image(systemName: "ellipsis.circle").font(.body) }
            .menuStyle(.borderlessButton).fixedSize().accessibilityLabel(L10n.text("account.options", account.email))
            .disabled(model.applying || model.refreshing)
        }
    }
    private var selectionButton: some View {
        Button { model.fix(account) } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 5) {
                    Text(account.email).font(.system(size: 12.5, weight: selected ? .semibold : .medium)).lineLimit(1).truncationMode(.middle)
                    if selected { Image(systemName: fixed ? "pin.fill" : "checkmark.circle.fill").font(.caption).foregroundStyle(.blue) }
                }
                if !account.eligible || account.windows.isEmpty || account.consumptionSource == "credits" {
                    Text(account.status).font(.caption2).foregroundStyle(account.reason == "exhausted" || account.consumptionSource == "credits" ? Color.orange : Color.secondary)
                }
                ForEach(account.windows, id: \.self) { window in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(window.title)
                            Spacer()
                            Text(L10n.text("quota.remaining", String(Int(window.remaining)))).monospacedDigit()
                        }.font(.system(size: 10)).foregroundStyle(.secondary)
                        ProgressView(value: window.remaining, total: 100).tint(window.remaining == 0 ? .orange : .blue).controlSize(.mini)
                            .accessibilityLabel(L10n.text("quota.accessibility", window.title, String(Int(window.remaining))))
                        if let reset = window.resetAt, window.usedPercent > 0 {
                            Text(L10n.text("quota.renews", Date(timeIntervalSince1970: reset).formatted(.dateTime.day().month().hour().minute().locale(L10n.locale))))
                                .font(.system(size: 9)).foregroundStyle(.tertiary)
                        }
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain).help(L10n.text("account.useOnlyEmail", account.email)).accessibilityLabel(L10n.text("account.useEmail", account.email))
            .disabled(model.applying || model.refreshing)
    }
    private func resetReceipt(_ operation: ResetOperation) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(operation.source == "automatic" ? L10n.text("reset.automaticReceipt", operation.title) : operation.title).font(.system(size: 10, weight: .medium))
            Text(operation.displayMessage).font(.system(size: 10)).fixedSize(horizontal: false, vertical: true)
        }.foregroundStyle(operation.needsAttention ? Color.orange : Color.secondary)
    }
}
