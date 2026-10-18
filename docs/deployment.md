# Remote deployment

`ssh cpchub` connects to the production host. The dedicated `cpchub` Linux account owns the application, production configuration, PostgreSQL data, and rootless Podman containers. It has no login shell or sudo access. User lingering keeps its systemd services running after logout and starts them at boot.

Cloudflared remains a host service. It sends requests to Nginx at `127.0.0.1:8080`, which proxies to Django on the private container network. PostgreSQL and Gunicorn publish no host ports. Cloudflare serves HTTPS, and `www.cpchub.net` redirects to `cpchub.net`.

## Files and services

| Path or service | Purpose |
| --- | --- |
| `/home/cpchub/app` | Deployed application source |
| `/home/cpchub/config/app.env` | Production Django and bucket-scoped R2 credentials, mode 0600 |
| `/home/cpchub/config/db.env` | PostgreSQL credentials, mode 0600 |
| `/home/cpchub/config/revision` | Deployed Git commit |
| `/home/cpchub/backups` | Local database dumps; never uploaded to the UGC bucket |
| `cpchub-db.service` | PostgreSQL 17 with the persistent `cpchub-postgres` volume |
| `cpchub-app.service` | Migrations followed by Gunicorn |
| `cpchub-edge.service` | Nginx on localhost:8080 |
| `cpchub-backup.timer` | Daily database backup, retaining 14 days |
| `cpchub-cleanup.timer` | Every five minutes: remove expired download IPs, upload quota events and self-deletions; retry file removal |

