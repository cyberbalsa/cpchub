#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root.' >&2; exit 1; }
validator_app_user=${1:?Pass the application host user}
validator_source=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
validator_artifacts=${2:?Pass the artifact directory}
id "$validator_app_user" >/dev/null
getent passwd cpchub-validator >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin cpchub-validator
getent passwd cpchub-vm >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin cpchub-vm
install -d -m 755 /opt/cpchub-validator /opt/cpchub-validator/bin /opt/cpchub-validator/artifacts
install -d -m 700 /var/lib/cpchub-validator /var/lib/cpchub-validator/jails
install -d -m 755 /var/lib/cpchub-validation
install -d -m 2770 -o "$validator_app_user" -g cpchub-validator /var/lib/cpchub-validation/incoming
install -d -m 2750 -o cpchub-validator -g "$(id -gn "$validator_app_user")" /var/lib/cpchub-validation/results
(cd "$validator_artifacts" && sha256sum -c SHA256SUMS)
install -m 444 "$validator_artifacts/vmlinux" "$validator_artifacts/initrd" "$validator_artifacts/rootfs.ext4" /opt/cpchub-validator/artifacts/
if command -v getenforce >/dev/null && [ "$(getenforce)" != Disabled ]; then
    if command -v semanage >/dev/null; then
        semanage fcontext -a -t container_file_t '/var/lib/cpchub-validation(/.*)?' 2>/dev/null || semanage fcontext -m -t container_file_t '/var/lib/cpchub-validation(/.*)?'
        restorecon -RF /var/lib/cpchub-validation
    else
        chcon -R -t container_file_t /var/lib/cpchub-validation
    fi
fi
validator_temp=$(mktemp -d)
trap 'rm -rf "$validator_temp"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 -o "$validator_temp/firecracker.tgz" https://github.com/firecracker-microvm/firecracker/releases/download/v1.17.0/firecracker-v1.17.0-x86_64.tgz
printf '%s  %s\n' 06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558 "$validator_temp/firecracker.tgz" | sha256sum -c -
tar -xzf "$validator_temp/firecracker.tgz" -C "$validator_temp"
install -m 755 "$validator_temp/release-v1.17.0-x86_64/firecracker-v1.17.0-x86_64" /opt/cpchub-validator/bin/firecracker
install -m 755 "$validator_temp/release-v1.17.0-x86_64/jailer-v1.17.0-x86_64" /opt/cpchub-validator/bin/jailer
install -m 755 "$validator_source/run_job.py" /opt/cpchub-validator/run_job.py
install -m 644 "$validator_source/worker.py" /opt/cpchub-validator/worker.py
printf '%s\n' 'cpchub-validator ALL=(root) NOPASSWD: /opt/cpchub-validator/run_job.py *' > /etc/sudoers.d/cpchub-validator
chmod 440 /etc/sudoers.d/cpchub-validator
visudo -cf /etc/sudoers.d/cpchub-validator
install -m 644 "$validator_source/cpchub-validator.service" "$validator_source/cpchub-validator-netns.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cpchub-validator-netns.service
systemctl enable --now cpchub-validator.service
