# 07. Fully-free incremental serving shadow

## Status

This document defines the second migration slice after PR #265. The repository implementation is intentionally **off by default**:

- production remains Cloudflare Pages Git Integration;
- no custom-domain route is declared;
- the dedicated private R2 bucket and D1 database exist only for shadow data;
- the separate Worker remains `off` with `CUTOVER_APPROVED=0`;
- scheduled Publisher runs do not execute the shadow flow;
- the manual `incremental_shadow` workflow input is the only repository trigger;
- the generated coverage is detail-only and can never satisfy the full cutover gate.
- `serve` is hard-disabled in code, so changing a variable cannot cut over production.

The slice proves source-level incremental generation for article details. It does not call Workers Static Assets upload deduplication an incremental build, and it does not suppress current Pages builds.

The manual workflow deliberately publishes a **full detail shadow snapshot**. It does not yet consume impact v2 for scheduled route deltas. The body-only impact fixture proves that the renderer can emit one changed detail and one search-delta record, but current Publisher runs commonly also change index health/aggregate data and therefore remain globally invalidating. Route-level dual-publish is not operationally enabled in this slice.

## Evidence and rejected designs

The 2026-08-13 local production build generated 2,694 detail pages and 7,710 files. Final output was about 434 MiB. Detail HTML was about 303 MiB total, with individual pages between about 94 KiB and 143 KiB. The data artifacts were about 4.1 MiB for `data/index.json`, 9.0 MiB for `data/bodies.json`, and 11.6 MiB for monthly archives.

The detail shadow renderer loaded the existing Astro detail page through Vite and `AstroContainer`, rendered all 2,694 details without Pagefind or unrelated routes, restored the production CSS/client asset shell, produced JA and `?lang=en` variants, and passed semantic parity for all 2,694 routes. The deterministic body-only test emits one detail object and one search-delta record.

These results establish that route objects can be generated without a whole-site Astro/Pagefind run. They do not establish production Worker CPU usage or traffic volume.

The measured detail bootstrap contains 2,694 routes, 5,405 reachable files, and about 605.9 MB. Its largest route object is 142,650 bytes, largest route shard is 57,831 bytes, and shell is 4,283 bytes. One upload plus read-back for this bootstrap projects 10,813 Publisher Worker requests on that day, 167,555 Class A operations/month and 335,110 Publisher Class B operations/month if repeated once daily. Public serving remains off, so measured public requests are recorded as unknown (`0` with no verification timestamp), not as a cutover measurement.

Rejected designs:

| Design | Reason |
|---|---|
| Workers Static Assets alone | Wrangler still requires the complete local asset tree and hashes its manifest. Unchanged network uploads are skipped, but Astro/Pagefind generation is still whole-site. |
| Request-time Astro SSR | Cloudflare documents 10 ms CPU per Workers Free request and notes typical SSR workloads use 10-20 ms CPU. The shadow Worker therefore streams pre-rendered bytes and never renders HTML. |
| KV as route storage | KV Free allows 100,000 reads/day and 1,000 writes/day. That has no read headroom at the Workers request ceiling and insufficient write capacity for route artifacts. |
| GitHub raw JSON at request time | It would parse multi-megabyte data, weaken atomic activation/deletion behavior, and depend on raw delivery freshness. |
| Client-only overlays | Initial HTML, crawler content, and social metadata would be stale or absent. |
| Detail-only production cutover | `data/index.json` also affects Home, pagination, category/tag pages, feeds, sitemap, search, Status, metrics, and global shell state. |

