import Foundation

struct LocalizationCatalog {
    static let supported = ["en", "pt", "es", "fr", "de", "it"]
    let language: String
    let tables: [String: [String: String]]

    static func language(for preferences: [String]) -> String {
        for preference in preferences {
            let code = preference.replacingOccurrences(of: "_", with: "-")
                .split(separator: "-").first.map(String.init)?.lowercased() ?? ""
            if supported.contains(code) { return code }
        }
        return "en"
    }

    init(resources: URL, preferences: [String]) {
        language = Self.language(for: preferences)
        var loaded: [String: [String: String]] = [:]
        for code in Self.supported {
            let url = resources.appendingPathComponent("\(code).lproj/Localizable.strings")
            if let data = try? Data(contentsOf: url),
               let table = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: String] {
                loaded[code] = table
            }
        }
        tables = loaded
    }

    func text(_ key: String, arguments: [String] = []) -> String {
        let template = tables[language]?[key] ?? tables["en"]?[key] ?? key
        let pattern = try! NSRegularExpression(pattern: #"\{(\d+)\}"#)
        let matches = pattern.matches(in: template, range: NSRange(template.startIndex..., in: template))
        var result = template
        for match in matches.reversed() {
            guard let numberRange = Range(match.range(at: 1), in: template),
                  let index = Int(template[numberRange]), arguments.indices.contains(index),
                  let range = Range(match.range, in: result) else { continue }
            result.replaceSubrange(range, with: arguments[index])
        }
        return result
    }
}

enum L10n {
    static let resources: URL = {
        var candidate = Bundle.main.executableURL?.deletingLastPathComponent() ?? Bundle.main.bundleURL
        for _ in 0..<5 {
            if candidate.pathExtension == "app" { return candidate.appendingPathComponent("Contents/Resources") }
            candidate.deleteLastPathComponent()
        }
        return (Bundle.main.executableURL?.deletingLastPathComponent() ?? Bundle.main.bundleURL).appendingPathComponent("Resources")
    }()
    static let catalog = LocalizationCatalog(resources: resources,
        preferences: UserDefaults.standard.stringArray(forKey: "AppleLanguages") ?? Locale.preferredLanguages)
    static var language: String { catalog.language }
    static var locale: Locale { Locale(identifier: language) }
    static func text(_ key: String, _ arguments: String...) -> String { catalog.text(key, arguments: arguments) }
    static func serviceMessage(code: String?, fallback: String) -> String {
        guard let code, catalog.tables["en"]?["service.\(code)"] != nil else { return text(fallback) }
        return text("service.\(code)")
    }
}
