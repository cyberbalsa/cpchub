# Search and sharing

Public creation pages have a title, summary, canonical URL, Open Graph tags, and a large-image social card. The first screenshot is the share image; the description includes the creator's name. Other public pages use `static/art/share-card.png`, a 1200 × 630 image rendered from `tools/share-card.html` with the site's fonts and artwork. To replace it, render that HTML in a browser and capture the `.card` element at its native size.

`/share/items/<item-id>/<screenshot-id>/image.webp` checks that the creation is public, then issues a fresh signed Wasabi redirect. It never grants an author or staff exception. The share metadata contains this stable application URL rather than an expiring storage URL. Screenshots stay in private Wasabi storage. The generic site card is a static interface asset served by WhiteNoise.

JSON-LD describes the site, creation, breadcrumbs, and creator profile. It contains public information only and escapes script delimiters. It does not invent prices, ratings, or endorsements. Filtered catalogs and account pages use `noindex`; the main catalog and creator pagination have their own canonical URLs.

## Daily paginated sitemap

`/sitemap.xml` is an index. It links to `/sitemap-1.xml`, `/sitemap-2.xml`, and further pages. `SITEMAP_PAGE_SIZE` defaults to 1000 URLs, with a maximum of 10000. The snapshot includes the homepage, developer and donation pages, published creations, and creators with public creations. It excludes demos and all private content. Modification dates reflect content changes, not the time the job ran.

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

`/robots.txt` advertises `https://cpchub.net/sitemap.xml`. Submit that index URL in Google Search Console after verifying the domain. Cloudflare rules should allow verified search crawlers and link-preview bots to read public pages, `/share/`, `/robots.txt`, `/sitemap*.xml`, and `/static/`. A successful request with a bot's User-Agent checks the response format; it does not prove that Google has crawled or indexed a page.

References: [Open Graph](https://ogp.me/), [Google sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap), [Google structured data guidance](https://developers.google.com/search/docs/appearance/structured-data/sd-policies), and [Cloudflare verified bots](https://developers.cloudflare.com/waf/custom-rules/use-cases/allow-traffic-from-verified-bots/).
