#!/bin/sh
set -eu
# Build from this directory only; never send the application workspace or secrets.
validator_source=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
validator_output=${1:?Pass an output directory}
mkdir -p "$validator_output"
validator_output=$(CDPATH= cd -- "$validator_output" && pwd)
validator_temp=$(mktemp -d)
validator_container=
trap 'if [ -n "$validator_container" ]; then podman rm -f "$validator_container" >/dev/null; fi; rm -rf "$validator_temp"' EXIT
podman build -t localhost/cpchub-validator-guest:build "$validator_source"
validator_container=$(podman create localhost/cpchub-validator-guest:build)
podman cp "$validator_container:/export/vmlinux" "$validator_output/vmlinux"
podman cp "$validator_container:/export/initrd" "$validator_output/initrd"
podman export "$validator_container" -o "$validator_temp/rootfs.tar"
mkdir "$validator_temp/rootfs"
tar --no-same-owner -xf "$validator_temp/rootfs.tar" -C "$validator_temp/rootfs"
rm -rf "$validator_temp/rootfs/export"
truncate -s 256M "$validator_output/rootfs.ext4"
mke2fs -q -t ext4 -F -b 4096 -d "$validator_temp/rootfs" "$validator_output/rootfs.ext4"
(cd "$validator_output" && sha256sum vmlinux initrd rootfs.ext4 > SHA256SUMS)
