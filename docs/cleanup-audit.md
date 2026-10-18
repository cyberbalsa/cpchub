# Cleanup, input handling and verification audit

Audited on 18 October 2026 against the final Python implementation at `7f932ef` and the migrated Workers deployment. This document records the runtime policy, fixes, validation, and historical-data exceptions.

## Retention and scheduled work

The application Worker runs `*/5 * * * *`. Expiry uses inclusive UTC cutoffs; restoration is allowed only strictly before the 14-day deadline.

| Data or operation | Runtime policy | Enforcement |
| --- | --- | --- |
| Account activity, including recorded IP/header data | Delete at 14 days | Independent cron task, including exact-boundary tests |
| Anonymous download IP markers | Expire 14 days after recording | Delete when `expires_at` is reached; aggregate download counters remain |
| Self-deleted creations | Restore for less than 14 days, then cascade-delete | Repeated deletion preserves the original deadline; both author and moderator restoration recheck the deadline during the write |
| Release files and screenshots | Delete when their database reference is removed | Migration 0013 queues storage deletion in the same transaction, including account deletion and cascades |
| Upload quarantine and unreferenced output | Delete after completion/failure/deletion | Durable deletion queue; quarantine also has an `incoming/` lifecycle expiry of one day |
| Pending uploads | Time out after 15 minutes if unleased | Atomic lease acquisition prevents the cron racing a starting consumer; overdue leased work waits for its lease to expire |
| Upload quota events | Delete at one hour | Independent cron task |
| Sessions, social login state, Steam nonces, OAuth codes/tokens, passkey challenges | Delete at their recorded expiration | Each table expires independently of storage or upload failures |

Storage deletion attempts are isolated. A failed object remains queued, increments its attempt count, and does not block unrelated files or privacy expiry. Each invocation processes up to 20 expired creations and 100 queued files; failures move behind untried entries. Pending unleased jobs are republished to the queue in batches of up to 64, so a queue publication outage does not strand accepted uploads. Backlogs can extend physical deletion beyond the next five-minute invocation.

Consumers reserve a 20-minute lease, longer than Cloudflare's [15-minute queue invocation wall-time limit](https://developers.cloudflare.com/queues/platform/limits/). An output key is persisted before its R2 write. A deleted in-flight job queues its input and orphaned output with deletion delayed until that lease expires; a consumer whose row has already disappeared cannot start an untracked permanent write. Completion attaches files only to a still-live creation.

The audit found the migrated cron already configured and firing, but the storage cleanup needed durable retries and cascade coverage. It also found that repeat self-deletion could reset the restore deadline. These paths now have regression tests. An upload missing a CSRF token previously attempted to read an already-consumed multipart body; it now returns 403 and removes its staged input.

### Historical copies outside this policy

The active D1 database had no overdue activity, IP markers, self-deleted creations, or queued deletions during the production audit. Foreign-key checks passed. Live file/image buckets have no object-expiry rule; incomplete multipart uploads are aborted after seven days. The quarantine rule is separate from the application deletion queue.

The old VM cleanup timer is inactive, while its backup timer remains active. Its retained database still contained seven account-activity rows and fourteen download-IP rows. Ignored local `migration-data/` snapshots also contain historical data. The Python backup export excluded activity/IP tables, but existing full snapshots are separate copies. The old backup command's `find -mtime +14` rule rounds age to whole days and is not an exact 14-day cutoff.

These rollback copies were not deleted by this audit. Cloudflare's paid D1 [Time Travel history retains recoverable database states for 30 days](https://developers.cloudflare.com/d1/reference/time-travel/). Therefore the live 14-day deletion policy is not a guarantee that all historical copies disappear at 14 days. Retiring the old VM, removing retained migration snapshots, and choosing the desired backup policy require a separate lifecycle decision.

## Text and HTML

Human-written fields share `normalizeText`: Unicode NFKC normalization, removal of invisible formatting/unpaired surrogates, [`transliteration@2.6.1`](https://github.com/yf-hk/transliteration), and removal of unsafe control characters. This covers provider names, chosen names, creation titles/summaries/descriptions/tags, filenames, release versions/changelogs, screenshot captions, key/application names, moderation reasons/notes, and search text. It applies to JSON and form submissions. Identifiers, URLs, credentials, WebAuthn payloads, and uploaded bytes retain their protocol meaning.

The library has TypeScript declarations, an MIT license, and no runtime dependencies. Local comparisons with [`@sindresorhus/transliterate`](https://github.com/sindresorhus/transliterate) and [`slugify`](https://github.com/simov/slugify) favored its wider script mappings. [NFKC](https://unicode.org/reports/tr15/) handles compatibility alphabets before transliteration. Tested examples include `𝓑𝓪𝓵𝓼𝓪` → `Balsa`, `Café Łukasz Straße` → `Cafe Lukasz Strasse`, and `你好 停車` → `Ni Hao Ting Che`. Transliteration is approximate and does not reliably recover the intended pronunciation of every name, particularly CJK names. Existing stored text is not bulk rewritten.

First Discord login uses `global_name` when present, otherwise `username`; Steam uses the matching verified user's `personaname`. A sanitized base name is used without a suffix when available; collisions receive a random suffix. Names without usable letters/numbers fall back to the provider name. Account and provider-link inserts are transactional. Later provider logins preserve an existing account's chosen name, and linking cannot take over another user's identity.

Normalization does not replace output escaping. Nunjucks autoescaping protects text/attributes, custom HTML helpers escape their values, Markdown passes through an HTML allowlist sanitizer, and browser scripts render untrusted messages with `textContent`. Stored text stays unencoded for JSON and Markdown; blanket encoding at storage time would double-escape it. The shared message template no longer treats arbitrary content as safe HTML. Tests exercise HTML payloads in names, metadata, captions, forms, Markdown, and browser error responses.

## Validation and operational observations

`npm run verify` passes 162 tests with 100% lines, statements, functions and branches per authored runtime file, covering the whole site, seven browser modules, and both validators. Strict TypeScript and type-aware ESLint run in CI alongside the coverage gate. Tests use real SQLite migrations, transactional D1 fixtures, signed software-authenticator WebAuthn responses, and DOM interactions. Coverage is a regression gate, not proof that every possible behavior is correct.

A local multi-Worker integration run additionally exercised actual Workerd service bindings, queues, D1, R2, native blueprint/scenario validation, image transformation, escaped page rendering, byte-identical downloads, self-delete/restore, account cascades, and scheduled storage cleanup. Temporary local accounts and artifacts were removed; the deletion queue and foreign-key checks were clean. Wrangler deployment dry runs passed for all three Workers. `npm audit` reported no known vulnerabilities at verification time.

The reported `/moderation/users/` failure disappeared after refresh. Authenticated production checks of the listing, a matching query, and an empty query result returned 200. No definitive cause was reproduced. A pre-deployment live-log sample contained 37 main-Worker events, including two successful cron invocations, with no logged exceptions, errors, warnings, or failed outcomes. Validator tails had no traffic in that sample; their successful local integration executions provide separate validation. A short live sample does not establish that historical logs contain no errors.
