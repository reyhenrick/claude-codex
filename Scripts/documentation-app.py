#!/usr/bin/env python3
"""Run the built Claude Codex app against synthetic accounts for real screenshots."""

import argparse
import fcntl
import plistlib
import select
import shutil
import subprocess
from pathlib import Path


def stop(process):
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("language", choices=("en", "pt", "es", "fr", "de", "it"), nargs="?", default="en")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    source = root / "build/Claude Codex.app/Contents"
    if not (source / "MacOS/ClaudeCodex").is_file():
        parser.error("Run ./build.sh first. This script uses the real compiled app, not a rendered preview.")
    workspace = root / "build/documentation-capture"
    workspace.mkdir(parents=True, exist_ok=True)
    with (workspace / "capture.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error("Another documentation capture is already running.")
        app = workspace / "Claude Codex Documentation.app"
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


if __name__ == "__main__":
    main()
