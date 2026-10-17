import Foundation

final class CatalogueURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var payload = Data()
    nonisolated(unsafe) static var status = 200
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        precondition(request.url?.host == "127.0.0.1" && request.url?.path == "/v1/models")
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.payload); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
@main struct ProfileCatalogTests {
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
        let profileId = UUID().uuidString, directory = root + "-3p/configLibrary"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: root + "-3p") }
        let file = URL(fileURLWithPath: directory + "/" + profileId + ".json")
        let original: [String: Any] = ["inferenceProvider":"gateway", "inferenceGatewayBaseUrl":"http://127.0.0.1:18765", "alwaysStartWithDefaultModel":false, "defaultModelEffort":"xhigh", "inferenceModels":[]]
        try JSONSerialization.data(withJSONObject: original).write(to: file)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CatalogueURLProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        CatalogueURLProtocol.payload = try JSONSerialization.data(withJSONObject: ["data":[["id":"claude-haiku-5-5", "display_name":"GPT-6 Luna", "anthropic_family_tier":"haiku", "is_family_default":true],["id":"anthropic.claude-haiku-5-5", "display_name":"GPT-6 Luna Fast"]]])
        if CommandLine.arguments.count > 1 { CatalogueURLProtocol.payload = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])) }
        try await refreshProfileCatalog(dataDirectory: root, profileId: profileId, session: session, authorize: { $0.setValue("Bearer " + String(repeating:"S",count:64), forHTTPHeaderField:"Authorization") })
        let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        let models = saved["inferenceModels"] as! [[String: Any]]
        precondition(models.count == 2 && models[0]["labelOverride"] as? String == "GPT-6 Luna")
        precondition(models[0]["anthropicFamilyTier"] as? String == "haiku" && models[1]["anthropicFamilyTier"] == nil)
        precondition(saved["alwaysStartWithDefaultModel"] as? Bool == false && saved["defaultModelEffort"] as? String == "xhigh")
        precondition(saved["inferenceGatewayApiKey"] as? String == String(repeating:"S",count:64))
        let before = try Data(contentsOf: file)
        CatalogueURLProtocol.payload = Data("{\"data\":[]}".utf8)
        do { try await refreshProfileCatalog(dataDirectory: root, profileId: profileId, session: session, authorize: { $0.setValue("Bearer " + String(repeating:"S",count:64), forHTTPHeaderField:"Authorization") }); fatalError("Empty capabilities must not launch") } catch is ProfileCatalogError {}
        precondition((try? Data(contentsOf: file)) == before)
        CatalogueURLProtocol.status = 503
        do { try await refreshProfileCatalog(dataDirectory: root, profileId: profileId, session: session, authorize: { $0.setValue("Bearer " + String(repeating:"S",count:64), forHTTPHeaderField:"Authorization") }); fatalError("Failed discovery must not launch") } catch is ProfileCatalogError {}
        precondition((try? Data(contentsOf: file)) == before)
        do { try await refreshProfileCatalog(dataDirectory: root, profileId: "../elsewhere", session: session, authorize: { $0.setValue("Bearer " + String(repeating:"S",count:64), forHTTPHeaderField:"Authorization") }); fatalError("Invalid profile path") } catch is ProfileCatalogError {}
        print("PASS: labels, aliases, family defaults, preserved settings, empty/error fail closed, safe profile identifier")
    }
}
