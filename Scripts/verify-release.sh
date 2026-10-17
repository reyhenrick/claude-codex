#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

/usr/bin/python3 - "$@" <<'PY'
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import subprocess
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone
import zipfile

ROOT = Path.cwd()
ARCHITECTURES = {"arm64", "x86_64"}
PRIVATE_NAMES = {".git", ".codex", ".claude", ".env", ".idea", ".vscode", ".build", ".swiftpm", "build", "dist", "work", "installed-backups", "__pycache__", "tests", "Tests", "fixtures", "auth.json", "config.yaml", "config.yml", "accounts.json", "pool.json", "credentials.json", "cookies.json"}
ARTIFACTS = {"ClaudeCodex-macOS.dmg", "ClaudeCodex-macOS.zip", "release-metadata.json", "SHA256SUMS.txt"}
FEED_URL = "https://github.com/reyhenrick/codex-accounts/releases/latest/download/appcast.xml"
FRAMEWORK = PurePosixPath("Contents/Frameworks/Sparkle.framework")
SPARKLE_LINKS = {
    "Autoupdate": "Versions/Current/Autoupdate",
    "Headers": "Versions/Current/Headers",
    "Modules": "Versions/Current/Modules",
    "PrivateHeaders": "Versions/Current/PrivateHeaders",
    "Resources": "Versions/Current/Resources",
    "Sparkle": "Versions/Current/Sparkle",
    "Updater.app": "Versions/Current/Updater.app",
    "Versions/Current": "B",
    "XPCServices": "Versions/Current/XPCServices",
}
APP_LINKS = {str(FRAMEWORK / name): target for name, target in SPARKLE_LINKS.items()}

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def command(arguments, required=True):
    result = subprocess.run(arguments, capture_output=True, text=True)
    if required and result.returncode:
        raise RuntimeError(f"{arguments[0]} failed: {(result.stderr or result.stdout).strip()}")
    return result

def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()

def private_path(path):
    return any(part in PRIVATE_NAMES or part.startswith(".env.") or part.endswith((".p12", ".p8", ".pem", ".key", ".mobileprovision")) or part.endswith(".test.mjs") or ".keychain" in part for part in path.parts)

def read_plist(path):
    with path.open("rb") as stream:
        return plistlib.load(stream)

def trusted_update_key():
    info = read_plist(ROOT / "Info.plist")
    key = info.get("SUPublicEDKey", "")
    require(isinstance(key, str) and len(base64.b64decode(key, validate=True)) == 32, "Repository Info.plist must contain a valid Ed25519 public key")
    require(info.get("SUFeedURL") == FEED_URL, "Repository Info.plist must use the canonical update feed")
    return key

def verify_signed_update(feed, archive, key, build_number, version):
    require(feed.is_file() and not feed.is_symlink(), "Signed update feed must be a regular file")
    command(["xcrun", "swift", str(ROOT / "Scripts/verify-update.swift"), str(feed), str(archive), key, str(build_number), version])

