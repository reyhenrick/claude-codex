import SwiftUI

struct AccountsPanel: View {
    @ObservedObject var model: AccountsModel
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
        .alert("Desconectar conta?", isPresented: Binding(
            get: { model.disconnectCandidate != nil },
            set: { if !$0 { model.disconnectCandidate = nil } }
        )) {
            if let account = model.disconnectCandidate {
                Button("Desconectar", role: .destructive) { model.disconnect(account); model.disconnectCandidate = nil }
            }
            Button("Cancelar", role: .cancel) { model.disconnectCandidate = nil }
        } message: {
            Text("Remove \(model.disconnectCandidate?.email ?? "esta conta") deste gerenciador local. A assinatura e os outros aplicativos continuam como estão.")
        }
    }
    private var header: some View {
        HStack(spacing: 9) {
            Image(systemName: "person.2.circle.fill").font(.title2).foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 2) {
                Text("Contas Codex").font(.headline)
                Text("Conexão do Claude").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if model.refreshing { ProgressView().controlSize(.small).accessibilityLabel("Atualizando limites") }
            Button { Task { await model.load(refresh: true) } } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless).help("Atualizar limites").accessibilityLabel("Atualizar limites")
                .disabled(model.applying || model.refreshing)
        }
    }
    @ViewBuilder private var mainContent: some View {
        if let snapshot = model.snapshot {
            Picker("Modo de consumo", selection: Binding(get: { snapshot.mode }, set: { mode in
                if mode == "automatic" { model.setAutomatic() }
                else if let account = snapshot.accounts.first(where: { $0.email == snapshot.fixedEmail }) ?? snapshot.accounts.first(where: \.eligible) ?? snapshot.accounts.first { model.fix(account) }
            })) {
                Text("Automático").tag("automatic")
                Text("Conta fixa").tag("fixed")
            }.pickerStyle(.segmented).labelsHidden().disabled(model.applying || model.refreshing || snapshot.accounts.isEmpty)
            Text(snapshot.mode == "automatic" ? "Usa a primeira conta com cota, na ordem abaixo." : "Usa somente a conta marcada. Se a cota acabar, para.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let connection = snapshot.connection { pendingConnection(connection) }
            if let error = model.error { errorView(error) }
            HStack {
                Text("\(snapshot.accounts.filter(\.eligible).count) de \(snapshot.accounts.count) disponíveis")
                Spacer()
                if let requests = snapshot.activeRequests, requests > 0 { Text("\(requests) em andamento") }
            }.font(.caption2).foregroundStyle(.secondary)
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(Array(snapshot.accounts.enumerated()), id: \.element.id) { index, account in
                        AccountRow(account: account, index: index, count: snapshot.accounts.count,
                            selected: snapshot.nextAccount == account.email, fixed: snapshot.mode == "fixed", model: model)
                        if index < snapshot.accounts.count - 1 { Divider().padding(.vertical, 9) }
                    }
                    if snapshot.accounts.isEmpty {
                        ContentUnavailableView("Nenhuma conta conectada", systemImage: "person.crop.circle.badge.plus", description: Text("Conecte uma conta para começar."))
                    }
                }.padding(.vertical, 4).padding(.horizontal, 1)
            }
            if let used = snapshot.lastUsed {
                Text("Último uso: \(used.email)").font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
        } else {
            Spacer()
            if let error = model.error {
                errorView(error)
                Button("Preparar serviço", action: model.startService).buttonStyle(.borderedProminent)
            } else {
                HStack { Spacer(); ProgressView("Consultando as contas…"); Spacer() }
            }
            Spacer()
        }
    }
    private func errorView(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
    }
    private func pendingConnection(_ connection: PendingConnection) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(connection.error == nil ? "Conectando \(connection.email)" : "A conexão precisa ser refeita")
                .font(.caption.weight(.semibold)).lineLimit(2)
            Text(connection.error ?? "Conclua a autorização no navegador. A conta aparecerá aqui automaticamente.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                if connection.error != nil {
                    Button("Tentar novamente") { model.connectionEmail = connection.email; model.showingConnectionForm = true }
                } else if model.canContinueLogin { Button("Continuar login", action: model.continueLogin) }
                Spacer()
                Button("Cancelar", action: model.cancelConnection)
            }.controlSize(.small).disabled(model.applying)
        }.padding(10).background(Color.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
    private var connectionForm: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Conectar conta").font(.title3.weight(.semibold))
            Text("Informe o e-mail e entre com essa conta na página oficial da OpenAI que será aberta no navegador.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextField("E-mail da conta", text: $model.connectionEmail)
                .textFieldStyle(.roundedBorder).accessibilityLabel("E-mail da conta")
                .onSubmit(model.connect).disabled(model.applying)
            if let error = model.error { errorView(error) }
            Spacer(minLength: 0)
            HStack {
                Button("Cancelar") { model.showingConnectionForm = false; model.connectionEmail = "" }
                Spacer()
                Button("Continuar no navegador", action: model.connect).buttonStyle(.borderedProminent)
                    .disabled(model.applying || model.refreshing || model.connectionEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(.top, 8)
    }
    private var footer: some View {
        VStack(spacing: 10) {
            Divider()
            HStack {
                Button { model.showingConnectionForm = true; model.error = nil } label: { Label("Conectar conta", systemImage: "plus") }
                    .buttonStyle(.bordered).disabled(model.applying || model.snapshot?.connection != nil)
                Spacer()
                Menu {
                    Toggle("Abrir ao iniciar sessão", isOn: Binding(get: { model.openAtLogin }, set: model.setOpenAtLogin))
                    Button("Configurar Claude…", action: model.openSetup)
                    Button("Abrir painel no navegador", action: model.openBrowserPanel)
                    Button("Preparar serviço", action: model.startService)
                    Divider()
                    Button("Sair do app", action: onQuit)
                } label: { Image(systemName: "gearshape") }
                .menuStyle(.borderlessButton).fixedSize().accessibilityLabel("Opções do app")
            }
            Text("Cota verificada antes do uso. Solicitações em andamento permanecem na conta em que começaram.")
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
            Button { model.fix(account) } label: {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 5) {
                        Text(account.email).font(.system(size: 12.5, weight: selected ? .semibold : .medium)).lineLimit(1).truncationMode(.middle)
                        if selected { Image(systemName: fixed ? "pin.fill" : "checkmark.circle.fill").font(.caption).foregroundStyle(.blue) }
                    }
                    if !account.eligible || account.windows.isEmpty {
                        Text(account.status).font(.caption2).foregroundStyle(account.reason == "exhausted" ? Color.orange : Color.secondary)
                    }
                    ForEach(account.windows, id: \.self) { window in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(window.title)
                                Spacer()
                                Text("\(Int(window.remaining))% disponível").monospacedDigit()
                            }.font(.system(size: 10)).foregroundStyle(.secondary)
                            ProgressView(value: window.remaining, total: 100).tint(window.remaining == 0 ? .orange : .blue).controlSize(.mini)
                                .accessibilityLabel("\(window.title): \(Int(window.remaining)) por cento disponível")
                            if let reset = window.resetAt, window.usedPercent > 0 {
                                Text("Renova \(Date(timeIntervalSince1970: reset).formatted(.dateTime.day().month().hour().minute().locale(Locale(identifier: "pt_BR"))))")
                                    .font(.system(size: 9)).foregroundStyle(.tertiary)
                            }
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).help("Usar somente \(account.email)").accessibilityLabel("Usar \(account.email)")
                .disabled(model.applying || model.refreshing)
            Menu {
                Button("Usar somente esta conta") { model.fix(account) }
                Button("Usar primeiro no automático") { model.prioritize(account) }.disabled(index == 0 && !fixed)
                Divider()
                Button("Subir na ordem") { model.move(account, by: -1) }.disabled(index == 0)
                Button("Descer na ordem") { model.move(account, by: 1) }.disabled(index == count - 1)
                Divider()
                Button("Desconectar…", role: .destructive) { model.disconnectCandidate = account }.disabled((account.activeRequests ?? 0) > 0)
            } label: { Image(systemName: "ellipsis.circle").font(.body) }
            .menuStyle(.borderlessButton).fixedSize().accessibilityLabel("Opções de \(account.email)")
            .disabled(model.applying || model.refreshing)
        }
    }
}
