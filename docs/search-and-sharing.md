# Search and sharing

Public creation pages have a title, summary, canonical URL, Open Graph tags, and a large-image social card. The first screenshot is the share image; the description includes the creator's name. Other public pages use `static/art/share-card.png`, a 1200 × 630 image rendered from `tools/share-card.html` with the site's fonts and artwork. To replace it, render that HTML in a browser and capture the `.card` element at its native size.

The shared head includes `og:title`, `og:type`, `og:url`, `og:description`, `og:site_name`, `og:locale`, `og:image`, its HTTPS URL, MIME type and alt text, plus Twitter large-image card metadata. Image dimensions are included when known; screenshot dimensions are not guessed. Public creator pages use the `profile` Open Graph type and `profile:username`. Public creations name the author and file type in their metadata.

`og:logo` points to `static/art/logo.png`, a 512 × 512 version of the site's parking-sign mark. This tag is a consumer extension, not a required property in the Open Graph specification. The same asset appears in the supported `Organization.logo` JSON-LD property. A 48 × 48 PNG favicon and 180 × 180 Apple touch icon supplement the SVG favicon. Regenerate these from the existing vector with `rsvg-convert -w SIZE -h SIZE static/art/favicon.svg -o OUTPUT`.

`/share/items/<item-id>/<screenshot-id>/image.webp` checks that the creation is public, then issues a fresh signed object-storage redirect. It never grants an author or staff exception. The share metadata contains this stable application URL rather than an expiring storage URL. Screenshots stay in private object storage. The generic site card is a static interface asset served by WhiteNoise.

JSON-LD connects the community organization, website, pages, creation, breadcrumbs, and creator profile through stable IDs. It contains public information only and escapes script delimiters. It does not invent prices, ratings, or endorsements. Filtered catalogs and account pages use `noindex`; the main catalog and creator pagination have their own canonical URLs and page titles. Known campaign parameters (`utm_*`, `gclid`, `dclid`, `fbclid`, `msclkid`) leave public pages indexable and are omitted from canonical URLs. Content filters still use `noindex`, even when a campaign parameter is present.

Public pages allow large image previews and unrestricted text snippets. HTML robots tags and HTTP `X-Robots-Tag` headers use the same policy. Error responses, private pages and application endpoints remain excluded. Existing user-authored Markdown links carry `nofollow ugc`.

## Daily paginated sitemap

`/sitemap.xml` is an index. It links to `/sitemap-1.xml`, `/sitemap-2.xml`, and further pages. `SITEMAP_PAGE_SIZE` defaults to 1000 URLs, with a maximum of 10000. The snapshot includes the homepage, install guide, developer and donation pages, published creations, and creators with public creations. It excludes demos and all private content. Modification dates reflect content changes, not the time the job ran.

Creation entries include current screenshots through the Google image-sitemap extension. Image URLs use the permission-checked `/share/` route, never an expiring storage signature. Deleted screenshots disappear on the next sitemap request without waiting for a snapshot rebuild.

The snapshot is stored in PostgreSQL and rebuilt in one transaction, so a failed job retains the previous snapshot. Every response checks current visibility: hiding, unpublishing, deleting, or shadow banning removes affected URLs immediately. Newly published content enters the next daily snapshot. If no snapshot exists, the first sitemap request builds one.

Rebuild manually:

```sh
python manage.py build_sitemap
```

Compose runs the `sitemap` service on startup and every 24 hours. The production host uses `deploy/systemd/cpchub-sitemap.service` and `.timer` as the `cpchub` user. The timer runs at **04:15 UTC every day**, catches up after downtime, and retries failures after five minutes:

```sh
systemctl --user enable --now cpchub-sitemap.timer
systemctl --user start cpchub-sitemap.service
systemctl --user list-timers cpchub-sitemap.timer
```

`/robots.txt` advertises `https://cpchub.net/sitemap.xml`. Submit that index URL in Google Search Console after verifying the domain. A successful request with a bot's User-Agent checks the response format; it does not prove that Google has crawled or indexed a page.

## Cloudflare crawler access

The live browser-check exception uses `cf.client.bot` and the verified categories `Search Engine Crawler` and `Page Preview`. It covers GET and HEAD requests to public pages, creator profiles, screenshots, static assets, robots.txt, and sitemap pages. Cloudflare verifies the crawler's identity; a matching User-Agent alone does not qualify.

