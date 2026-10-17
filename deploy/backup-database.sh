#!/bin/sh
set -eu
umask 077
backup_dir="${1:-/home/cpchub/backups}"
mkdir -p "$backup_dir"
backup_tmp=$(mktemp "$backup_dir/.database.XXXXXX")
trap 'rm -f "$backup_tmp"' EXIT HUP INT TERM
# Exclude temporary download IPs and account activity to avoid extending retention.
podman exec cpchub-db pg_dump -U cpchub -d cpchub -Fc --no-owner --no-privileges --exclude-table-data=public.hub_downloadip --exclude-table-data=public.hub_accountactivity > "$backup_tmp"
test -s "$backup_tmp"
mv "$backup_tmp" "$backup_dir/cpchub-$(date -u +%Y%m%dT%H%M%SZ).dump"
find "$backup_dir" -maxdepth 1 -type f -name 'cpchub-*.dump' -mtime +14 -delete