def updater_configuration(contents, info):
    key = trusted_update_key()
    require(info.get("SUPublicEDKey") == key, "Bundled update key differs from trusted repository configuration")
    require(info.get("SUFeedURL") == FEED_URL, "Unexpected update feed URL")
    for setting in ("SUVerifyUpdateBeforeExtraction", "SURequireSignedFeed", "SUEnableAutomaticChecks"):
        require(info.get(setting) is True, f"Required update setting is disabled: {setting}")
    require(info.get("SUScheduledCheckInterval") == 86400, "Update checks must be scheduled daily")
    require(isinstance(info.get("SUAutomaticallyUpdate"), bool), "Automatic download preference must be an explicit Boolean")
    require(info.get("SUSignedFeedFailureExpirationInterval") == 0, "Signed feed verification failures must not expire")
    for setting in ("SUEnableJavaScript", "SUEnableSystemProfiling"):
        require(info.get(setting, False) is False, f"Unexpected update setting enabled: {setting}")
    pin = json.loads((contents / "Resources/dependencies.json").read_text())
    require(pin == json.loads((ROOT / "dependencies.json").read_text()) and pin.get("schemaVersion") == 1, "Bundled dependency pin differs from the build manifest")
    framework = contents / "Frameworks/Sparkle.framework"
    framework_info = read_plist(framework / "Versions/B/Resources/Info.plist")
    require(framework_info.get("CFBundleIdentifier") == "org.sparkle-project.Sparkle", "Unexpected Sparkle framework identifier")
    require(framework_info.get("CFBundleShortVersionString") == pin["sparkle"]["version"], "Bundled Sparkle version differs from the build pin")
    require(framework_info.get("LSMinimumSystemVersion") == "12.0", "Unexpected Sparkle deployment target")
    require(digest(contents / "Resources/Sparkle-LICENSE.txt") == digest(ROOT / "Resources/Sparkle-LICENSE.txt"), "Bundled Sparkle license differs from its upstream notice")
    return {
        "frameworkVersion": framework_info["CFBundleShortVersionString"],
        "buildDependencyPin": pin["sparkle"],
        "publicEDKey": key,
        "feedURL": info["SUFeedURL"],
        "verifyBeforeExtraction": info["SUVerifyUpdateBeforeExtraction"],
        "requireSignedFeed": info["SURequireSignedFeed"],
        "signedFeedFailureExpirationInterval": info["SUSignedFeedFailureExpirationInterval"],
        "automaticChecks": info["SUEnableAutomaticChecks"],
        "automaticDownloads": info["SUAutomaticallyUpdate"],
        "scheduledCheckInterval": info["SUScheduledCheckInterval"],
        "javaScript": info.get("SUEnableJavaScript", False),
        "systemProfiling": info.get("SUEnableSystemProfiling", False),
    }

def signature(path, architecture=None, required=True):
    args = ["codesign", "-dv", "--verbose=4"]
    if architecture:
        args.extend(["--arch", architecture])
    result = command(args + [str(path)], required=required)
    if result.returncode:
        require("code object is not signed at all" in result.stderr, f"Could not inspect signature: {path.name}")
        return {"mode": "unsigned"}
    output = result.stderr + result.stdout
    adhoc = "Signature=adhoc" in output
    authority = re.search(r"^Authority=(.+)$", output, re.MULTILINE)
    team = re.search(r"^TeamIdentifier=(.+)$", output, re.MULTILINE)
    hardened = bool(re.search(r"flags=.*\([^)]*runtime[^)]*\)", output))
    timestamped = bool(re.search(r"^Timestamp=", output, re.MULTILINE))
    require(adhoc or (authority and authority.group(1).startswith("Developer ID Application:")), f"Unsupported distribution signature: {path.name}")
    return {
        "mode": "ad-hoc" if adhoc else "developer-id",
        "authority": authority.group(1) if authority else None,
        "teamIdentifier": team.group(1) if team and team.group(1) != "not set" else None,
        "hardenedRuntime": hardened,
        "secureTimestamp": timestamped,
    }

