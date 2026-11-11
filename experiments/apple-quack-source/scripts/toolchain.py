#!/usr/bin/env python3
"""Retrieve exactly the official compiler release, bounded and checksum verified."""
import hashlib, re, tarfile, urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[1]
cache = root / '.cache'
cache.mkdir(exist_ok=True)
name = 'kotlin-native-prebuilt-macos-aarch64-2.4.21.tar.gz'
base = 'https://github.com/JetBrains/kotlin/releases/download/v2.4.21/'
archive = cache / name

with urllib.request.urlopen(base + name + '.sha256', timeout=30) as response:
    checksum = response.read(256).decode('ascii').strip()
if not re.fullmatch('[a-fA-F0-9]{64}', checksum):
    raise SystemExit('invalid official checksum')
if not archive.exists():
    with urllib.request.urlopen(base + name, timeout=30) as response, archive.open('wb') as output:
        size = 0
        while block := response.read(1024 * 1024):
            size += len(block)
            if size > 290_160_802: raise SystemExit('compiler download byte bound')
            output.write(block)
if archive.stat().st_size != 290_160_802 or hashlib.sha256(archive.read_bytes()).hexdigest() != checksum.lower():
    raise SystemExit('compiler checksum/size mismatch')
target = cache / 'kotlin-native-prebuilt-macos-aarch64-2.4.21'
if not target.exists():
    with tarfile.open(archive, 'r:gz') as package:
        for member in package.getmembers():
            if member.name.startswith('/') or '..' in Path(member.name).parts: raise SystemExit('unsafe archive path')
        package.extractall(cache, filter='data')
(cache / (name + '.sha256')).write_text(checksum.lower()+'\n')
print('Official Kotlin/Native compiler verified and extracted.')