Official references:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers Static Assets direct upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/)
- [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Workers KV limits](https://developers.cloudflare.com/kv/platform/limits/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits)
- [JavaScript SEO basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)

## Architecture

```text
manual Publisher full reconciliation
  -> current Astro/Pagefind build and Publisher E2E
  -> capture production detail CSS/client asset shell
  -> render only detail route objects through AstroContainer
  -> generate JA and pre-localized EN HTML
  -> verify every generated detail against current static HTML
  -> commit/push data and flush existing Queue/KV effects
  -> GitHub OIDC upload to dedicated R2
  -> D1 compare-and-swap activation of the shadow generation

public production
  -> Cloudflare Pages (unchanged)

separate shadow Worker
  off    -> proxy Pages without D1/R2 reads
  shadow -> serve only /__incremental-shadow/* from D1 + R2
  serve  -> hard-disabled in this slice; always proxy Pages
```

R2 stores immutable content-addressed route objects, shell manifests, and route shards. D1 stores immutable generation metadata plus one active/previous pointer. Activation happens only after the shell and every shard exist. A failed upload or failed compare-and-swap leaves the active pointer unchanged. Rollback swaps the pointer to the stored previous generation.

The shell records every production `/_astro/` asset byte length and SHA-256 digest. Before activation, the Publisher fetches those assets from the fixed Pages fallback origin and requires exact digest parity. The route HTML therefore cannot activate against missing or stale CSS/client assets.

The first slice publishes only `detail-pages` coverage with `complete=false`. It also hard-disables `serve`; a future code change must remove that guard and satisfy the fixed list of required route families. Known deleted/cold/dropped routes are tombstones and return 404 instead of falling through to an older Pages detail.

Each served shadow route performs:

1. one D1 active-state row lookup;
2. one bounded route-shard R2 read (at most 64 KiB);
3. one streaming route-object R2 read (at most 5 MiB).

The route body is never buffered or parsed in the Worker. `?lang=en` selects a pre-rendered English metadata object, preserving crawler-visible bilingual/social metadata without request-time HTML rewriting.

Authenticated uploads validate the declared byte count while piping through a
Cloudflare [`FixedLengthStream`](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream).
This preserves the bounded streaming design while giving `R2Bucket.put()` the
known-length stream required by the production runtime. R2 still verifies the
SHA-256 supplied from the content-addressed key, and the Publisher performs a
bounded authenticated byte read-back and recomputes the exact SHA-256 before
activation.

## Free-tier budget

Production traffic and account-wide Cloudflare usage could not be measured from public repository or public site data. This is an external blocker, so the tracked configuration remains `off`, `CUTOVER_APPROVED=0`, has no custom-domain route, and cannot enter `serve`.

The repository uses these conservative fail-closed budgets:

| Resource | Provider Free limit | Repository safety budget |
|---|---:|---:|
| Worker requests | 100,000/day | 80,000/day |
| Public + Publisher Worker requests | 100,000/day | 90,000/day combined |
| Worker CPU | 10 ms/request | no SSR or HTML parsing; shadow CPU must be measured before cutover |
| Worker memory | 128 MiB/isolate | 64 KiB shard plus streamed route body |
| R2 storage | 10 GB-month | 8 GB reachable objects |
| R2 Class A | 1,000,000/month | 900,000/month |
| R2 Class B | 10,000,000/month | 8,000,000/month |
| D1 rows read | 5,000,000/day | one state row/request |
| D1 rows written | 100,000/day | generation metadata and pointer only |
| R2 reads per served route | n/a | 2 |

At the 80,000 request/day cutover ceiling, two R2 reads/request over a conservative 31-day month project to 4.96 million public Class B operations/month. The client adds Publisher R2 GET/read-back operations to the same Class B total and separately projects R2 Class A and authenticated Publisher API requests from the object/shard count. Public and Publisher Worker requests must remain at or below 90,000/day together, leaving 10,000/day below the provider ceiling. The one-time detail bootstrap runs while public serving is off; future hourly serving requires packed/batched artifacts or another design that keeps upload requests inside the same combined budget.

Before any cutover, record the peak daily HTML-route requests and account-wide Worker/D1/R2 usage from Cloudflare for at least seven days. Verify public requests are at or below 80,000/day and public plus Publisher requests are at or below 90,000/day. Also measure the shadow Worker's CPU distribution and actual bucket inventory, then add active/previous mark-and-sweep retention. The repository does not infer these values.

## Local and shadow verification

Capture a shell from a verified production build:

```bash
npm run build:web
npm run incremental:shadow -- \
  --capture-shell \
  --dist web/dist \
  --output "$RUNNER_TEMP/incremental-detail-shell.json"
```

Render a full detail shadow snapshot without Pagefind:

```bash
npm run incremental:shadow -- \
  --render \
  --base-ref "$(git rev-parse HEAD)" \
  --shell "$RUNNER_TEMP/incremental-detail-shell.json" \
  --output "$RUNNER_TEMP/incremental-shadow-bundle" \
  --full-detail-snapshot
```

Verify parity against the current static build:

```bash
npm run incremental:shadow -- \
  --verify-parity \
  --bundle "$RUNNER_TEMP/incremental-shadow-bundle/bundle.json" \
  --dist web/dist
```

`bundle.json` records rendered routes, tombstones, a body-search delta artifact, incomplete coverage, and blockers. The search delta is evidence for the future hourly overlay; it is not yet consumed by the production search client.

## Provisioned shadow resources and approved operations

The dedicated resources already exist. Do not run create commands again or
replace their bindings:

| Resource | Provisioned identity |
|---|---|
| private R2 bucket | `tech-dashboard-incremental-serving` |
| D1 database | `tech-dashboard-incremental-serving` (`8b7cc7b8-3694-4bd2-ad1d-3173e078f138`) |
| Worker | `tech-dashboard-incremental-serving` at `https://tech-dashboard-incremental-serving.himiyosh.workers.dev` |

Any deploy, migration, or bootstrap still requires the explicit release
approval defined by the repository rules.

1. Use the existing local Wrangler OAuth login. Do not add a long-lived repository secret.
2. List R2, D1, and Worker deployments first and verify the identities above. If an identity differs, stop instead of creating or rebinding a resource.
3. Copy `worker/wrangler.incremental.toml` to the ignored `worker/wrangler.incremental.local.toml` and replace only the all-zero `database_id` with the provisioned D1 ID above.
4. Check the dedicated migrations and apply only pending files:

   ```bash
   cd worker
   npx wrangler d1 migrations list tech-dashboard-incremental-serving \
     --remote \
     --config wrangler.incremental.local.toml
   npx wrangler d1 migrations apply tech-dashboard-incremental-serving \
     --remote \
     --config wrangler.incremental.local.toml
   ```

5. Deploy the separate Worker with `INCREMENTAL_SERVING_MODE=off` and no route:

   ```bash
   npx wrangler deploy --config wrangler.incremental.local.toml
   ```

6. Keep the exact Worker URL in the repository variable `INCREMENTAL_SHADOW_URL`. Do not guess or reconstruct the URL.
7. Leave `INCREMENTAL_MEASURED_DAILY_REQUESTS` unset (or `0`) and `INCREMENTAL_TRAFFIC_VERIFIED_AT` unset until real Cloudflare traffic has been measured.
8. Manually bootstrap after a full reconciliation:

   ```bash
   gh workflow run publisher.yml \
     -f dry_run=false \
     -f full_reconcile=true \
     -f incremental_shadow=true
   ```

9. Change the separate Worker's mode to `shadow` only after bootstrap and deploy it under a new explicit approval. Compare `/__incremental-shadow/e/{id}/` against Pages. Do not add a custom-domain route.

No Cloudflare API token is required by the Publisher. GitHub Actions authenticates to the shadow Worker with the existing OIDC audience, repository, main ref, workflow ref, event, subject, SHA, and time checks. The Worker alone holds the dedicated R2/D1 bindings.

## Cutover and rollback gates

Cutover is a later change and requires a new approval. It must not occur until all of these are true:

- exact incremental coverage exists for Home, pagination, categories, tags, arXiv, Knowledge, Archive, details, feeds, sitemap, search, Status, metrics, and global shell;
- Pagefind has a tested daily base plus hourly upsert/tombstone overlay;
- seven consecutive daily reconciliations report exact route-set and sampled semantic parity;
- production traffic is measured at or below 80,000 dynamic requests/day;
- account-wide Worker requests, D1 rows, and R2 operations include all existing TECH Dashboard services and stay inside the combined safety budgets;
- shadow Worker CPU is measured below the 10 ms Free ceiling with safety margin;
- reachable R2 storage and projected Class A/Class B usage pass the checked budgets;
- active/previous mark-and-sweep removes failed-upload and obsolete objects without deleting rollback data;
- hourly route updates use packed/batched uploads so Publisher API requests remain inside the same Worker request budget;
- Pages fallback maximum age is documented and monitored;
- a custom-domain path route and Pages build-watch change have separate preview and rollback evidence.

Primary rollback is the authenticated D1 pointer reversal. Emergency rollback is `INCREMENTAL_SERVING_MODE=off`, which returns all traffic to the existing Pages origin. Pages Git Integration and its custom domain remain intact throughout the shadow slice.