def verify_app(app):
    require(app.is_dir() and not app.is_symlink(), f"Application is missing or linked: {app}")
    require({p.name for p in app.iterdir()} == {"Contents"}, "Unexpected files beside Contents in the application")
    contents = app / "Contents"
    require({p.name for p in contents.iterdir()} == {"Info.plist", "MacOS", "Resources", "Frameworks", "_CodeSignature"}, "Unexpected application bundle contents")
    require({p.name for p in (contents / "Frameworks").iterdir()} == {"Sparkle.framework"}, "Unexpected embedded framework")
    links = {}
    for path in app.rglob("*"):
        relative = path.relative_to(app)
        if path.is_symlink():
            target = os.readlink(path)
            require(APP_LINKS.get(str(relative)) == target, f"Unexpected application symlink: {relative}")
            require(path.resolve(strict=True).is_relative_to((app / str(FRAMEWORK)).resolve()), f"Escaping framework symlink: {relative}")
            links[str(relative)] = target
        else:
            require(path.is_file() or path.is_dir(), f"Unexpected application file type: {relative}")
        require(not private_path(relative), f"Private file or directory in application: {relative}")
        require(path.name != ".DS_Store", f"Finder state in application: {relative}")
    require(links == APP_LINKS, "Missing canonical Sparkle framework symlinks")
    info = read_plist(contents / "Info.plist")
    require(info.get("CFBundleIdentifier") == "com.henrick.codex-accounts", "Unexpected bundle identifier")
    require(info.get("CFBundleName") == info.get("CFBundleDisplayName") == "Claude Codex" and info.get("CFBundleExecutable") == "ClaudeCodex", "Unexpected application naming")
    require(info.get("LSMinimumSystemVersion") == "26.0", "Bundle minimum macOS version must be 26.0")
    version = info.get("CFBundleShortVersionString", "")
    require(re.fullmatch(r"\d+\.\d+\.\d+", version), "Use a three-part release version in Info.plist")
    build_number = info.get("CFBundleVersion", "")
    require(isinstance(build_number, str) and re.fullmatch(r"[1-9]\d*", build_number), "Use a positive integer bundle version in Info.plist")
    resources = contents / "Resources"
    for name in ["Licenses/LICENSE", "Sparkle-LICENSE.txt", "Licenses/THIRD_PARTY_NOTICES.md", "Licenses/NODE-LICENSE", "Licenses/CLIPROXYAPI-LICENSE", "dependencies.json", "Accounts.icns", "provenance.json", "Bridge/setup.mjs", "Bridge/pool-service.mjs", "Bridge/package-lock.json", "Bridge/node_modules/bcryptjs/LICENSE"]:
        require((resources / name).is_file(), f"Missing bundled resource: {name}")
    for locale in ("en", "pt", "es", "fr", "de", "it"):
        strings = resources / f"{locale}.lproj/Localizable.strings"
        require(strings.is_file(), f"Missing bundled language: {locale}")
        command(["plutil", "-lint", str(strings)])
    require(info.get("CFBundleDevelopmentRegion") == "en" and info.get("CFBundleLocalizations") == ["en", "pt", "es", "fr", "de", "it"], "Unexpected localization configuration")
    require({path.name for path in (resources / "Bridge/node_modules").iterdir()} == {"bcryptjs"}, "Unexpected bundled npm dependency")
    source_modules = {path.name for path in (ROOT / "Bridge").glob("*.mjs") if not path.name.endswith(".test.mjs")}
    bundled_modules = {path.name for path in (resources / "Bridge").glob("*.mjs")}
    require(source_modules == bundled_modules, "Bundled Bridge modules differ from the source manifest")
    require({path.name for path in (resources / "Bridge").iterdir()} == source_modules | {"package.json", "package-lock.json", "node_modules"}, "Unexpected bundled Bridge resource")
    pin = json.loads((ROOT / "dependencies.json").read_text())
    expected_provenance = [{"kind": kind, "architecture": arch, "url": pin["runtime"][kind]["archives"][arch]["archiveURL"], "sha256": pin["runtime"][kind]["archives"][arch]["sha256"]} for arch in ("arm64", "x86_64") for kind in ("node", "proxy")]
    require(json.loads((resources / "provenance.json").read_text()) == expected_provenance, "Runtime provenance does not match pinned distributions")
    command(["plutil", "-lint", str(contents / "Info.plist")])
    updater = updater_configuration(contents, info)
    signatures = []
    executables = {"MacOS/ClaudeCodex": "26.0", "Resources/bin/ClaudeLauncher": "26.0", "Resources/bin/BridgeService": "26.0", "Resources/bin/node": None, "Resources/bin/cli-proxy-api": None}
    executables.update({f"Frameworks/Sparkle.framework/Versions/B/{relative}": "12.0" for relative in (
        "Sparkle", "Autoupdate", "Updater.app/Contents/MacOS/Updater",
        "XPCServices/Installer.xpc/Contents/MacOS/Installer", "XPCServices/Downloader.xpc/Contents/MacOS/Downloader",
    )})
    for relative, minimum in executables.items():
        executable = contents / relative
        require(executable.is_file() and os.access(executable, os.X_OK), f"Missing executable: {relative}")
        architectures = command(["xcrun", "lipo", "-archs", str(executable)]).stdout.split()
        require(set(architectures) == ARCHITECTURES, f"{relative} is not universal arm64 + x86_64")
        for architecture in sorted(ARCHITECTURES):
            build = command(["xcrun", "vtool", "-arch", architecture, "-show-build", str(executable)]).stdout
            if minimum is not None:
                require(re.search(r"platform\s+MACOS\b", build) and re.search(rf"minos\s+{re.escape(minimum)}(?:\.0)?\s", build), f"Incorrect deployment target for {relative} ({architecture})")
            else:
                require(re.search(r"platform\s+MACOS\b|LC_VERSION_MIN_MACOSX", build), f"Runtime is not a macOS executable: {relative}")
                match = re.search(r"(?:minos|version)\s+(\d+)(?:\.(\d+))?", build)
                require(match and (int(match.group(1)), int(match.group(2) or 0)) <= (26, 0), f"Runtime requires a newer macOS: {relative}")
            signatures.append(signature(executable, architecture))
        command(["codesign", "--verify", "--strict", "--all-architectures", str(executable)])
    require(all(value == signatures[0] for value in signatures), "Application, launcher, runtimes, and Sparkle signatures differ")
    if signatures[0]["mode"] == "developer-id":
        require(signatures[0]["hardenedRuntime"] and signatures[0]["secureTimestamp"], "Developer ID binaries require hardened runtime and a secure timestamp")
    else:
        require(not signatures[0]["hardenedRuntime"], "Ad-hoc builds must not enable hardened library validation")
    linked = command(["xcrun", "otool", "-L", str(contents / "MacOS/ClaudeCodex")]).stdout
    require("@rpath/Sparkle.framework/Versions/B/Sparkle" in linked, "Application does not link the embedded Sparkle framework")
    commands = command(["xcrun", "otool", "-l", str(contents / "MacOS/ClaudeCodex")]).stdout
    require(re.search(r"cmd LC_RPATH\s+cmdsize \d+\s+path @executable_path/\.\./Frameworks \(offset", commands), "Missing application Frameworks runtime path")
    command(["codesign", "--verify", "--deep", "--strict", "--all-architectures", str(app)])
    return {"name": "Claude Codex", "version": version, "buildNumber": build_number, "bundleIdentifier": info["CFBundleIdentifier"], "minimumMacOS": "26.0", "architectures": sorted(ARCHITECTURES), "signing": signatures[0], "updater": updater}

