import SwiftUI

struct TokenUsageView: View {
    let usage: TokenUsageSnapshot?
    var unavailable = false
    @State private var period: TokenUsagePeriod = .today

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            HStack {
                Text(L10n.text("tokens.title")).font(.caption.weight(.semibold))
                Spacer()
                Picker(L10n.text("tokens.period"), selection: $period) {
                    ForEach(TokenUsagePeriod.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }.pickerStyle(.segmented).labelsHidden().controlSize(.small).fixedSize()
            }
            if !unavailable, let usage, let totals = usage.totals(for: period) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(TokenUsageTotals.formatted(totals.totalTokens)).font(.title3.weight(.semibold)).monospacedDigit()
                        .lineLimit(1).minimumScaleFactor(0.7)
                    Text(L10n.text("tokens.total")).font(.caption).foregroundStyle(.secondary)
                }.accessibilityElement(children: .combine)
                HStack(alignment: .top, spacing: 12) {
                    metric("tokens.input", value: totals.inputTokens, help: L10n.text("tokens.inputHelp"))
                    metric("tokens.output", value: totals.outputTokens, help: L10n.text("tokens.outputHelp"))
                    metric("tokens.cache", value: totals.cacheTokens,
                        help: L10n.text("tokens.cacheHelp", TokenUsageTotals.formatted(totals.cacheReadTokens), TokenUsageTotals.formatted(totals.cacheWriteTokens)))
                }
                if let since = scope(usage) {
                    Text(since).font(.system(size: 10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if totals.unreportedRequests > 0 {
                    Text(L10n.text("tokens.unreported", TokenUsageTotals.formatted(totals.unreportedRequests)))
                        .font(.system(size: 10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text(L10n.text(usage?.available == true && usage?.persisted == false ? "tokens.notSaved" : "tokens.unavailable"))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func metric(_ key: String, value: Int64, help: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(L10n.text(key)).font(.caption2).foregroundStyle(.secondary)
            Text(TokenUsageTotals.compact(value)).font(.callout.weight(.medium)).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.7)
        }.frame(maxWidth: .infinity, alignment: .leading)
            .help(TokenUsageTotals.formatted(value) + "\n" + help)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(L10n.text(key) + ": " + TokenUsageTotals.formatted(value))
            .accessibilityHint(help)
    }

    private func scope(_ usage: TokenUsageSnapshot) -> String? {
        guard period == .total, let startedAt = usage.startedAt, let date = TokenUsageSnapshot.date(startedAt) else { return nil }
        return L10n.text("tokens.since", date.formatted(date: .abbreviated, time: .omitted))
    }
}
