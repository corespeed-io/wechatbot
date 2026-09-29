#!/usr/bin/env python3
"""Inspect bridge metadata without reading credentials or conversation bodies."""
import argparse
import json
import os
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--target', required=True, type=Path)
args = parser.parse_args()
p = args.target.expanduser().resolve() / '.runtime' / 'status.json'
if not p.exists():
    print(json.dumps({'state': 'unknown', 'reason': 'No bridge status metadata; inspect its process/logs.'}))
    raise SystemExit(0)
try:
    data = json.loads(p.read_text())
except (OSError, ValueError) as error:
    print(json.dumps({'state': 'unknown', 'reason': type(error).__name__}))
    raise SystemExit(1)
alive = False
pid = data.get('pid')
if isinstance(pid, int) and pid > 0:
    try:
        os.kill(pid, 0)
        alive = True
    except PermissionError:
        alive = True
    except ProcessLookupError:
        pass
data['processAlive'] = alive
data['fresh'] = alive and time.time() - p.stat().st_mtime < 45
print(json.dumps(data, ensure_ascii=False, indent=2))
