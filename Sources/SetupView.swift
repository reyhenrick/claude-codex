import SwiftUI

struct SetupView: View {
    @ObservedObject var model: SetupModel
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(L10n.text("setup.title")).font(.title2.weight(.semibold))
                    Text(L10n.text("setup.description"))
                        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    VStack(alignment: .leading, spacing: 7) {
                        Text(L10n.text("setup.appName")).font(.callout.weight(.medium))
                        TextField("Claude Codex Workspace", text: $model.name).textFieldStyle(.roundedBorder)
                    }.disabled(model.busy)

                        VStack(alignment: .leading, spacing: 7) {
                            Text(L10n.text("setup.officialApp")).font(.callout.weight(.medium))
                            HStack { TextField("Claude.app", text: $model.source).textFieldStyle(.roundedBorder); Button(L10n.text("action.choose"), action: model.chooseSource) }
                            Text(L10n.text("setup.isolatedDescription")).font(.caption).foregroundStyle(.secondary)
                            Text(L10n.text("setup.modelsDescription")).font(.caption).foregroundStyle(.secondary)
                            Toggle(L10n.text("setup.migrateData"), isOn: $model.migrateData)
                            if model.migrateData {
                                Text(L10n.text("setup.closeSourceBeforeMigration")).font(.caption).foregroundStyle(.secondary)
                                Text(L10n.text("setup.sourceDataFolder")).font(.callout.weight(.medium))
                                HStack {
                                    TextField(L10n.text("setup.sourceDataPlaceholder"), text: $model.sourceDataRoot).textFieldStyle(.roundedBorder)
                                    Button(L10n.text("action.choose"), action: model.chooseSourceDataRoot)
                                }
                                Text(L10n.text("setup.codeDataFolder")).font(.callout.weight(.medium))
                                HStack {
                                    TextField(L10n.text("setup.codeDataPlaceholder"), text: $model.sourceCodeRoot).textFieldStyle(.roundedBorder)
                                    Button(L10n.text("action.choose"), action: model.chooseSourceCodeRoot)
                                }
                                Text(L10n.text("setup.migrationDescription")).font(.caption).foregroundStyle(.secondary)
                            }
                        }.disabled(model.busy)
                    if let error = model.error { Label(error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
                    if let resultMessage = model.resultMessage {
                        Label(resultMessage, systemImage: "checkmark.circle.fill").font(.callout).foregroundStyle(.green).fixedSize(horizontal: false, vertical: true)
                    }
                    if let migration = model.result?.migration {
                        Text(L10n.text("setup.migrationSummary", String(migration.copiedFiles), String(migration.skippedFiles))).font(.caption)
                        if !migration.warnings.isEmpty {
                            Label(L10n.text("setup.migrationWarnings"), systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                        }
                        if migration.reportPath != nil { Button(L10n.text("action.showMigrationReport"), action: model.revealMigrationReport) }
                    }
                }.padding(.trailing, 3)
            }
            HStack {
                if model.busy { ProgressView().controlSize(.small); Text(L10n.text("setup.preparing")).foregroundStyle(.secondary) }
                if model.result != nil { Button(L10n.text("action.showFinder"), action: model.reveal) }
                Spacer()
                Button(L10n.text("action.createInstallation"), action: model.create).buttonStyle(.borderedProminent)
                    .disabled(model.busy || model.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 540, height: 620)
    }
}