def notarization(app, dmg, mode):
    app_ticket = command(["xcrun", "stapler", "validate", str(app)], required=False).returncode == 0
    dmg_ticket = command(["xcrun", "stapler", "validate", str(dmg)], required=False).returncode == 0
    status = "stapled-ticket-validated" if app_ticket or dmg_ticket else ("not-notarized" if mode == "ad-hoc" else "not-verified")
    return {"status": status, "submittedByPackaging": False, "appStapledTicketValid": app_ticket, "diskImageStapledTicketValid": dmg_ticket}

def metadata(app, dmg, archive, feed=None):
    application = verify_app(app)
    artifacts = [dmg, archive]
    if feed is not None:
        verify_signed_update(feed, archive, application["updater"]["publicEDKey"], application["buildNumber"], application["version"])
        artifacts.append(feed)
    return {
        "schemaVersion": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sourceStateAtPackaging": {
            "buildProvenanceAttested": False,
        },
        "packagingXcode": command(["xcodebuild", "-version"]).stdout.strip(),
        "application": application,
        "diskImageSigning": signature(dmg, required=False),
        "notarization": notarization(app, dmg, application["signing"]["mode"]),
        "updates": {"status": "signed" if feed is not None else "unsigned-local-packages", "signedFeedIncluded": feed is not None},
        "artifacts": {path.name: {"sha256": digest(path), "bytes": path.stat().st_size} for path in artifacts},
    }

