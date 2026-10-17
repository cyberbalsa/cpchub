FROM alpine:3.24.2
RUN apk add --no-cache linux-virt python3 py3-pillow cpio gzip mkinitfs
COPY init /sbin/cpchub-init
COPY initrd-init /opt/initrd-init
COPY guest.py /opt/guest.py
COPY protocol.py /opt/protocol.py
RUN python3 -c 'import shutil, sysconfig; shutil.copy("/opt/protocol.py", sysconfig.get_path("purelib") + "/cpchub_protocol.py")'
RUN chmod 755 /sbin/cpchub-init /opt/initrd-init && mkdir -p /export /tmp/initrd \
    && cp /boot/vmlinuz-virt /export/vmlinux \
    && cd /tmp/initrd && gzip -dc /boot/initramfs-virt | cpio -id \
    && cp /opt/initrd-init init && find . | cpio -o -H newc | gzip -9 > /export/initrd \
    && rm -rf /tmp/initrd /boot/* /var/cache/apk/*
