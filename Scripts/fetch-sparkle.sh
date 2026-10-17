#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

/usr/bin/python3 - <<'PY'
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import urllib.request

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def digest(stream):
    result = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        result.update(block)
    return result.hexdigest()

def archive_entries(archive):
    entries = {}
    for member in archive.getmembers():
        name = member.name[2:] if member.name.startswith("./") else member.name
        path = PurePosixPath(name)
        require(path.parts and not path.is_absolute() and ".." not in path.parts and "\\" not in name, "Unsafe Sparkle archive path")
        require(name == str(path) and path not in entries, "Duplicate or noncanonical Sparkle archive member")
        require(member.isfile() or member.isdir() or member.issym(), "Unsupported Sparkle archive member")
        if member.issym():
            target = PurePosixPath(member.linkname)
            require(not target.is_absolute() and ".." not in target.parts and "\\" not in member.linkname, "Unsafe Sparkle archive symlink")
        entries[path] = member
    for path in entries:
        require(all(parent not in entries or entries[parent].isdir() for parent in path.parents if parent.parts), "Sparkle archive member traverses a file or symlink")
    return entries

def verify_extracted(directory, archive, entries):
    expected = set(entries)
    expected.update(parent for path in entries for parent in path.parents if parent.parts)
    actual = {PurePosixPath(str(path.relative_to(directory))) for path in directory.rglob("*")}
    require(actual == expected, "Extracted Sparkle cache differs from its pinned archive; remove the cache directory and retry")
    for path in expected - set(entries):
        target = directory / str(path)
        require(target.is_dir() and not target.is_symlink(), f"Invalid Sparkle directory: {path}")
    for path, member in entries.items():
        target = directory / str(path)
        if member.isdir():
            require(target.is_dir() and not target.is_symlink(), f"Invalid Sparkle directory: {path}")
        elif member.issym():
            require(target.is_symlink() and os.readlink(target) == member.linkname, f"Invalid Sparkle symlink: {path}")
            require(target.resolve(strict=True).is_relative_to(directory.resolve()), f"Escaping Sparkle symlink: {path}")
        else:
            require(stat.S_ISREG(target.lstat().st_mode), f"Invalid Sparkle file: {path}")
            require((target.stat().st_mode & 0o777) == (member.mode & 0o777), f"Changed Sparkle file permissions: {path}")
            with target.open("rb") as current, archive.extractfile(member) as original:
                require(digest(current) == digest(original), f"Changed Sparkle cache file: {path}")

try:
    root = Path.cwd()
    configuration = json.loads((root / "dependencies.json").read_text())
    require(configuration.get("schemaVersion") == 1, "Unsupported dependency manifest")
    dependency = configuration["sparkle"]
    version = dependency["version"]
    require(re.fullmatch(r"\d+\.\d+\.\d+", version), "Invalid Sparkle version")
    filename = f"Sparkle-{version}.tar.xz"
    require(dependency["archiveURL"] == f"https://github.com/sparkle-project/Sparkle/releases/download/{version}/{filename}", "Sparkle must come from its pinned official release")
    require(re.fullmatch(r"[0-9a-f]{64}", dependency["sha256"]), "Invalid Sparkle checksum")
    cache = root / "build/dependencies"
    cache.mkdir(parents=True, exist_ok=True)
    require(not cache.is_symlink(), "Sparkle cache must not be a symlink")
    with (cache / ".sparkle.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        archive_path = cache / filename
        require(not archive_path.is_symlink(), "Sparkle archive must not be a symlink")
        if not archive_path.exists():
            with tempfile.TemporaryDirectory(prefix=".sparkle-download-", dir=cache) as temporary:
                download = Path(temporary) / filename
                request = urllib.request.Request(dependency["archiveURL"], headers={"User-Agent": "ClaudeCodex-build"})
                with urllib.request.urlopen(request, timeout=60) as response, download.open("wb") as output:
                    shutil.copyfileobj(response, output)
                with download.open("rb") as stream:
                    require(digest(stream) == dependency["sha256"], "Sparkle download checksum mismatch")
                download.rename(archive_path)
        require(archive_path.is_file(), "Sparkle archive must be a regular file")
        with archive_path.open("rb") as stream:
            require(digest(stream) == dependency["sha256"], "Sparkle archive checksum mismatch")
        destination = cache / f"Sparkle-{version}"
        require(not destination.is_symlink(), "Extracted Sparkle cache must not be a symlink")
        with tarfile.open(archive_path, "r:xz") as archive:
            entries = archive_entries(archive)
            if not destination.exists():
                with tempfile.TemporaryDirectory(prefix=".sparkle-extract-", dir=cache) as temporary:
                    extracted = Path(temporary) / "distribution"
                    extracted.mkdir()
                    archive.extractall(extracted)
                    verify_extracted(extracted, archive, entries)
                    extracted.rename(destination)
            verify_extracted(destination, archive, entries)
        print(destination)
except (RuntimeError, OSError, ValueError, KeyError, tarfile.TarError) as error:
    print(f"Sparkle dependency verification failed: {error}", file=sys.stderr)
    sys.exit(1)
PY
