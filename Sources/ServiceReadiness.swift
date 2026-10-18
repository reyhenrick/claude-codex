import Foundation

struct ServiceIdentity: Decodable, Equatable {
    let build: String
    let protocolVersion: Int
    let resources: String?

    enum CodingKeys: String, CodingKey {
        case build, resources
        case protocolVersion = "protocol"
    }
}

struct ServiceReadiness: Decodable, Equatable {
    enum Status: String, Decodable {
        case ready, pending, legacy, conflict, unavailable
    }

    let status: Status
    let expectedBuild: String?
    let activeBuild: String?
    let protocolVersion: Int?

    enum CodingKeys: String, CodingKey {
        case status, expectedBuild, activeBuild
        case protocolVersion = "protocol"
    }

    var isReady: Bool { status == .ready }
    var isPending: Bool { status == .pending }
    static let expectedProtocol = 1
    static var expectedResources: String? {
        guard Bundle.main.bundleURL.pathExtension == "app" else { return nil }
        return Bundle.main.resourceURL?.resolvingSymlinksInPath().path
    }
    static var expectedBuild: String? {
        guard let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
              validBuild(build) else { return nil }
        return build
    }

    static func isCurrent(_ identity: ServiceIdentity?, draining: Bool,
                          expectedBuild: String? = ServiceReadiness.expectedBuild) -> Bool {
        guard !draining, let expectedBuild, validBuild(expectedBuild), let identity,
              validBuild(identity.build) else { return false }
        return identity.build == expectedBuild && identity.protocolVersion == expectedProtocol
            && (expectedResources == nil || identity.resources == expectedResources)
    }

    private static func validBuild(_ build: String) -> Bool {
        !build.isEmpty && build.count <= 40 && build.utf8.allSatisfy { (48...57).contains($0) || $0 == 46 }
            && build.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty }
    }
}