def fingerprint(app):
    result = {}
    for path in app.rglob("*"):
        if path.is_symlink():
            value = ["symlink", os.readlink(path)]
        elif path.is_file():
            value = ["file", digest(path), bool(path.stat().st_mode & 0o111)]
        else:
            value = ["directory"]
        result[str(path.relative_to(app))] = value
    return result

def validate_zip(archive):
    with zipfile.ZipFile(archive) as stream:
        members = {}
        normalized = {}
        links = {}
        for item in stream.infolist():
            with stream.open(item):
                pass
            path = PurePosixPath(item.filename)
            require(path.parts and not path.is_absolute() and ".." not in path.parts and "\\" not in item.filename and ":" not in item.filename, "Unsafe ZIP path")
            require(item.filename == str(path) + ("/" if item.is_dir() else ""), "Noncanonical ZIP path")
            normalized_name = unicodedata.normalize("NFD", str(path)).casefold()
            require(path not in members and normalized_name not in normalized, "Duplicate or filesystem-colliding ZIP member")
            members[path] = item
            normalized[normalized_name] = item
            require(path.parts[0] == "Claude Codex.app", f"Unexpected ZIP content: {path}")
            require(not private_path(path) and path.name != ".DS_Store", f"Private ZIP content: {path}")
            mode = item.external_attr >> 16
            if stat.S_ISLNK(mode):
                require(not item.is_dir() and item.file_size <= 256, f"Invalid ZIP symlink: {path}")
                target = stream.read(item).decode("utf-8")
                relative = str(path.relative_to("Claude Codex.app"))
                require(APP_LINKS.get(relative) == target, f"Unexpected ZIP symlink: {path}")
                links[relative] = target
            else:
                require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), f"Unsupported ZIP file type: {path}")
                require(not stat.S_ISDIR(mode) or item.is_dir(), f"Invalid ZIP directory: {path}")
        for path in members:
            for parent in path.parents:
                normalized_parent = unicodedata.normalize("NFD", str(parent)).casefold()
                require(normalized_parent not in normalized or normalized[normalized_parent].is_dir(), f"ZIP member traverses a file or symlink: {path}")
        require(links == APP_LINKS, "ZIP lacks the canonical Sparkle framework symlinks")

