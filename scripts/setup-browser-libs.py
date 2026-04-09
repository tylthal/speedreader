#!/usr/bin/env python3

import lzma
import os
import subprocess
import sys
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_DIR = os.path.join(REPO_ROOT, '.browser-libs')
DEBS_DIR = os.path.join(BASE_DIR, 'debs')
ROOT_DIR = os.path.join(BASE_DIR, 'root')
MAIN_PACKAGES_URL = 'https://deb.debian.org/debian/dists/bookworm/main/binary-amd64/Packages.xz'
ALL_PACKAGES_URL = 'https://deb.debian.org/debian/dists/bookworm/main/binary-all/Packages.xz'
DEBIAN_FILE_BASE = 'https://deb.debian.org/debian/'

PACKAGES = [
    'fonts-liberation',
    'fontconfig-config',
    'libasound2',
    'libatk-bridge2.0-0',
    'libatk1.0-0',
    'libatspi2.0-0',
    'libavahi-client3',
    'libavahi-common3',
    'libcairo2',
    'libcups2',
    'libdatrie1',
    'libdbus-1-3',
    'libdrm2',
    'libfontconfig1',
    'libfreetype6',
    'libfribidi0',
    'libgbm1',
    'libglib2.0-0',
    'libglib2.0-data',
    'libgraphite2-3',
    'libharfbuzz0b',
    'libnspr4',
    'libnss3',
    'libpango-1.0-0',
    'libpixman-1-0',
    'libpng16-16',
    'libthai0',
    'libwayland-server0',
    'libx11-6',
    'libxau6',
    'libxcb-render0',
    'libxcb-shm0',
    'libxcb1',
    'libxcomposite1',
    'libxdamage1',
    'libxdmcp6',
    'libxext6',
    'libxfixes3',
    'libxi6',
    'libxkbcommon0',
    'libxrandr2',
    'libxrender1',
]


def download_text(url: str) -> str:
    raw = urllib.request.urlopen(url, timeout=60).read()
    return lzma.decompress(raw).decode('utf-8', 'ignore')


def build_filename_map() -> dict[str, str]:
    blocks = (download_text(MAIN_PACKAGES_URL) + '\n\n' + download_text(ALL_PACKAGES_URL)).split('\n\n')
    out: dict[str, str] = {}
    for block in blocks:
        pkg = None
        filename = None
        for line in block.splitlines():
            if line.startswith('Package: '):
                pkg = line.split(': ', 1)[1]
            elif line.startswith('Filename: '):
                filename = line.split(': ', 1)[1]
        if pkg and filename and pkg not in out:
            out[pkg] = filename
    return out


def ensure_dirs() -> None:
    os.makedirs(DEBS_DIR, exist_ok=True)
    os.makedirs(ROOT_DIR, exist_ok=True)


def browser_ld_library_path(root_dir: str) -> str:
    return ':'.join([
        os.path.join(root_dir, 'usr/lib/x86_64-linux-gnu'),
        os.path.join(root_dir, 'lib/x86_64-linux-gnu'),
        os.path.join(root_dir, 'usr/lib'),
        os.path.join(root_dir, 'lib'),
    ])


def main() -> int:
    ensure_dirs()
    filename_map = build_filename_map()
    missing = [pkg for pkg in PACKAGES if pkg not in filename_map]
    if missing:
        print(f'missing package metadata: {missing}', file=sys.stderr)
        return 1

    for pkg in PACKAGES:
        rel = filename_map[pkg]
        deb_name = os.path.basename(rel)
        deb_path = os.path.join(DEBS_DIR, deb_name)
        if not os.path.exists(deb_path):
            print(f'download {pkg}')
            urllib.request.urlretrieve(DEBIAN_FILE_BASE + rel, deb_path)
        print(f'extract {pkg}')
        subprocess.run(['dpkg-deb', '-x', deb_path, ROOT_DIR], check=True)

    print('browser libs ready:')
    print(f'  root: {ROOT_DIR}')
    print(f'  LD_LIBRARY_PATH={browser_ld_library_path(ROOT_DIR)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
