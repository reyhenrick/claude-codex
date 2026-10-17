import Foundation

enum ProfileCatalogError: Error { case unavailable, invalidProfile, concurrentChange }

/// Refresh only the generated gateway profile, before its isolated Claude starts.
func refreshProfileCatalog(dataDirectory: String, profileId: String, session: URLSession = .shared, authorize: ((inout URLRequest) throws -> Void) = BridgeAuthorization.apply) async throws {
    guard UUID(uuidString: profileId) != nil else { throw ProfileCatalogError.invalidProfile }
    let url = URL(string: "http://127.0.0.1:18765/v1/models")!
    var request = URLRequest(url: url); request.timeoutInterval = 20; request.cachePolicy = .reloadIgnoringLocalCacheData
    try authorize(&request)
    guard let authorization = request.value(forHTTPHeaderField: "Authorization"), authorization.hasPrefix("Bearer "),
          authorization.dropFirst(7).count == 64 else { throw ProfileCatalogError.unavailable }
    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse, response.statusCode == 200,
          let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let models = payload["data"] as? [[String: Any]], !models.isEmpty else { throw ProfileCatalogError.unavailable }
    let catalogue: [[String: Any]] = try models.map { model in
        guard let id = model["id"] as? String, !id.isEmpty, id.count < 200,
              let label = model["display_name"] as? String, !label.isEmpty, label.count < 200 else { throw ProfileCatalogError.unavailable }
        var entry: [String: Any] = ["name": id, "labelOverride": label, "maxEffort": "max"]
        if let family = model["anthropic_family_tier"] as? String, ["sonnet", "opus", "haiku"].contains(family), model["is_family_default"] as? Bool == true {
            entry["anthropicFamilyTier"] = family; entry["isFamilyDefault"] = true
        }
        return entry
    }
    let path = URL(fileURLWithPath: dataDirectory + "-3p/configLibrary/" + profileId + ".json")
    let previous = try Data(contentsOf: path)
    guard var profile = try JSONSerialization.jsonObject(with: previous) as? [String: Any],
          profile["inferenceProvider"] as? String == "gateway",
          profile["inferenceGatewayBaseUrl"] as? String == "http://127.0.0.1:18765" else { throw ProfileCatalogError.invalidProfile }
    profile["inferenceModels"] = catalogue
    profile["inferenceGatewayApiKey"] = String(authorization.dropFirst(7))
    let updated = try JSONSerialization.data(withJSONObject: profile, options: [.prettyPrinted, .sortedKeys])
    guard try Data(contentsOf: path) == previous else { throw ProfileCatalogError.concurrentChange }
    try updated.write(to: path, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
}