def verify_release(directory, require_feed=False):
    require(directory.is_dir(), f"Release directory is missing: {directory}")
    names = {path.name for path in directory.iterdir()}
    has_feed = "appcast.xml" in names
    expected_artifacts = ARTIFACTS | ({"appcast.xml"} if has_feed else set())
    require(names == expected_artifacts, "Release directory must contain exactly DMG, ZIP, SHA256SUMS.txt, release-metadata.json and an optional signed appcast.xml")
    require(not require_feed or has_feed, "Publishing requires a signed appcast.xml; run Scripts/sign-release.sh first")
    require(all(path.is_file() and not path.is_symlink() for path in directory.iterdir()), "Release artifacts must be regular files")
    checksums = {}
    for line in (directory / "SHA256SUMS.txt").read_text().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (ClaudeCodex-macOS\.(?:dmg|zip)|release-metadata\.json|appcast\.xml)", line)
        require(match and match.group(2) not in checksums, "Invalid or duplicate checksum entry")
        checksums[match.group(2)] = match.group(1)
    require(set(checksums) == expected_artifacts - {"SHA256SUMS.txt"}, "Missing release checksums")
    for name, expected in checksums.items():
        require(digest(directory / name) == expected, f"Checksum mismatch: {name}")
    record = json.loads((directory / "release-metadata.json").read_text())
    require(record.get("schemaVersion") == 1, "Unsupported release metadata schema")
    dmg = directory / "ClaudeCodex-macOS.dmg"
    archive = directory / "ClaudeCodex-macOS.zip"
    artifacts = [dmg, archive] + ([directory / "appcast.xml"] if has_feed else [])
    require(record["artifacts"] == {path.name: {"sha256": digest(path), "bytes": path.stat().st_size} for path in artifacts}, "Artifact metadata does not match downloads")
    require(record.get("updates") == {"status": "signed" if has_feed else "unsigned-local-packages", "signedFeedIncluded": has_feed}, "Update signing metadata does not match release contents")
    if has_feed:
        verify_signed_update(directory / "appcast.xml", archive, trusted_update_key(), record["application"]["buildNumber"], record["application"]["version"])
    validate_zip(archive)
    command(["hdiutil", "verify", str(dmg)])
    with tempfile.TemporaryDirectory(prefix="claudecodex-verify-", dir=ROOT / "build") as temporary:
        temporary = Path(temporary)
        unpacked = temporary / "zip"
        unpacked.mkdir()
        command(["ditto", "-x", "-k", str(archive), str(unpacked)])
        require({path.name for path in unpacked.iterdir()} == {"Claude Codex.app"}, "Update ZIP must contain only Claude Codex.app")
        zip_app = unpacked / "Claude Codex.app"
        application = verify_app(zip_app)
        require(record["application"] == application, "Application metadata does not match ZIP")
        mount = temporary / "mount"
        mount.mkdir()
        attached = False
        try:
            command(["hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-owners", "off", "-mountpoint", str(mount), str(dmg)])
            attached = True
            expected = {"Claude Codex.app", "Applications", ".VolumeIcon.icns"}
            require({path.name for path in mount.iterdir()} == expected, "Unexpected disk image contents")
            applications = mount / "Applications"
            require(applications.is_symlink() and os.readlink(applications) == "/Applications", "Missing Applications shortcut in disk image")
            require(verify_app(mount / "Claude Codex.app") == application, "DMG application differs from ZIP")
            require(fingerprint(mount / "Claude Codex.app") == fingerprint(zip_app), "DMG and ZIP bundle files differ")
        finally:
            if attached:
                command(["hdiutil", "detach", str(mount)])
        require(record["diskImageSigning"] == signature(dmg, required=False), "Disk image signature metadata is incorrect")
        if record["diskImageSigning"]["mode"] != "unsigned":
            command(["codesign", "--verify", "--strict", str(dmg)])
        require(record["notarization"] == notarization(zip_app, dmg, application["signing"]["mode"]), "Notarization metadata is incorrect")
    print(f"Verified DMG and ZIP: Claude Codex {application['version']} (build {application['buildNumber']}), arm64 + x86_64, macOS 26.0+, {application['signing']['mode']}, notarization {record['notarization']['status']}, updates {record['updates']['status']}")

try:
    arguments = sys.argv[1:]
    (ROOT / "build").mkdir(exist_ok=True)
    if len(arguments) == 2 and arguments[0] == "--app":
        result = verify_app(Path(arguments[1]).absolute())
        print(f"Verified universal application: Claude Codex {result['version']} ({result['signing']['mode']})")
    elif len(arguments) in (4, 5) and arguments[0] == "--metadata":
        print(json.dumps(metadata(*(Path(path).absolute() for path in arguments[1:])), indent=2))
    elif len(arguments) in (1, 2) and arguments[0] == "--require-feed":
        verify_release(Path(arguments[1]).absolute() if len(arguments) == 2 else ROOT / "dist", require_feed=True)
    elif len(arguments) <= 1 and (not arguments or not arguments[0].startswith("-")):
        verify_release(Path(arguments[0]).absolute() if arguments else ROOT / "dist")
    else:
        raise RuntimeError("Usage: Scripts/verify-release.sh [dist-directory | --require-feed [dist-directory] | --app Claude Codex.app | --metadata Claude Codex.app file.dmg file.zip [appcast.xml]]")
except (RuntimeError, OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, plistlib.InvalidFileException) as error:
    print(f"Release verification failed: {error}", file=sys.stderr)
    sys.exit(1)
PY
