# Cost model

Checked 17 October 2026. Prices are USD before tax. Allowances are shared with the rest of the Cloudflare account.

| Feature | Choice and reason | Billing basis |
|---|---|---|
| Pages, API, authentication, moderation | Workers with precompiled templates and bundled static assets; no always-on VM | Workers Paid: $5/month account minimum, 10 million requests and 30 million CPU-ms included; then $0.30/million requests and $0.02/million CPU-ms. Static-asset requests are free. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Metadata, identities, counters | D1, indexed privacy revision checks, bulk catalog queries | 25 billion rows read, 50 million rows written, 5 GB included on Paid; then $0.001/million reads, $1/million writes, $0.75/GB-month. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Files and screenshots | R2 Standard, zero egress fees, screenshots served by its public custom-domain CDN | First 10 GB-month, 1 million Class A and 10 million Class B operations included. Then $0.015/GB-month, $4.50/million Class A, $0.36/million Class B. Multipart uploads involve several Class A operations. [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Validation jobs | Queues with a small job ID; private service bindings to validators | 1 million queue operations/month included; $0.40/million thereafter. Normally three operations per message, with more for retries. Service-bound Worker calls do not add request charges, but their CPU counts. [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Screenshot inspection/transcode | Images binding only when uploading; store the resulting WebP in R2 and serve it repeatedly | `.info()` is free. 5,000 transformations/month included, then $0.50/1,000 on Images Paid. No Images-hosted delivery/storage charges for these R2 objects. [Images pricing](https://developers.cloudflare.com/images/pricing/) |
| Billing total | Scheduled account billing-history fetch every six hours, tiny D1 result | No extra billing service or per-visitor Cloudflare API request |
| Visibility and moderation cache changes | D1 revision included in edge cache key | One indexed row read per public API request; avoids KV propagation delays for private-content changes |

The account already had Workers Paid and R2 enabled. This deployment does not require another VM, Redis, hosted PostgreSQL, Durable Objects, or a third-party image-processing server. The existing VM is retained for rollback until it can be retired separately; retaining it does not eliminate its bill.

For illustration, if other account usage leaves all relevant allowances available, 1 million app requests averaging 5 ms CPU, 100,000 downloads, 1,000 native uploads, 2,000 screenshot conversions, and 5 GB stored can fit within included usage. This is a capacity example, not measured production usage. At 100 GB of R2 storage alone, 90 billable GB-month cost about $1.35 before billing-unit rounding; request/CPU/transformation overages are separate.

Use Standard storage for frequently downloaded assets. Infrequent Access adds retrieval charges and minimum-storage-duration constraints, so its lower storage headline price is not automatically cheaper here.

The website's **Monthly Costs** value is the current month's invoiced total across the entire account. It is deliberately separate from this project's incremental estimate and includes unrelated account services and any domain invoices issued that month. It may not yet include unbilled usage.
