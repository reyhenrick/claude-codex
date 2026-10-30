#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/tests
/usr/bin/ditto Resources build/tests/Resources
npm --prefix Bridge test
python3 Tests/test_app_bundle.py
python3 Tests/test_documentation_cleanup.py
python3 Scripts/check-localizations.py
xcrun swiftc -parse-as-library Sources/Localization.swift Tests/LocalizationTests.swift -o build/tests/localization-tests
build/tests/localization-tests Resources
xcrun swiftc -parse-as-library Sources/UpdatePolicy.swift Tests/UpdatePolicyTests.swift -o build/tests/update-policy-tests
build/tests/update-policy-tests
xcrun swiftc Sources/BridgeAuthorization.swift Tests/BridgeAuthorizationTests.swift -o build/tests/bridge-authorization-tests
build/tests/bridge-authorization-tests
xcrun swiftc -parse-as-library Sources/Localization.swift Sources/BridgeAuthorization.swift Sources/ServiceReadiness.swift Sources/Models.swift Sources/SetupModel.swift Sources/AccountsModel.swift Tests/AccountsModelTests.swift -o build/tests/account-model-tests
build/tests/account-model-tests
node Scripts/profile-catalog-fixture.mjs build/tests/profile-catalog-response.json
xcrun swiftc Sources/BridgeAuthorization.swift Launcher/ProfileCatalog.swift Tests/ProfileCatalogTests.swift -o build/tests/profile-catalog-tests
build/tests/profile-catalog-tests build/tests/profile-catalog-response.json
xcrun swiftc Scripts/verify-update.swift -o build/tests/verify-update
xcrun swiftc -parse-as-library Tests/UpdateSignatureTests.swift -o build/tests/update-signature-tests
build/tests/update-signature-tests build/tests/verify-update
