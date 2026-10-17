# Upload checks

New game files and screenshots enter a local queue. The creation stays in draft while checks run. The app stores approved files in Wasabi and publishes the creation if the author requested publication and every pending check passed. A failed check leaves the creation in draft with an error on its edit page. Existing downloads are unchanged.

Only raw `.cpbp` blueprints and `.cpcs` scenarios accept new uploads. Blueprint packs, ZIP, JSON, and other mods are disabled. The default limit is **15 MiB per game file**, adjustable from 1–100 MiB under **Moderation → Upload settings**. `/api/v1/types/` reports `max_upload_bytes`. Changes apply to new submissions. Each submitted game file uses one of the account's 16 hourly upload slots, including files later rejected by validation. Staff are exempt from that hourly limit. Screenshots do not use those slots.

Screenshots must be still PNG, JPEG, or WebP images, at least 320×180, at most 8,192 pixels on either side, at most 20 megapixels, and at most 10 MiB. Aspect ratios must be between 1:6 and 6:1. The guest decodes the image, checks it for corruption, removes metadata, and converts it to WebP within 1920×1080. The application never decodes submitted images.

## Separation

- `cpchub` runs the website and a result collector. It holds the database and Wasabi credentials.
- `cpchub-validator` runs the queue worker. It has no application credentials and cannot read the application user's home. It can invoke one root-owned launcher with a UUID argument through a restricted sudo rule.
- `cpchub-vm` runs Firecracker after the jailer drops privileges. It has no sudo permission. One VM runs at a time, and each file gets a fresh VM.
- The launcher accepts no commands, paths, kernel parameters, or configuration from uploads. It checks a fixed binary envelope and copies bytes into a private jail. It opens queue files without following symlinks and keeps its output descriptor open to avoid path replacement attacks.

The VM has a read-only root disk and input disk, a bounded output disk, one virtual CPU, 384 MiB guest RAM, a 512 MiB host memory cap, no swap, a 30-second deadline, and a 12-second parser CPU limit. It has no network device, shared host filesystem, SSH service, or application credentials. The jailer adds a separate mount/PID namespace, an empty network namespace, cgroups, resource limits, and Firecracker's default seccomp filters. The guest parser drops to UID/GID 65534. KVM timer threads are moved into the VM's CPU cgroup.

The guest writes result bytes before its ready marker. The launcher kills the VM before reading the result, checks the result length and status, and attaches the hash of the submitted bytes. The app checks that hash again before storing a game file. Neither the worker nor the app mounts a guest-written filesystem. The jail and cgroup are removed after each run.

Native files also return a fixed 120-byte statistics packet. It contains only a version marker and bounded integers; names, descriptions, scripts, and arbitrary metadata never cross this boundary. The app validates the packet's type, dimensions, counts, and relationships before saving it on the release. Screenshots still return sanitized WebP bytes.

Queue files are temporary and private; they are never served. Approved UGC goes to Wasabi. Acknowledged jobs are removed from the host queue, and abandoned files expire after 24 hours. Missing results fail after 15 minutes. Validator failures never trigger parsing in the web process. Queue backpressure permits at most 32 pending files per submitting account and 64 across the site; screenshot slots include pending checks.

## What the checks establish

Blueprint checks cover observed format versions 2 and 3, bounded CBOR metadata, required fields, dimensions, and the expected tile-data length. Scenario checks cover a complete zlib stream, its uncompressed-size trailer, bounded expansion, room metadata, dimensions, and expected map-data lengths. The implementation was checked against all 27 blueprint and four scenario files in the supplied game installation. Proprietary game files are not included in this repository.

These are structural checks, not a guarantee that every file will load correctly in every game version. New game formats may need validator updates. Isolation limits the impact of a parser exploit; no VM boundary can guarantee that escape is impossible. Keep the host, guest kernel, image libraries, Firecracker, and jailer patched. The setup follows the [Firecracker production guidance](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md) and [jailer configuration](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md).

## Installation

The host needs Linux x86-64, usable `/dev/kvm`, cgroup v2, systemd, sudo, iproute2, curl, and e2fsprogs. Image builds also need Podman. On SELinux hosts, install `policycoreutils-python-utils` so the queue label persists across relabels.