The rule skips Browser Integrity Check and Security Level checks. The automation challenge already exempts verified bots. Managed WAF rules, rate limits, exposed-file blocks, and admin/login challenges remain enabled. Private content still requires the application's permission checks.

`deploy/cloudflare/public-crawlers-rule.json` contains the deployed rule payload. It extends the existing public API exception within the Free plan's five-rule allowance. Apply it as a PATCH to that rule in the zone's `http_request_firewall_custom` entrypoint; keep the other rules and their order. Matching requests are logged in Cloudflare Security Events. Add any future public page routes to the path list.

## Crawler and security files

`templates/hub/robots.txt` allows public pages and images, excludes account and staff endpoints, and points to the daily sitemap. A narrow `Allow` exception exposes `/api/v1/items/*/screenshots/*/image/` to crawlers because those URLs appear in page image elements. Only public, non-demo screenshots receive an indexable response header; authentication and visibility checks still apply. The rest of the API remains disallowed. Filtered pages remain crawlable so search engines can read their `noindex` directives. Game download endpoints are excluded.

`/.well-known/security.txt` follows [RFC 9116](https://www.rfc-editor.org/rfc/rfc9116.html). `/security.txt` redirects there. It links to private GitHub vulnerability reporting and lists Balsa.38 on Signal for critical issues. Other bugs go to GitHub Issues. Review the contacts and renew `Expires` in `templates/hub/security.txt` before **17 April 2027**. Keep the GitHub `SECURITY.md` policy in sync.

References: [Open Graph](https://ogp.me/), [Google sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap), [Google structured data guidance](https://developers.google.com/search/docs/appearance/structured-data/sd-policies), and [Cloudflare verified bots](https://developers.cloudflare.com/waf/custom-rules/use-cases/allow-traffic-from-verified-bots/).

## Research and checks for this update

Reviewed against the following guidance on 17 October 2026:

- [Open Graph](https://ogp.me/) defines the required title, type, image and URL properties, image details, and profile metadata. [Microlink](https://microlink.io/logo) documents a consumer that reads the additional `og:logo` property.
- [Google organization markup](https://developers.google.com/search/docs/appearance/structured-data/organization) supports a crawlable logo of at least 112 × 112 pixels. The supplied logo is 512 × 512.
- [Google image SEO](https://developers.google.com/search/docs/appearance/google-images) covers crawlable HTML images, descriptive alt text and image sitemaps. This audit found and corrected the blanket API crawl block on embedded screenshots.
- [Title guidance](https://developers.google.com/search/docs/appearance/title-link) and [snippet guidance](https://developers.google.com/search/docs/appearance/snippet) favor descriptive, page-specific text. Creation titles now identify blueprints or scenarios, and creator pagination has distinct titles.
- [Canonical guidance](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls) supports a consistent preferred URL for duplicate content. Campaign URLs now point to the clean page while preserving its indexability.
- [Robots directives](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag) define the preview controls used here. Structured data makes a page eligible for supported features; it does not guarantee rankings or rich results.

The live audit confirmed that the homepage, install guide, robots file and both sitemap endpoints return HTTP 200. The main Open Graph and Twitter Card tags were already present. X's older public card-documentation URL redirected to its general developer overview during this audit, so the existing large-image card tags were retained.

After deploying this update:

1. Apply the updated Cloudflare crawler exception, which now includes `/install/`, and rebuild the sitemap.
2. Verify the `cpchub.net` domain in Google Search Console and Bing Webmaster Tools, then submit `https://cpchub.net/sitemap.xml`. These steps need access to the respective webmaster accounts; site metadata alone does not submit or verify a domain.
3. Use Search Console URL Inspection on the homepage, install guide and a public creation. Check the rendered image and canonical URL. A request with a forged crawler User-Agent cannot establish verified-bot access through Cloudflare.
4. Check organization, breadcrumb and profile markup with Google's Rich Results Test. `CreativeWork` describes a creation but does not promise a dedicated Google rich-result format.
5. Monitor indexing, search clicks and Core Web Vitals in Search Console. Recheck previews after sharing a creation; platforms may cache older cards.
