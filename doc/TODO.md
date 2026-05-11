# Open Issues

_Last reviewed: 2026-05-11._

A working punch list of known gaps in the market-control-plane. Grouped by area, severity tagged where it matters. Linked code paths are `file:line` at HEAD.

## Security

Detailed evidence lives in [`security-TODO.md`](./security-TODO.md). Top open items:

- **Auth is a single shared Bearer token.** No identity, no scopes, no rotation cadence. Plan: front the API with Cognito (or another OIDC IdP) and move `requireBearerToken` to a JWT validator; keep the current static token only for cron/internal callers.
- **No per-route authorization.** Every authenticated caller can read every resource and post mutations. Plan: scopes on JWTs + a `requireScope("stocks:write")` helper.
- **No WAF / rate-limit at the edge.** `POST /pulse/refresh` and `POST /industries/backfill` are heavy and unprotected from abuse. Plan: API-Gateway throttling per route + CloudFront/WAF rules; the refresh token only protects authorization, not request flooding.
- **`POST /industries/backfill` is unbounded.** A caller can trigger thousands of FMP calls. Plan: dispatch as Step Functions / SQS-backed job, idempotency token in the request.
- **No request body size limits beyond Lambda defaults.** Plan: explicit `maxBodySize` per route.
- **No CSP / HSTS / CORS policy** for `/docs` and `/openapi.json`. Plan: tighten when Swagger UI is exposed beyond dev.

## AI / narrative

- **Pulse tile narrative is deterministic.** `src/pulse.ts` `buildTileTitle` / `buildTileNarrative` stitch a sentence from VIX, sector momentum, and treasury moves. The "AI assessment" badge in the UI mockup is a lie. Plan: add an OpenAI integration (new `OPENAI_API_KEY` SST secret), generate a 2-3 sentence narrative from the snapshot, cache per snapshot ID, fall back to deterministic on failure.
- **Pulse sentiment scoring is keyword-based.** `THEME_KEYWORDS` + positive/negative hint lists in `src/pulse.ts`. Brittle and miscounts negations ("not weak"). Plan: small classifier or LLM call per article; cache on article URL.
- **Region extraction is alias-list-based.** `REGION_ALIASES` in `src/pulse.ts`. Misses indirect references and over-matches short tokens. Plan: NER pass on article text; keep alias matcher as the floor.
- **No reasoning trace on regime classification.** Outputs in `src/regime.ts` are scores without explanations; downstream consumers can't audit *why* a regime flipped. Plan: attach `rationale: string[]` to each regime row, surfaced via API.

## Fundamentals / margins / enrichment

- **Margins come from one annual income statement.** `src/stockEnrich.ts` fetches `income-statement?limit=4` but only uses `[0]`. No TTM, no QoQ deltas. Plan: pull last 4 quarters and last 4 years, expose `margins.ttm`, `margins.history[]`, and a deviation field.
- **EPS surprise history may be sparse.** Some symbols return empty arrays from FMP `/earnings`. Plan: fall back to `earnings-calendar` per symbol, flag `epsHistorySource: "earnings" | "calendar" | null`.
- **No sector-relative comparisons.** Margins and returns are absolute; the dashboard needs "vs sector" deltas. Plan: aggregate per-sector medians (already in `industries.performance`) and attach `relative: { vsSectorMedian, vsIndustryMedian }` to each stock row in `EnrichStockFundamentals`.
- **No de-listing handling.** `RefreshStockReturns` keeps writing whatever FMP returns; delisted symbols silently stop updating. Plan: track `lastSeenAt`, archive stocks not seen for 14 days.
- **Treasury spread deltas use calendar days.** `src/marketData.ts` `findRow(daysAgo)` walks back 7/30/90 calendar days, not trading days; weekend lookups can drift. Plan: walk by trading days using the returned date series.

## Schedulers / scale

- **`RefreshStockReturns` runs every 5 min unconditionally.** Wastes API budget overnight and weekends. Plan: same market-hours gate as `EvaluateAlerts`; rate-drop to 30 min after hours.
- **`EnrichStockFundamentals` is per-symbol.** ~7500 symbols × 4 FMP calls every 2h ≈ 90k calls/day; will throttle on most FMP tiers. Plan: switch profile + key-metrics-ttm to FMP `bulk-*` endpoints; chunk-rotate symbols across runs (only 1/N per cron).
- **No retry / backoff on FMP errors.** A single `fetch` failure drops that symbol for the cycle. Plan: 2-attempt retry with jitter, surface failures to a `failed-symbols` table for review.
- **No idempotency on `industries.backfill`.** Running it twice double-writes Industries rows and re-upserts Stocks. Mostly benign but no cursor / resume. Plan: cursor file in S3 or a DynamoDB checkpoint row.

## API surface

- **`GET /industries/performance?includeStocks=true` can return megabytes.** No pagination. Plan: cap at 50 industries per page, support `cursor` query.
- **No `GET /stocks/{symbol}/returns` / `GET /stocks/movers`.** Returns + fundamentals are only reachable through industry endpoints. Plan: per-symbol detail route + sortable movers query.
- **OpenAPI spec is out of date.** `src/specs/openapi.ts` doesn't list any `/industries/*`, `/pulse/tile`, or `/pulse/sectors` routes. Plan: regenerate spec from route table.
- **`GET /pulse/tile` series omits market-hours metadata.** Consumers can't tell which points are pre/post/regular. Plan: tag each series point with `session: "regular" | "pre" | "post" | "closed"`.

## Orchestration

- **README pitches AWS Step Functions for triangulation; nothing is implemented.** All orchestration is cron + direct Lambda. Plan: pick one workflow (e.g., fundamentals enrichment) and re-implement as `sst.aws.StepFunctions` with a `Map` over symbols + `Parallel` over data sources; measure cost/visibility against the current cron approach before expanding.
- **No saga / compensation on multi-table writes.** `industries.backfill` writes Industries and Stocks separately; partial failure leaves them inconsistent. Plan: Step Functions with explicit rollback states, or batch writes inside a single `TransactWrite`.

## Dashboard tiles

- **Index Futures tile is "Coming soon."** No futures pulled. Plan: add ES=F / NQ=F / YM=F / RTY=F to `marketData.fetchMarketData`; expose under `marketData.indexFutures`.
- **No FX historical sparkline.** Tile shows current quotes only. Plan: 30-day series per pair from `historical-price-eod/light`.
- **No persistence of the `tile` payload.** Each call re-computes from the latest snapshot. Plan: cache in DynamoDB with TTL = snapshot cadence, key = `tile:<region>`.

## Quality

- **No tests.** No `*.test.ts` files anywhere; only `tsc --noEmit` runs in CI. Plan: pick the highest-blast-radius modules (`http.ts`, `pulse.ts` scoring, `marketData.computeRiskState`) and ship a small Vitest suite.
- **Logging is `console.log` JSON.** No correlation IDs across crons → API → ProcessStock. Plan: pass a `runId` through events; structured logger wrapper.
- **No alarms / dashboards.** No CloudWatch alarms on cron failures, FMP error rates, or Dynamo throttles. Plan: SST `Alarms` resource per cron and per Dynamo table.

## Documentation

- **README "Last updated" line is hand-edited.** Drifts immediately. Plan: stamp from CI on push to main.
- **OpenAPI route descriptions still reference old camelCase secret names** in places. Already partially fixed; sweep `src/specs/openapi.ts` for stragglers.
- **No runbook for cron failures.** No doc covers "what to do when RefreshStockReturns fails 10 runs in a row." Plan: `doc/runbook.md` with one section per cron.
