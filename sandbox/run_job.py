#!/usr/bin/python3 -I
"""Root-owned narrow launcher. Its only argument is a lowercase UUID hex job ID."""
import fcntl
import errno
import hashlib
import os
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

BASE = Path('/opt/cpchub-validator')
QUEUE = Path('/var/lib/cpchub-validation')
JAILS = Path('/var/lib/cpchub-validator/jails')
CGROUPS = Path('/sys/fs/cgroup/cpchub-validation')
MAGIC = b'CPCRES1\x00'
MAX_RESULT = 8 * 1024 * 1024


def terminate(signum, frame):
    raise TimeoutError('Validator interrupted')


def run(job):
    vm_user = pwd.getpwnam('cpchub-vm')
    jail = JAILS / 'firecracker' / job
    root = jail / 'root'
    cgroup = CGROUPS / job
    digest = hashlib.sha256()
    status, payload = 2, b''
    process = None
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        root.mkdir(parents=True, exist_ok=False, mode=0o750)
        fd = os.open(QUEUE / 'incoming' / f'{job}.input', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as source, (root / 'input').open('xb') as target:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError('Invalid queue file')
            header = source.read(17)
            if len(header) != 17 or header[:8] != b'CPCVAL1\x00':
                raise ValueError('Invalid queue input')
            kind, length = header[8], int.from_bytes(header[9:], 'big')
            if kind not in (1, 2, 3) or not 0 < length <= (10 if kind == 3 else 100) * 1024 * 1024 or info.st_size != length + 17:
                raise ValueError('Invalid queue length')
            target.write(header)
            remaining = length
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError('Truncated queue input')
                digest.update(chunk)
                target.write(chunk)
                remaining -= len(chunk)
            target.truncate(((17 + length + 511) // 512) * 512)
        (root / 'input').chmod(0o444)
        for name in ['vmlinux', 'initrd', 'rootfs.ext4']:
            try:
                os.link(BASE / 'artifacts' / name, root / name)
            except OSError as exc:
                if exc.errno != errno.EXDEV:
                    raise
                # ProtectSystem=strict puts immutable artifacts on a separate mount.
                shutil.copyfile(BASE / 'artifacts' / name, root / name)
                (root / name).chmod(0o444)
        # Keep this descriptor open: never follow a guest-replaced output path.
        with (root / 'output').open('x+b', buffering=0) as output:
            output.truncate(MAX_RESULT + 4096)
            os.fchown(output.fileno(), vm_user.pw_uid, vm_user.pw_gid)
            config = {
                'boot-source': {'kernel_image_path': '/vmlinux', 'initrd_path': '/initrd',
                                'boot_args': 'reboot=k panic=1 pci=off quiet loglevel=0 8250.nr_uarts=0'},
                'machine-config': {'vcpu_count': 1, 'mem_size_mib': 384},
                'drives': [{'drive_id': name, 'path_on_host': '/' + path, 'is_root_device': name == 'root', 'is_read_only': name != 'output'}
                           for name, path in [('root', 'rootfs.ext4'), ('input', 'input'), ('output', 'output')]],
            }
            import json
            (root / 'config.json').write_text(json.dumps(config))
            (root / 'config.json').chmod(0o444)
            command = [str(BASE / 'bin/jailer'), '--id', job, '--exec-file', str(BASE / 'bin/firecracker'),
                '--uid', str(vm_user.pw_uid), '--gid', str(vm_user.pw_gid), '--chroot-base-dir', str(JAILS),
                '--netns', '/run/netns/cpchub-validator', '--new-pid-ns', '--cgroup-version', '2',
                '--parent-cgroup', 'cpchub-validation', '--cgroup', 'memory.max=536870912',
                '--cgroup', 'memory.swap.max=0', '--cgroup', 'cpu.max=100000 100000', '--cgroup', 'pids.max=32',
                '--resource-limit', 'no-file=64', '--resource-limit', 'fsize=16777216',
                '--', '--no-api', '--config-file', '/config.json']
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 30
            while True:
                output.seek(0)
                if output.read(8) == MAGIC:
                    (cgroup / 'cgroup.kill').write_text('1')
                    break
                code = process.poll()
                pids = (cgroup / 'cgroup.procs').read_text().split() if cgroup.exists() else []
                if code is not None and not pids:
                    break
                if time.monotonic() > deadline:
                    raise TimeoutError('Validation timed out')
                # KVM timer threads must share the VM's CPU budget.
                for pid in pids:
                    for comm in Path('/proc').glob('[0-9]*/comm'):
                        try:
                            if comm.read_text().strip() == f'kvm-pit/{pid}':
                                (cgroup / 'cgroup.procs').write_text(comm.parent.name)
                        except (FileNotFoundError, ProcessLookupError):
                            pass
                time.sleep(0.05)
            # Stop the guest before consuming its result. No live guest can race this read.
            if cgroup.exists():
                (cgroup / 'cgroup.kill').write_text('1')
                while (cgroup / 'cgroup.procs').read_text().strip():
                    if time.monotonic() > deadline + 2:
                        raise TimeoutError('Guest did not stop')
                    time.sleep(0.01)
            output.seek(0)
            header = output.read(13)
            if len(header) != 13 or header[:8] != MAGIC or header[8] not in (0, 1):
                raise ValueError('No guest result')
            size = int.from_bytes(header[9:], 'big')
            if size > MAX_RESULT or (header[8] == 0 and kind != 3 and size not in (0, 120)) or (header[8] == 1 and size not in (0, 10)):
                raise ValueError('Invalid guest result size')
            payload = output.read(size)
            if len(payload) != size:
                raise ValueError('Truncated guest result')
            if header[8] == 1 and payload and (payload[:8] != b'CPCFAIL1' or not 1 <= int.from_bytes(payload[8:], 'little') <= 255):
                raise ValueError('Invalid guest failure code')
            status = header[8]
    except Exception as exc:
        print(f"Validator failure: {type(exc).__name__}: {str(exc)[:300]}", file=sys.stderr)
        # Code 22 is check_timeout in the fixed failure protocol.
        status, payload = 2, b'CPCFAIL1\x16\x00' if isinstance(exc, TimeoutError) else b''
    finally:
        if cgroup.exists():
            try:
                (cgroup / 'cgroup.kill').write_text('1')
            except FileNotFoundError:
                pass
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait()
        for _ in range(40):
            if not cgroup.exists() or not (cgroup / 'cgroup.procs').read_text().strip():
                break
            time.sleep(0.05)
        for _ in range(100):
            if not cgroup.exists():
                break
            try:
                cgroup.rmdir()
                break
            except OSError as exc:
                if exc.errno not in (errno.EBUSY, errno.ENOTEMPTY):
                    raise
                time.sleep(0.05)
        shutil.rmtree(jail, ignore_errors=True)
    sys.stdout.buffer.write(MAGIC + bytes([status]) + len(payload).to_bytes(4, 'big') + digest.digest() + payload)


if __name__ == '__main__':
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch('[0-9a-f]{32}', sys.argv[1]):
        sys.exit(2)
    with open('/var/lib/cpchub-validator/launcher.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # Reap any VM left by an interrupted launcher before reusing the VM UID.
        if CGROUPS.exists():
            for stale in CGROUPS.iterdir():
                if not re.fullmatch('[0-9a-f]{32}', stale.name):
                    continue
                (stale / 'cgroup.kill').write_text('1')
                for _ in range(100):
                    try:
                        stale.rmdir()
                        break
                    except OSError:
                        time.sleep(0.05)
                if stale.exists():
                    sys.exit(2)
        parent = JAILS / 'firecracker'
        if parent.exists():
            for stale in parent.iterdir():
                if re.fullmatch('[0-9a-f]{32}', stale.name):
                    shutil.rmtree(stale)
        run(sys.argv[1])
