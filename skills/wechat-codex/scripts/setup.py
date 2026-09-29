#!/usr/bin/env python3
"""Copy the self-contained bridge into a new task-owned directory."""
import argparse
import shutil
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--target', required=True, type=Path)
args = parser.parse_args()
target = args.target.expanduser().resolve()
assets = Path(__file__).resolve().parents[1] / 'assets' / 'bridge'
files = [p for p in assets.rglob('*') if p.is_file()]
conflicts = [str(p.relative_to(assets)) for p in files if (target / p.relative_to(assets)).exists()]
if conflicts:
    parser.error('Refusing to overwrite existing files: ' + ', '.join(conflicts))
for source in files:
    dest = target / source.relative_to(assets)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)
print(f'Bridge prepared: {target}')
print('Next: npm ci --ignore-scripts --no-audit --no-fund in that directory')
