#!/usr/bin/env python3
"""Download only pinned, checksum-verified public dependencies."""
from pathlib import Path
import hashlib, json, shutil, sys, tarfile, urllib.request
ROOT = Path(__file__).resolve().parents[1]
ARCH = sys.argv[1] if len(sys.argv) > 1 else 'arm64'
if ARCH not in ('arm64', 'x86_64'): raise SystemExit('Use arm64 or x86_64')
VERSIONS = {
 'arm64': [
  ('https://nodejs.org/dist/v22.23.3/node-v22.23.3-darwin-arm64.tar.xz', '72d5d8832b41c9d9646197af614ffd751406ea4d215060eb91b98864e1919a3e', 'node'),
  ('https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.32/CLIProxyAPI_8.0.32_darwin_aarch64.tar.gz', '48fe6a391a01e730ee6ebe3f1609ff92578a97a7a9a44579013ca8f3a6d58d51', 'proxy')],
 'x86_64': [
  ('https://nodejs.org/dist/v22.23.3/node-v22.23.3-darwin-x64.tar.xz', 'ac41874c3352937119cfec39e1a98c578fe58ce8a86d7e785b89a4706015f305', 'node'),
  ('https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.32/CLIProxyAPI_8.0.32_darwin_amd64.tar.gz', 'c327f421d995692f6590a752abd449db5e71df61803b7041e4d3bd59cd1e1bd8', 'proxy')]
}
cache = ROOT/'.cache'/ARCH; cache.mkdir(parents=True, exist_ok=True)
out = ROOT/'build'/'dependencies'/ARCH; out.mkdir(parents=True, exist_ok=True)
for url, digest, kind in VERSIONS[ARCH]:
 archive = cache/url.rsplit('/', 1)[1]
 if not archive.exists():
  temporary = archive.with_suffix('.download')
  with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as target: shutil.copyfileobj(response, target)
  temporary.replace(archive)
 if hashlib.sha256(archive.read_bytes()).hexdigest() != digest: raise SystemExit('Checksum mismatch: '+archive.name)
 extracted = cache/kind
 if not extracted.exists():
  extracted.mkdir()
  with tarfile.open(archive) as tar: tar.extractall(extracted, filter='data')
 if kind == 'node':
  top = next(extracted.iterdir()); shutil.copy2(top/'bin'/'node', out/'node'); shutil.copy2(top/'LICENSE', out/'NODE-LICENSE')
 else:
  shutil.copy2(extracted/'cli-proxy-api', out/'cli-proxy-api'); shutil.copy2(extracted/'LICENSE', out/'CLIPROXYAPI-LICENSE')
 print('Verified', archive.name)
(out/'provenance.json').write_text(json.dumps([{'url':u,'sha256':d} for u,d,k in VERSIONS[ARCH]], indent=2)+'\n')
