import Foundation

@main
struct LocalizationTests {
    private static var assertions = 0

    static func expect(_ value: @autoclosure () -> Bool, _ message: String) {
        assertions += 1
        guard value() else { fatalError(message) }
    }

    static func main() throws {
        let resources = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Resources")
        let preferences: [([String], String)] = [
            ([], "en"), (["ja-JP", "zh-Hans"], "en"), (["en-GB"], "en"),
            (["pt-BR"], "pt"), (["pt_PT"], "pt"), (["ES_mx"], "es"),
            (["fr-CA"], "fr"), (["de-CH"], "de"), (["it-IT"], "it"),
            (["ja-JP", "fr-CA", "pt-BR"], "fr"), (["es-AR", "en-US"], "es"),
            (["", "PT-br"], "pt"), (["ptx", "it"], "it")
        ]
        for (input, expected) in preferences {
            expect(LocalizationCatalog.language(for: input) == expected, "Language preference mismatch: \(input)")
        }
        let actual = LocalizationCatalog(resources: resources, preferences: ["pt-BR"])
        expect(Set(actual.tables.keys) == Set(LocalizationCatalog.supported), "The application catalogs must load through Foundation")
        for language in LocalizationCatalog.supported {
            let catalog = LocalizationCatalog(resources: resources, preferences: [language])
            expect(catalog.language == language, "Supported language was not selected: \(language)")
            expect(catalog.text("panel.subtitle") != "panel.subtitle", "Subtitle lookup failed: \(language)")
        }
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("codex-ultra-localizations-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let fixtures = [
            "en": ["fallback": "English fallback", "ordered": "First {0}; second {1}", "repeat": "{0} then {0}", "unicode": "🧭 {1} / {0}", "missing": "{0} + {1}"],
            "pt": ["ordered": "Segundo {1}; primeiro {0}"]
        ]
        for (language, table) in fixtures {
            let directory = temporary.appendingPathComponent("\(language).lproj")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let bytes = try PropertyListSerialization.data(fromPropertyList: table, format: .xml, options: 0)
            try bytes.write(to: directory.appendingPathComponent("Localizable.strings"))
        }
        let portuguese = LocalizationCatalog(resources: temporary, preferences: ["pt-BR"])
        expect(portuguese.text("fallback") == "English fallback", "A missing translated key must fall back to English")
        expect(portuguese.text("ordered", arguments: ["one", "two"]) == "Segundo two; primeiro one", "Translations may reorder placeholders")
        expect(portuguese.text("ordered", arguments: ["{1}", "literal"]) == "Segundo literal; primeiro {1}", "Argument text must not be interpreted as a template")
        expect(portuguese.text("repeat", arguments: ["same"]) == "same then same", "Repeated placeholders must all be replaced")
        expect(portuguese.text("unicode", arguments: ["ação 🐈", "日本語"]) == "🧭 日本語 / ação 🐈", "Unicode argument boundaries must remain intact")
        expect(portuguese.text("missing", arguments: ["only"]) == "only + {1}", "Missing arguments must remain visible without crashing")
        expect(portuguese.text("missing.key") == "missing.key", "An unknown key must remain diagnosable")
        let absentLanguage = LocalizationCatalog(resources: temporary, preferences: ["de-DE"])
        expect(absentLanguage.language == "de", "Language selection must not depend on loaded fixture tables")
        expect(absentLanguage.text("fallback") == "English fallback", "A missing language table must fall back to English")
        let empty = LocalizationCatalog(resources: temporary.appendingPathComponent("absent"), preferences: ["en"])
        expect(empty.text("missing.key") == "missing.key", "Missing resources must remain diagnosable")
        print("Localization tests: \(assertions) assertions passed")
    }
}
