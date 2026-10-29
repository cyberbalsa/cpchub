# Cloudflare Pro audit and applied configuration

Checked and applied to **cpchub.net** on 18 October 2026 UTC. Worker version: `b117ef83-38d2-4ed4-b29e-bf214e3a5db2`. Zone changes use `cf`; the existing Workers project uses its installed Wrangler. No paid add-on subscription was purchased.

The largest opportunities were blocking scanners before they invoke the Worker, using the full Pro WAF, and consolidating public screenshot cache entries. The architecture already served static assets directly and stored converted screenshots in R2. Those choices were retained.

## Upload false positives — 29 October 2026

MungusXIX's upload attempts at 08:58:43, 09:01:14, 09:02:10 and 10:32:16 UTC were blocked before Worker execution by OWASP rule `949110` (`6179ae15870a4bb7b2d480d4843b323c`), with an anomaly score of 100. Their connection matched the account's login request. No creation or upload job was recorded for the account. The existing browser-challenge exception did not skip OWASP inspection. OWASP had been enabled after the original audit below.

The OWASP execute rule now excludes multipart POSTs on the application hosts to `/upload/`, `/items/*/edit/`, and browser/API item routes ending in `/releases/` or `/screenshots/`. Other requests retain the existing OWASP scope. The full Cloudflare Managed Ruleset, rate limits, Worker authentication/CSRF checks, and isolated native/image validators remain enabled. The exception does not treat a cookie or request header as proof of authentication; the Worker validates credentials before staging uploads. [Cloudflare documents OWASP false positives](https://developers.cloudflare.com/waf/managed-rules/reference/owasp-core-ruleset/).

`scripts/cloudflare-pro.py` preserves this exclusion when reconciling an existing OWASP execute rule, without enabling OWASP when absent. The production change updated only that rule's expression, after remote validation and a concurrent-version check. Private before/after snapshots and the exact applied rule are in `.wrangler/upload-waf/20261029T163619Z/`. To roll back this specific change, restore the original OWASP rule from `before.json` using `cf rulesets rules update`; this snapshot is not a full `--restore` snapshot for the Pro policy script.

Verification used the same native `Tron.cpcs` file before and after the change: an anonymous multipart POST changed from Cloudflare HTML 403 to the Worker's JSON 401. A temporary authenticated account then submitted that scenario and a valid PNG through `/upload/`, received 202, and both queued validators passed. The temporary account, session, draft, and R2 objects were removed. No Worker deployment was needed.

## What changed

| Control | Previous state | Applied state and purpose |
|---|---|---|
| Managed WAF | Free managed rules | Full Cloudflare Managed Ruleset, current version and default actions, on the application and screenshot hosts. The full set includes the free set's coverage. [Managed rules](https://developers.cloudflare.com/waf/managed-rules/) |
| Super Bot Fight Mode | Definitely automated traffic allowed | Managed challenge for definitely automated browser traffic; verified bots allowed. API, OAuth token/revocation, download and machine-readable discovery routes skip browser checks while retaining managed WAF and rate protection. Screenshot traffic remains free of browser challenges. [Pro bot features](https://developers.cloudflare.com/bots/plans/pro/) |
| Private automated-test exemption | Broad security bypass | Only browser checks are skipped. Known probe blocks run first; managed WAF and rate limits still apply. The private matching value is excluded from this document and source control. |
| Scanner filtering | Existing generic probe block | Added observed credential/config paths and nonstandard ports, before Worker execution. On the screenshot host, allow expected WebP path length/extension and GET/HEAD/OPTIONS, with `/cdn-cgi/` exempted. |
| Request budgets | No application distinction for authenticated clients | Verified credentials receive three times the anonymous request allowance. Two outer edge rules still reject excessive traffic before it reaches the Worker. Details below. |
| Screenshot caching | Query variants could fragment the cache | Ignore the whole query string for generated public WebP objects. Preserve object freshness: browser 300 seconds, shared cache 86,400 seconds from existing metadata. Private files and HTML are excluded. [Cache keys](https://developers.cloudflare.com/cache/how-to/cache-keys/) |
| Smart Tiered Cache | Off | Enabled to consolidate cache misses toward R2. The Smart Shield onboarding includes a free option; no Argo or Cache Reserve purchase was made. [Setup](https://developers.cloudflare.com/smart-shield/get-started/), [R2 caching](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/) |
| Canonical hostname | `www` returned 502 through the old origin | Native 308 redirect to the apex, preserving path, query and method. This removes the old origin dependency for `www`. [Single Redirects](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-api/) |
| Transport | Full SSL; HTTP/3 off | Full (strict) SSL and HTTP/3 enabled. Existing HTTPS redirect and TLS controls retained. |

The sampled 23-hour baseline contained 2,255 apex requests classified as cache-bypass 404s, another 127 dynamic 404s, and 1,450 events already blocked by the original probe rule. These groups are not a unique-attacker count. Requests included cloud credential filenames, development-tool configuration paths, screenshot-root requests and port 8443 probes. The new blocks address these observed patterns.

## Request limits

| Allowance, per client IP per 60 seconds | Anonymous or invalid credentials | Valid session, API key or OAuth access token |
|---|---:|---:|
| General API | 300 | **900** |
| Sensitive routes, shared budget | 60 | **180** |

Sensitive routes are `/accounts/*`, `/upload/`, `/o/token/`, `/o/revoke_token/`, and item routes ending in `/releases/`, `/screenshots/` or `/download/`. API uploads/downloads also count against the general API budget. A token exchange without a valid session is anonymous; a token or authorization code in its request body alone does not qualify for the higher allowance.

Authentication runs before selecting a native Workers rate-limit binding. Forged, revoked and expired credentials use the anonymous allowance. Rate rejection happens before multipart parsing, storage work and API cache lookup. Credential rotation and changing `X-Forwarded-For` do not create a fresh allowance: the key is Cloudflare's client IP. Different users behind the same public IP share each allowance.

Pro permits **two edge rate rules**, with IP-based counting and a restricted field set; those rules cannot validate this application's opaque credentials. Their combined ceilings are **1,200 API requests/minute** and **240 sensitive requests/minute**, allowing the sum of both application budgets on one IP. These are abuse ceilings, not extra client allowances. All matching attempts count at the edge, so sustained abuse from a shared IP can still affect authenticated clients. [Pro rate-limit capabilities](https://developers.cloudflare.com/waf/rate-limiting-rules/)

Both layers return HTTP 429 and `{"error":"rate_limited","retry_after":60}`. The Worker also sends `Retry-After: 60` and `Cache-Control: private, no-store`. Clients should back off at least 60 seconds and avoid synchronized retries. The separate database-enforced quota remains **16 release file uploads/hour per non-staff account**; its retry delay is one hour.

Cloudflare's counters are local to a Cloudflare location and eventually consistent. These are approximate abuse controls, not exact global accounting. Native bindings use local counters without a network round trip. Four separate namespaces avoid mixing anonymous/authenticated or general/sensitive budgets. [Workers rate-limit behavior](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

## Cost implications

The pre-change estimate at 03:55 UTC reported 6,665 Worker requests, about 11,938 CPU-ms, 243 R2 Class A operations and 5,956 Class B operations for the month to date. Reported variable overages were $0. This is an analytics estimate, not an invoice or a before/after savings measurement.

The configured project budget is $25/month for Pro plus the $5 Workers minimum. Workers Paid includes 10 million requests and 30 million CPU-ms; excess usage is $0.30/million requests and $0.02/million CPU-ms. Direct static assets are free. Blocking abusive traffic before Worker execution avoids its application work and associated usage. The new Worker limiter itself executes inside a billable request; the outer edge controls remain useful. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

R2 Standard includes 10 million Class B operations/month, then $0.36/million. Better cache reuse reduces origin reads, but at this site's present volume it does not produce an immediate dollar saving. R2 already has zero egress charges. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

Pro's published annual option is equivalent to $20/month instead of $25 monthly: potentially $60/year saved if an annual commitment suits the owner. Billing cadence was not changed. The retained migration VM still has its separate hosting bill; repairing `www` does not retire that VM. Allowances are account-wide, and tax or other subscriptions are outside this project's estimate. [Plan pricing](https://www.cloudflare.com/plans/), [project cost model](costs.md)

## Features deliberately left off

| Feature | Reason |
|---|---|
| OWASP Core Ruleset | Cloudflare cautions about false positives and limited additional value alongside its managed rules. Binary uploads make unnecessary extra inspection especially disruptive. Revisit only for a demonstrated gap. [OWASP guidance](https://developers.cloudflare.com/waf/managed-rules/reference/owasp-core-ruleset/) |
| Polish | All eight migrated screenshots are already WebP, and new uploads are converted once before storage. Cloudflare discourages combining Polish with image transformations. [Polish guidance](https://developers.cloudflare.com/images/polish/activate-polish/) |
| JavaScript Detections | The site's CSP allows only self-hosted scripts and has no nonce support. Enabling this needs a deliberate CSP integration; weakening CSP with `unsafe-inline` is unnecessary. [CSP requirements](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/) |
| Static-resource bot protection and hotlink blocking | Community screenshots need to work in mod managers, embeds and shared links without browser challenges. |
| Workers Cache in front of the Worker | Cache hits still incur the standard Worker request rate. Existing API cache keys include a D1 visibility revision, keeping private-content changes immediately effective; moving cache lookup ahead of that check needs separate design. [Workers Cache](https://developers.cloudflare.com/workers/cache/) |
| Paid Argo, Cache Reserve and other add-ons | No measured requirement justifies additional subscriptions at current usage. |

## Verification and operation

Every changed ruleset passed Cloudflare server validation for this Pro zone. A second preview after the initial rollout produced no changes. The source-controlled policy preserves unrelated rules, snapshots existing values privately and rejects concurrent ruleset edits.

Production checks after the Pro rollout covered 31 HTTP cases: normal API clients, invalid authentication, OAuth errors, native redirects including POST, static assets, screenshot cache reuse and every existing public screenshot. All eight screenshot byte hashes matched the baseline. All four release HEAD requests remained private and uncached. Credential probes were blocked even with the private test agent, and a harmless XSS-shaped API query was blocked by managed WAF.

The authenticated-limit change passed TypeScript, all 41 tests, template build and Wrangler deployment dry run. Tests cover actual 300/900 and 60/180 boundaries, valid session/key/OAuth selection, revoked/forged credentials, IP isolation, shared budgets, cache-hit protection and rejection before storage. Full interactive Steam/Discord sign-in and a new production upload were not replayed for this change.

After the final deployment, the production smoke checks passed again and the live developer page/OpenAPI document contained the new limits. A bounded 140-request check in 13.95 seconds at ORD observed anonymous throttling on attempt 62, rejected forged credentials, and allowed 76 authenticated requests through to the OAuth handler while anonymous requests remained throttled. The malformed grants produced their expected 400 responses; no OAuth access tokens were issued. This also demonstrates why the configured limits are described as approximate. The temporary test session was revoked. A final zone apply found no changes and verified all four bindings on the active Worker.

Policy review and apply:

```sh
python scripts/cloudflare-pro.py
python scripts/cloudflare-pro.py --apply
```

Deploy the Worker before raising edge ceilings. The apply script checks every active Worker version's rate-limit bindings before changing those ceilings. It derives edge values from `wrangler.jsonc` to avoid separate numeric configuration.

Private rollback snapshots live under ignored `.wrangler/cloudflare-pro/`. The initial Pro rollout snapshot is `20261018T042113321829Z`; the authenticated-limit adjustment snapshot is `20261018T043157274416Z`. Review a restore without changing anything, then append `--apply` to execute it:

```sh
python scripts/cloudflare-pro.py --restore .wrangler/cloudflare-pro/20261018T043157274416Z
```

For an application rollback, restore the lower outer edge limits first, then roll back the Worker. The preceding Worker version is `bc716ad4-639c-4988-8ba3-9917606af333`. Zone rollback and Worker rollback are separate operations; neither restores database or R2 data. Raw audit evidence is private under `.wrangler/pro-audit-2026-10-18/`.

Watch Security Events for managed-WAF false positives on real uploads or OAuth callbacks, Worker 429 responses, and screenshot cache-hit/read trends. No ongoing monitoring task was scheduled.
