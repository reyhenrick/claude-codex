#!/usr/bin/env python3
"""Run the built Claude Codex app against synthetic accounts for real screenshots."""

import argparse
import fcntl
import plistlib
import os
import select
import shutil
import subprocess
from pathlib import Path
from app_bundle import in_use


def stop(process):
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def cleanup_preview(app, expected_identity, run_command=subprocess.run, activity=in_use):
    def unchanged():
        if not app.exists() or app.is_symlink():
            return False
        info = app.lstat()
        return (info.st_dev, info.st_ino, info.st_uid) == expected_identity

    if not unchanged():
        return False
    if activity(app):
        return False
    info_path = app / "Contents/Info.plist"
    if not info_path.is_file():
        return False
    current = plistlib.loads(info_path.read_bytes())
    if current.get("CFBundleIdentifier") != "com.henrick.claude-codex.documentation":
        return False
    run_command(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-u", str(app)],
                capture_output=True, timeout=15)
    if not unchanged():
        return False
    if activity(app):
        return False
    shutil.rmtree(app)
    return True


def ensure_preview_destination(app, activity=in_use):
    if not app.exists() and not app.is_symlink():
        return
    if app.is_symlink() or app.lstat().st_uid != os.getuid():
        raise RuntimeError("The preview destination is not owned by this capture; its files were preserved.")
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != "com.henrick.claude-codex.documentation" or activity(app):
        raise RuntimeError("The preview destination is foreign or still in use; its files were preserved.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("language", choices=("en", "pt", "es", "fr", "de", "it"), nargs="?", default="en")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    source = root / "build/products.noindex/Claude Codex.app/Contents"
    if not (source / "MacOS/ClaudeCodex").is_file():
        parser.error("Run ./build.sh first. This script uses the real compiled app, not a rendered preview.")
    workspace = root / "build/documentation-capture.noindex"
    if workspace.is_symlink():
        parser.error("The documentation workspace must not be a symbolic link.")
    workspace.mkdir(parents=True, exist_ok=True)
    with (workspace / "capture.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error("Another documentation capture is already running.")
        app = workspace / "Claude Codex Documentation.app"
        ensure_preview_destination(app)
        target = app / "Contents"
        (target / "MacOS").mkdir(parents=True, exist_ok=True)
        (target / "Resources").mkdir(exist_ok=True)
        shutil.copy2(source / "MacOS/ClaudeCodex", target / "MacOS/ClaudeCodex")
        shutil.copytree(source / "Frameworks", target / "Frameworks", dirs_exist_ok=True)
        for language in ("en", "pt", "es", "fr", "de", "it"):
            shutil.copytree(source / f"Resources/{language}.lproj", target / f"Resources/{language}.lproj", dirs_exist_ok=True)
        shutil.copy2(source / "Resources/Accounts.icns", target / "Resources/Accounts.icns")
        info = plistlib.loads((source / "Info.plist").read_bytes())
        info.update(CFBundleIdentifier="com.henrick.claude-codex.documentation",
                    CFBundleName="Claude Codex Documentation", CFBundleDisplayName="Claude Codex Documentation")
        (target / "Info.plist").write_bytes(plistlib.dumps(info))
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(app)], check=True, capture_output=True)
        prepared = app.lstat()
        prepared_identity = (prepared.st_dev, prepared.st_ino, prepared.st_uid)

        server = application = None
        try:
            server = subprocess.Popen([str(source / "Resources/bin/node"), str(root / "Scripts/documentation/fixture-server.mjs")],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            ready, _, _ = select.select([server.stdout], [], [], 10)
            line = server.stdout.readline() if ready else ""
            if not line.startswith("Synthetic account fixture ready;"):
                stop(server)
                raise RuntimeError("The synthetic server could not start. Check that loopback port 18769 is free.")
            application = subprocess.Popen([str(target / "MacOS/ClaudeCodex"), "--staging", "--show",
                                            "-AppleLanguages", f"({args.language})"])
            print(f"Real app running with synthetic accounts: app PID {application.pid}, fixture PID {server.pid}.", flush=True)
            print("Capture only its Claude Codex window. Quit through App options when finished.", flush=True)
            application.wait()
        finally:
            stop(application)
            stop(server)
            cleanup_preview(app, prepared_identity)


if __name__ == "__main__":
    main()
