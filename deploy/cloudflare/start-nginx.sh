#!/bin/sh
set -eu
container_dns=$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf)
test -n "$container_dns"
case "$container_dns" in
    *:*) container_dns="[$container_dns]" ;;
esac
sed "s/@CONTAINER_DNS@/$container_dns/g" /etc/nginx/nginx.conf > /tmp/nginx.conf
exec /usr/sbin/nginx -c /tmp/nginx.conf -g 'daemon off;'
