#!/usr/bin/env python3
from pathlib import Path
import fcntl
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ARCH = sys.argv[1] if len(sys.argv) > 1 else 'arm64'
if ARCH not in ('arm64', 'x86_64'):
    raise SystemExit('Use arm64 or x86_64')

def require(value, message):
    if not value:
        raise RuntimeError(message)

def checksum(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()

def fetch(kind, entry, output, cache):
    url, expected = entry['archiveURL'], entry['sha256']
    require(re.fullmatch(r'[0-9a-f]{64}', expected), 'Invalid dependency checksum')
    require(url.startswith('https://nodejs.org/dist/') if kind == 'node' else url.startswith('https://github.com/router-for-me/CLIProxyAPI/releases/download/'), 'Unexpected dependency source')
    archive = cache / url.rsplit('/', 1)[1]
    require(not archive.is_symlink(), 'Dependency archive must not be a symlink')
    if not archive.exists():
        with tempfile.TemporaryDirectory(prefix='.download-', dir=cache) as temporary:
            target = Path(temporary) / archive.name
            request = urllib.request.Request(url, headers={'User-Agent': 'ClaudeCodex-build'})
            with urllib.request.urlopen(request, timeout=60) as response, target.open('wb') as stream:
                shutil.copyfileobj(response, stream)
            require(checksum(target) == expected, 'Dependency download checksum mismatch')
            target.rename(archive)
    require(archive.is_file() and checksum(archive) == expected, 'Dependency archive checksum mismatch')
    prefix = archive.name.removesuffix('.tar.xz')
    members = {f'{prefix}/bin/node': 'node', f'{prefix}/LICENSE': 'NODE-LICENSE'} if kind == 'node' else {'cli-proxy-api': 'cli-proxy-api', 'LICENSE': 'CLIPROXYAPI-LICENSE'}
    with tarfile.open(archive) as stream:
        by_name = {}
        for member in stream.getmembers():
            name = member.name.removeprefix('./')
            if name in members:
                require(name not in by_name and member.isfile(), 'Unexpected dependency archive entry')
                by_name[name] = member
        require(set(by_name) == set(members), 'Missing dependency archive entry')
        for name, target_name in members.items():
            target = output / target_name
            require(not target.is_symlink(), 'Dependency output must not be a symlink')
            with stream.extractfile(by_name[name]) as original, target.open('wb') as destination:
                shutil.copyfileobj(original, destination)
            target.chmod(0o755 if target_name in ('node', 'cli-proxy-api') else 0o644)
    return {'kind': kind, 'architecture': ARCH, 'url': url, 'sha256': expected}

try:
    config = json.loads((ROOT / 'dependencies.json').read_text())
    require(config.get('schemaVersion') == 1, 'Unsupported dependency manifest')
    cache = ROOT / '.cache' / ARCH
    output = ROOT / 'build' / 'dependencies' / ARCH
    require(not cache.is_symlink() and not output.is_symlink(), 'Dependency directories must not be symlinks')
    cache.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    with (cache / '.runtime.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        provenance = [fetch(kind, config['runtime'][kind]['archives'][ARCH], output, cache) for kind in ('node', 'proxy')]
        (output / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(f'Verified runtime dependencies: {ARCH}')
except (RuntimeError, OSError, ValueError, KeyError, tarfile.TarError) as error:
    raise SystemExit(f'Dependency verification failed: {error}')
