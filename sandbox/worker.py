#!/usr/bin/python3 -I
"""Credential-free queue worker, run as cpchub-validator. One fresh VM per file."""
import os
import re
import subprocess
import time
from pathlib import Path

QUEUE = Path('/var/lib/cpchub-validation')
MAGIC = b'CPCRES1\x00'


def expire():
    now = time.time()
    for path in (QUEUE / 'incoming').iterdir():
        if not re.fullmatch('[0-9a-f]{32}\\.(input|ack|tmp)', path.name):
            continue
        if path.suffix == '.ack' or path.stat().st_mtime < now - 86400:
            job = path.stem
            for target in [QUEUE / 'incoming' / f'{job}.{suffix}' for suffix in ['input', 'ack', 'tmp']] + [QUEUE / 'results' / f'{job}.result']:
                target.unlink(missing_ok=True)


def main():
    while True:
        expire()
        for path in sorted((QUEUE / 'incoming').glob('*.input'), key=lambda p: p.stat().st_mtime):
            if not re.fullmatch('[0-9a-f]{32}', path.stem):
                continue
            target = QUEUE / 'results' / f'{path.stem}.result'
            if target.exists():
                continue
            result = subprocess.run(['sudo', '-n', '/opt/cpchub-validator/run_job.py', path.stem], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40)
            data = result.stdout
            if result.returncode or len(data) < 45 or len(data) > 8 * 1024 * 1024 + 45 or data[:8] != MAGIC:
                # Leave the item private; the collector times out missing results.
                print(f'Job {path.stem}: validator unavailable', flush=True)
                print(result.stderr[:500].decode('utf-8', errors='replace'), flush=True)
                time.sleep(2)
                continue
            temporary = target.with_suffix('.tmp')
            temporary.unlink(missing_ok=True)
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
            with os.fdopen(fd, 'wb') as output:
                output.write(data)
            os.replace(temporary, target)
            print(f'Job {path.stem}: result {data[8]}', flush=True)
            if data[8] == 2:
                print(result.stderr[:500].decode('utf-8', errors='replace'), flush=True)
        time.sleep(1)


if __name__ == '__main__':
    main()