The included Nginx origin allows 100 MiB per request, enough for the default game-file limit plus eight maximum-size screenshots. Raising the game-file limit may require uploading screenshots in separate requests. The request must also fit the Cloudflare plan's upload limit.

Build from the `sandbox/` directory, which contains no application configuration or credentials:

```sh
sh sandbox/build-artifacts.sh /tmp/cpchub-validator-artifacts
sudo sh sandbox/install.sh cpchub /tmp/cpchub-validator-artifacts
```

The installer verifies artifact hashes and the pinned Firecracker 1.17.0 release digest, creates the two service users, and installs the root-owned launcher, empty network namespace, and worker service. Guest artifacts use Alpine 3.24.2 with current repository security updates. Rebuild with a fresh package layer when applying security updates; restart the worker before replacing artifacts.

Install `deploy/quadlet/cpchub-uploads.container` with the other Quadlets. Both the app and collector use `keep-id` to map their container user to the host application account. The app can write incoming files and read results; it cannot modify results. The worker owns results. The queue is not exposed through Nginx or WhiteNoise.

For local Podman, substitute your host account for `cpchub` when installing the worker and use:

```sh
podman-compose -f compose.yaml -f compose.podman.yaml up -d
```

For Docker, run the app and collector with the UID/GID of the host application account that owns the incoming directory, or give the container UID an explicit filesystem ACL. The Podman `keep-id` override is not used by Docker. Existing development media volumes may need ownership adjusted when switching user mappings.

Inspect services with `systemctl status cpchub-validator` and `systemctl --user status cpchub-uploads`. The validator journal records job IDs and result codes, not filenames, image metadata, IPs, or credentials. Code 0 passed, 1 failed file checks, and 2 means the check could not finish.

## API

Release and screenshot uploads return **202 Accepted** with an `UploadJob`. Poll `/api/v1/items/{id}/upload-jobs/` using the author's credentials or a staff browser session. A passed job contains its release or screenshot ID. Failed jobs contain a safe error message. Other users cannot read jobs.

Clients can PATCH `status: published` while jobs are pending. The item remains `draft` with `publish_after_validation: true` until all checks pass. Explicitly choosing draft cancels automatic publication. Deleting a creation prevents publication and its queued files are discarded. Pending jobs also prevent content-type changes and duplicate version submissions.

Each release exposes typed `file_stats` in the API and a table on the detail page. Counts describe saved objects, including individual car and golf-cart bays; they do not establish usable parking capacity or road access. Blueprint dimensions use the actual saved size, not padded storage dimensions. Scenario dimensions are the largest width, depth, and height across maps; scenario area is the sum of map areas. An unavailable count is null, not zero.

The catalog and `/api/v1/items/` accept inclusive `min_` and `max_` filters for `width`, `depth`, `height`, `footprint_tiles`, `objects`, `object_types`, `parking_spaces`, `golf_cart_spaces`, `entrances`, `exits`, `maps`, `entities`, and `format_version`. All bounds match the same latest release. Missing stats never match. These filters combine with tags, categories, saved creations, and ownership filters.

After upgrading an existing installation, run `python manage.py backfill_file_stats` in the app container. It queues up to 32 native releases without stats; rerun after those jobs finish for larger catalogs. `--release UUID` selects a release and `--force` recomputes existing stats. Files are read from storage and decoded in fresh VMs. Only derived database fields change: original files, publication state, download counts, release dates, and review history stay intact. No new Wasabi objects are created. Failures leave existing stats and publication state intact.

For a rolling upgrade, deploy the app before updating the guest artifacts and root launcher. The app accepts the previous empty native result for compatibility; backfill fills any missing stats afterward. Stop the worker while replacing its artifacts, then start it again. Do not run the new guest with the old launcher or collector.

Tests for storage/authentication use an explicit synchronous test override. Production has no environment switch to bypass the queue. The asynchronous tests cover private drafts, failure handling, publication intent, input tampering, quotas, and permissions. Guest tests use synthetic files, plus separate integration probes against a real jailed Firecracker process.