The [Quadlet files](../deploy/quadlet) install in `/home/cpchub/.config/containers/systemd/`. The backup service and timer install in `/home/cpchub/.config/systemd/user/`. [Podman's Quadlet documentation](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) describes service generation and health checks.

Only release files and screenshots use R2. CSS, JavaScript, fonts, and site artwork come from the application image. The app's R2 credential has object read/write access to the `cpchub` bucket only. The Cloudflare management token stays off the production host. Wasabi originals and its restricted application credentials are retained for migration verification and rollback.

Production uses `DEBUG=0`, `TRUST_PROXY=1`, `PUBLIC_URL=https://cpchub.net`, and `MEDIA_STORAGE=r2`. Set `ALLOWED_HOSTS=cpchub.net,www.cpchub.net,127.0.0.1` and `CSRF_TRUSTED_ORIGINS=https://cpchub.net`. `DATABASE_URL` points to `db:5432/cpchub` with the password from `db.env`.

The R2 bucket remains private, with its managed public domain disabled and no public custom domain. `R2_ENDPOINT_URL` uses the account's `r2.cloudflarestorage.com` endpoint. Download links expire after five minutes. See the [storage migration instructions](../README.md#cloudflare-r2-upload-storage) before switching providers; stop both the app and `cpchub-uploads.service`, plus the cleanup timer, for the final copy and verification. Do not switch back after accepting new uploads without copying those files back first.

The Donate button opens `/donate/`, which shows VPS and domain costs plus an estimate based on the current R2 storage count. `KOFI_PAGE_URL` defaults to `https://ko-fi.com/cpchub`. The page links to Ko-fi for tips; Ko-fi controls payment options and handles checkout. No payment API key is needed.

Uploads are limited to 90 MiB to leave room for multipart form data below [Cloudflare's 100 MB request limit on Free and Pro plans](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/). Nginx limits authentication POSTs to 10 per minute per IP and upload/edit requests to 30 per minute, each with a burst of 10. It replaces forwarded client-IP headers using Cloudflare's connecting IP. Keep its published listener on loopback.

### Visitor IPs and account activity

Set `TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128,10.89.0.0/24` on this host. Verify the private subnet with `podman network inspect cpchub` before using that value on another installation. `TRUST_PROXY=1` also remains required. An empty allowlist trusts no forwarded headers.

The request path is Cloudflare → host cloudflared → loopback-only Nginx → private Gunicorn. Nginx's [real-IP module](https://nginx.org/en/docs/http/ngx_http_realip_module.html) accepts [CF-Connecting-IP](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip) only from loopback and its own container address, which is the peer used by rootless port forwarding. It replaces X-Real-IP and X-Forwarded-For. Django accepts X-Real-IP only from the configured private proxy peers, validates IPv4/IPv6, and gives the normalized address to allauth, DRF throttles, and access logs. Keep Cloudflare Pseudo IPv4's “Overwrite Headers” mode disabled so native IPv6 addresses remain intact.

Successful Steam/Discord sign-ins, new creations, publication, new releases, and screenshot uploads create database records. They contain the account, timestamp, IP and its source, user-agent, language header, authentication method, social provider ID for sign-ins, request path without query strings, and Cloudflare Ray ID when available. Cookies, authorization headers, passwords, OAuth codes, tokens, and uploaded file contents are not copied into the records. Browser and language headers are client-supplied and are not verified identity.

Admins can search records by account, IP, and action at `/moderation/activity/`, or follow “View login & upload history” from user management. Moderators, Reviewers, ordinary users, and the public API cannot access this history. History is limited to the last 14 days. Records expire exactly 14 days after creation and are permanently deleted by the five-minute cleanup job, including records linked to uploads; the uploads themselves are unaffected. Purging an account removes its activity records. Records start at deployment; past logins are not reconstructed. IP bans are not implemented yet; their future controls and enforcement changes must be Admin-only.

### Download counts and upload limits

Download counts use the trusted address above: an individual IPv4 address or an IPv6 /32 subnet. Creation and release counters each check both the account and network; either match prevents an additional count. Account markers persist. Network records expire 14 days after their last download, are ignored immediately at expiry, and are deleted by the five-minute cleanup job. They are not exposed through profiles or the API. Existing counts are preserved.

Cloudflare Cache Rules must bypass caching for `/api/` routes and `/items/.../releases/.../download/`. Keep this bypass after any general cache rule. Cloudflare [converts cache-eligible HEAD requests to GET](https://developers.cloudflare.com/cache/concepts/cache-behavior/) before contacting the origin, even if the response later prevents caching. The bypass preserves HEAD so link checks do not increase download counts. This rule is configured on the live zone.

The backup script excludes `hub_downloadip` and `hub_accountactivity` data so backups do not prolong IP retention. Nginx and Gunicorn omit client addresses from new download access-log entries. Login and upload activity also expires after 14 days. Restoring a backup restores account markers and totals but starts with empty IP markers and activity history.

Creation files and new releases accepted into the validation queue share 16 slots per rolling hour per account. Screenshots and metadata edits do not consume slots. All three staff roles are exempt. PostgreSQL account locks prevent parallel uploads from exceeding the limit. Rejected submissions use no slot; queued files keep their slot even if checks later fail. Deleting a release or creation does not reset the allowance. Quota rejections return HTTP 429 and a `Retry-After` header in seconds. Expired quota events are removed by the cleanup job.

## Service commands

After connecting through SSH, define this helper from an accessible working directory:

```bash
cd /
cpc() {
    sudo -n -H -u cpchub env XDG_RUNTIME_DIR="/run/user/$(id -u cpchub)" "$@"
}
cpc systemctl --user status cpchub-db cpchub-app cpchub-edge
cpc podman ps
cpc journalctl --user -u cpchub-app -n 100 --no-pager
cpc systemctl --user list-timers cpchub-backup.timer
```

The app and edge containers use read-only root filesystems and temporary upload space. Systemd restarts unhealthy containers. The account's Podman storage is separate from the SSH operator's storage.

## Deploy an update

From a clean checkout on your workstation, transfer the committed source:

```bash
git archive HEAD | ssh cpchub 'sudo -n -H -u cpchub tar -xf - -C /home/cpchub/app'
```

Then on the host, using the `cpc` helper above:

```bash
cpc systemctl --user start cpchub-backup.service
cpc podman build -t localhost/cpchub:production /home/cpchub/app
cpc sh -c 'cp /home/cpchub/app/deploy/quadlet/* /home/cpchub/.config/containers/systemd/'
cpc sh -c 'cp /home/cpchub/app/deploy/systemd/* /home/cpchub/.config/systemd/user/'
cpc systemctl --user daemon-reload
cpc systemctl --user restart cpchub-app.service
cpc systemctl --user restart cpchub-edge.service
cpc systemctl --user enable --now cpchub-cleanup.timer
curl --fail https://cpchub.net/health/
```

Restart the app after changing `app.env`. Database migrations run before Gunicorn starts. Nginx refreshes the app's container address through Podman DNS; restart the edge after changing its configuration. Updating the database image is a separate operation; back up first and review its release notes.

After checking the deployed site, record its revision from the same workstation checkout:

```bash
git rev-parse HEAD | ssh cpchub 'sudo -n -H -u cpchub tee /home/cpchub/config/revision >/dev/null'
```

## Backups and account access

The backup timer runs daily at 04:00 host time, with up to 20 minutes of jitter. Dumps stay on the host; copy them to separate backup storage for protection against loss of the server. They are not UGC and do not belong in the Wasabi upload bucket.

Users sign in with Steam or Discord and link additional accounts from `/account/profile/`. Password login, password resets, and local signup are disabled, including password sign-in to Django admin. Steam signup works without an email address. At least one provider must be configured in `app.env`; see the [provider setup instructions](../README.md#social-login-setup).

To grant administrator access, have the person sign in first, then open a Django shell:

```bash
cpc podman exec -it cpchub-app python manage.py shell
```

Select the exact username from their profile:

```python
from django.contrib.auth import get_user_model
user = get_user_model().objects.get(username="THEIR_USERNAME")
assert user.socialaccount_set.exists()
user.is_staff = user.is_superuser = True
user.save(update_fields=["is_staff", "is_superuser"])
```

They can then open `/moderation/` and `/admin/` using the same social login. Use the moderation panel’s User management page for subsequent role assignments. New users receive no staff permissions automatically.

The cleanup timer runs `python manage.py cleanup_deleted_files` every five minutes. It deletes expired login/upload activity, download IP records and upload quota events, permanently removes creations whose 14-day self-deletion period has ended, then retries pending file deletions. Check pending counts in the moderation panel and service logs with `cpc journalctl --user -u cpchub-cleanup.service`. Hiding or shadow banning blocks new signed URLs; already issued R2 URLs retain their original expiry, five minutes for API redirects and release downloads, or 24 hours for on-page screenshots on this deployment.

## Isolated upload worker

Install the dedicated Firecracker worker before starting an app revision with queued validation. Follow [upload validation](upload-validation.md), including the separate service users, queue permissions, SELinux labels, and `cpchub-uploads.container`. The app accepts submissions only into the private queue and never falls back to local parsing.


### Donation page cost breakdown

Set `SUPPORT_VPS_YEARLY_USD` (default `71.28`) and `SUPPORT_DOMAIN_YEARLY_USD` (default `11.86`, owner-confirmed) to the annual USD bills. An unset domain price is shown as unknown and the total is marked partial. Wasabi and unrelated Cloudflare subscriptions are excluded.

Run `python manage.py refresh_storage_usage` after migrating the database. Install `deploy/systemd/cpchub-storage-usage.{service,timer}` in the production user's `~/.config/systemd/user/`, reload systemd and enable the timer. It inventories the entire dedicated R2 bucket hourly using the existing bucket credentials, including files awaiting deletion. Pagination counts objects and bytes without downloading contents. Public page views read a database snapshot and never call R2. Failed inventories retain the last complete count; snapshots older than two hours are labelled delayed.

The estimate applies [R2 Standard pricing](https://developers.cloudflare.com/r2/pricing/) checked 2026-10-17: first 10 decimal GB-month free per account, then $0.015 per GB-month rounded up to whole billing units. It assumes the current stored bytes persist for a month and this dedicated bucket uses the account's free storage allowance. Review this assumption if adding other buckets. Actual billing uses average daily peak storage; requests, unfinished multipart uploads and taxes are not included. Revisit the rates if Cloudflare changes pricing. This is a storage estimate, not a copy of the Cloudflare bill.


### On-page R2 screenshots

Catalog cards, galleries, lightboxes and editor previews use direct R2 GET URLs signed for 24 hours. Signing runs locally without an R2 HEAD request. URLs are reused within each rendered page and image responses allow private browser caching for one day. Page visibility checks still run before rendering; already-issued image links can work for up to 24 hours after an item is made private. Deleting the object invalidates the link. HTML responses remain private and uncached.

The API screenshot endpoint, API serializer URLs, social previews and sitemap URLs remain stable application URLs with their existing permission checks. Release downloads and API redirects retain the configured short expiry. Local and Wasabi installs continue using the screenshot endpoint. See [Cloudflare's presigned URL documentation](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
