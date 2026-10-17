import SwiftUI

struct SetupView: View {
    @ObservedObject var model: SetupModel
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Preparar o Claude").font(.title2.weight(.semibold))
            Text("Use as contas conectadas ao Contas Codex em um perfil existente ou em um aplicativo separado.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Picker("Tipo de configuração", selection: $model.kind) {
                Text("Perfil no Claude existente").tag("profile")
                Text("Instalação separada").tag("isolated")
            }.pickerStyle(.segmented).labelsHidden().disabled(model.busy)
                .onChange(of: model.kind) { _, kind in
                    model.result = nil; model.error = nil
                    if kind == "isolated", model.name == "Codex" { model.name = "Claude Codex" }
                    if kind == "profile", model.name == "Claude Codex" { model.name = "Codex" }
                }
            VStack(alignment: .leading, spacing: 7) {
                Text(model.kind == "profile" ? "Nome do perfil" : "Nome do aplicativo").font(.callout.weight(.medium))
                TextField(model.kind == "profile" ? "Codex" : "Claude Codex", text: $model.name).textFieldStyle(.roundedBorder)
            }.disabled(model.busy)
            if model.kind == "profile" {
                VStack(alignment: .leading, spacing: 7) {
                    Text("Pasta de dados do Claude em modo 3P").font(.callout.weight(.medium))
                    HStack { TextField("Pasta terminada em -3p", text: $model.root).textFieldStyle(.roundedBorder); Button("Escolher…", action: model.chooseRoot) }
                    Toggle("Selecionar o perfil ao criá-lo", isOn: $model.activate)
                    Text("Adiciona um perfil. Os perfis e as conversas existentes são preservados. Encerre e abra o Claude para aplicar a seleção.").font(.caption).foregroundStyle(.secondary)
                }.disabled(model.busy)
            } else {
                VStack(alignment: .leading, spacing: 7) {
                    Text("Aplicativo oficial instalado").font(.callout.weight(.medium))
                    HStack { TextField("Claude.app", text: $model.source).textFieldStyle(.roundedBorder); Button("Escolher…", action: model.chooseSource) }
                    Text("Cria uma cópia local do Claude com dados próprios e um atalho em Aplicativos do seu usuário. A instalação original e suas conversas são preservadas.").font(.caption).foregroundStyle(.secondary)
                    Text("Inclui os quatro modelos, esforço Extra High e Workflows/Ultracode. As contas são compartilhadas com este gerenciador.").font(.caption).foregroundStyle(.secondary)
                }.disabled(model.busy)
            }
            if let error = model.error { Label(error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            if let result = model.result {
                Label(result.message, systemImage: "checkmark.circle.fill").font(.callout).foregroundStyle(.green).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            HStack {
                if model.busy { ProgressView().controlSize(.small); Text("Preparando…").foregroundStyle(.secondary) }
                if model.result != nil { Button("Mostrar no Finder", action: model.reveal) }
                Spacer()
                Button(model.kind == "profile" ? "Criar perfil" : "Criar instalação", action: model.create).buttonStyle(.borderedProminent)
                    .disabled(model.busy || model.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 540, height: 480)
    }
}
