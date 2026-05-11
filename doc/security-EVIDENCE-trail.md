# Security Evidence Trail

**Scope:** static review of the market-control-plane repository at HEAD `07357c0`, focused on the surface added since [`security-TODO.md`](./security-TODO.md): Kinesis Data Streams, the WebSocket fan-out (`RealtimeApi`), the AsyncAPI documentation routes, and the surrounding wiring in `sst.config.ts`. Every finding cites concrete `file:line` evidence.

**Severity scale:** Critical → High → Medium → Low → Info. Severities reflect repository-level risk; runtime (CloudWatch retention, IAM policies, account perimeter) is listed separately under [Not assessable from this repo](#not-assessable-from-this-repo).

**Method:** read every handler under `src/`, the SST infrastructure in `sst.config.ts`, and the dependency manifest. No dynamic testing.

---

## What's already in place (positive evidence)

| Control | Evidence |
| --- | --- |
| Timing-safe Bearer comparison | `src/http.ts:68-73` — `timingSafeEqual` with length pre-check via `isSameToken` |
| WebSocket `$connect` uses the same timing-safe path | `src/wsConnection.ts:42` — `tokenMatches(token, Resource.API_BEARER_TOKEN.value)` |
| Bearer-required on every REST handler | `src/wsConnection.ts:39-46`, `src/pulse.ts:429,459,471,498,555,656,678`, `src/industries.ts:36,103,135,282,315`, `src/stocks.ts:62` |
| `POST /pulse/refresh` requires both Bearer AND a separate body token | `src/pulse.ts:454-475` — `tokenMatches(provided, Resource.PULSE_REFRESH_TOKEN.value)` |
| Secrets stored in `sst.Secret`, not env vars in code | `sst.config.ts:12-14`; access via `Resource.X.value` |
| No secrets logged | `grep -rn 'console.*(token|API_BEARER|Resource\.)' src/` returns no producer hits |
| Outbound TLS only to FMP | All `fetch(...)` URLs in `src/` use `https://financialmodelingprep.com/...` |
| Stale WebSocket rows cleaned on 410 Gone | `src/wsConnection.ts:122-131` — caller-side cleanup in `sendTo` |
| `$default` rejects unknown actions | `src/wsConnection.ts:87-89` — `400 Unknown action` if `payload.action` ≠ `subscribe`/`unsubscribe` |
| Payload-size cap on `$default` JSON parse | Implicit Lambda body limit; parse errors return `400` (`src/wsConnection.ts:84-86`) |
| Per-resource IAM via SST `.link()` | Every `link: [...]` in `sst.config.ts:118-220` scopes which Lambda gets which permission |

---

## New findings (post-Kinesis / WebSocket / AsyncAPI changes)

### F-1. WebSocket bearer token passed via query string — **High**

**Evidence:** `src/wsConnection.ts:38-42`

```ts
const token = String(
  event.queryStringParameters?.token ?? event.queryStringParameters?.access_token ?? ""
);
const authenticated = tokenMatches(token, Resource.API_BEARER_TOKEN.value);
```

**Why this matters:** API Gateway access logs (`format $context.path` includes the raw request line) typically capture the query string. The token also lands in browser history, the `Referer` header on any subsequent navigation from a page that opened the socket, intermediary proxy logs, and Lambda CloudWatch `$context.identity.userAgent`-adjacent logging.

**Risk:** Token leak through log retention / SIEM ingestion / browser-shared screenshots. Today the token is a single shared secret with no scope and no rotation, so a leak is account-wide.

**Recommendations:**
1. Mint short-lived, per-user signed tokens (JWT or SigV4-style) server-side; the long-lived bearer should never reach a browser.
2. Mask query strings in API Gateway access log format (`$context.requestId`, omit `$context.path`).
3. As an interim mitigation, redirect `$connect` to require the token in an initial `subscribe` frame after the WebSocket is open (auth-on-first-message). Trade-off: the connection is upgraded before authentication, opening a brief unauthenticated window.

---

### F-2. `$default` writes `authenticated: true` blindly — **Low**

**Evidence:** `src/wsConnection.ts:92-103`

```ts
const next: ConnectionRow = {
  connectionId,
  channels: payload.action === "subscribe" ? requested : [],
  filters,
  authenticated: true,         // <-- not re-checked
  connectedAt: new Date().toISOString()
};
```

**Why this matters:** API Gateway routes `$default` messages by `connectionId`, which is bound to the authenticated `$connect`, so a third party can't inject frames. But the row's `authenticated` flag is not derived from the existing row — every `subscribe`/`unsubscribe` rewrites it to `true` without reading the current state. If the column is ever used downstream as a permission gate, it can't be trusted.

**Risk:** Today: theoretical. Future: the flag is misleading and could be relied on incorrectly.

**Recommendation:** Either remove the `authenticated` column entirely (the existence of the row is sufficient evidence of a successful `$connect`) or fetch-then-set so it stays consistent with the originally-authenticated state.

---

### F-3. Unbounded `filters` JSON accepted on `$default` — **Low**

**Evidence:** `src/wsConnection.ts:81-103`

```ts
payload = event.body ? JSON.parse(event.body) : {};
...
const filters = payload.filters ?? {};
const next: ConnectionRow = { connectionId, channels: ..., filters, ... };
await documentClient.send(new PutCommand({ TableName: Resource.WsConnections.name, Item: next }));
```

**Why this matters:** `filters` is written verbatim into the connection row with no shape validation, size cap, or allow-list. A client can submit `{ "symbols": [<10k entries>] }` or arbitrary nested objects. Every broadcast Lambda subsequently runs `subscriberMatches` over this on each Kinesis batch (`src/streamConsumer.ts:107-128`), spending O(N) work per fan-out per record.

**Risk:** Single-tenant self-DoS (the misbehaving client just makes its own broadcasts slow), plus a path to inflate the WsConnections row toward the 400 KB Dynamo item cap.

**Recommendation:** Validate `filters` against a strict schema: `symbols`/`regions`/`kinds` as arrays of short strings, each capped at e.g. 50 entries, total stringified size < 4 KB. Reject violators with `400`.

---

### F-4. Kinesis streams created without customer-managed KMS — **Medium**

**Evidence:** `sst.config.ts:127-129`

```ts
const ticksStream = new sst.aws.KinesisStream("Ticks");
const signalsStream = new sst.aws.KinesisStream("Signals");
const pulseEventsStream = new sst.aws.KinesisStream("PulseEvents");
```

**Why this matters:** With no `encryption` argument, SST falls back to AWS-managed disk encryption — fine for "data is encrypted at rest" baseline, **not** sufficient for compliance regimes that require customer-managed keys (FIPS, SOC 2 type 2 with key-rotation evidence, PCI L1, HIPAA in many contracts).

**Risk:** No key-rotation audit trail, no per-stream key isolation, no path to revoke decrypt access without deleting data.

**Recommendation:** Pass an explicit `aws.kms.Key` ARN: `new sst.aws.KinesisStream("Ticks", { encryption: { type: "KMS", kmsKeyId: marketKmsKey.arn } })`. Apply the same pattern to the Dynamo tables that hold pulse snapshots, alignment rows, alerts, and positions.

---

### F-5. WebSocket spec/UI HTTP routes unauthenticated — **Low** (dev-only, but worth flagging)

**Evidence:** `src/asyncDocs.ts:6-15, 17-49`, `src/docs.ts:6-15, 17-57`, `sst.config.ts:231-235`

```ts
if ($dev) {
  api.route("GET /docs", "src/docs.ui");
  api.route("GET /openapi.json", "src/docs.spec");
  api.route("GET /asyncapi", "src/asyncDocs.ui");
  api.route("GET /asyncapi.json", "src/asyncDocs.spec");
}
```

Handlers do not call `requireBearerToken`.

**Why this matters:** Anyone who can resolve the dev API Gateway URL can read the full API + stream surface area. In production the routes are not registered at all (`$dev`-gated), so the impact is bounded to dev stages — but dev stages still expose every route, payload shape, and the Kinesis stream-name conventions.

**Recommendation:** Add `requireBearerToken` at the top of all four handlers. Cost is one helper call per request; benefit is the spec endpoint is gated by the same token that gates everything else. Same pattern as `src/stocks.ts:62`.

---

### F-6. External CDN scripts loaded without Subresource Integrity — **Medium** (supply chain)

**Evidence:** `src/docs.ts:24,32-33`, `src/asyncDocs.ts:24,29`

```ts
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui.css" />
<script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-bundle.js" crossorigin></script>
...
<script src="https://unpkg.com/@asyncapi/react-component@${HTML_TEMPLATE_VERSION}/browser/standalone/index.js"></script>
```

No `integrity="sha384-..."`; no Content-Security-Policy header on the response.

**Why this matters:** unpkg serves whatever is published under a given version path. A compromise of either package (or unpkg itself) executes JS in the docs UI. Today the UI is only rendered in dev, so the blast radius is dev-stage operator browsers — but operator credentials often include AWS console sessions.

**Recommendations:**
1. Add SRI hashes for the four script/style URLs. Update them when versions bump.
2. Add a strict CSP via the response headers: `script-src 'self' https://unpkg.com 'unsafe-inline'` (Swagger needs `unsafe-inline` for its bootstrap; tighten with a nonce).
3. Better: vendor the assets into a static bundle served from the API itself.

---

### F-7. `WsConnections` has no DynamoDB TTL — **Low** (operational)

**Evidence:** `sst.config.ts:118-125`

```ts
const wsConnections = new sst.aws.Dynamo("WsConnections", {
  fields: { connectionId: "string" },
  primaryIndex: { hashKey: "connectionId" }
});
```

No `ttl` / `expiresAt` field.

**Why this matters:** Stale rows accumulate. Broadcast Lambdas (`src/streamConsumer.ts:89-101`) scan the whole table on every batch; an unbounded row count costs latency and Dynamo RCUs linearly. Stale rows are pruned only on `$disconnect` events or HTTP-410 responses to `PostToConnection` (`src/wsConnection.ts:122-131`), neither of which fires for connections that vanish silently (network drops, force-quits).

**Recommendation:** Add an `expiresAt` epoch column (e.g. `connectedAt + 24h`), enable Dynamo TTL on that attribute. Update on every `$default` activity.

---

### F-8. `BroadcastTicks/Signals/PulseEvents` scan-on-every-batch — **Low** (DoS amplifier)

**Evidence:** `src/streamConsumer.ts:89-101`

```ts
const subscribers = await loadSubscribers(channel);   // ScanCommand on WsConnections
...
for (const record of records) {
  for (const subscriber of subscribers) {
    if (!subscriberMatches(...)) continue;
    await sendTo(endpoint, subscriber.connectionId, ...);
  }
}
```

**Why this matters:** Every Kinesis batch (default 100 records) triggers a full Dynamo Scan plus N×M `PostToConnection` calls. Cost: O(records × connections × shards × cron-rate). At low scale fine; bursty workloads, table grows, or many tabs open quickly multiply Lambda duration → throttling → backpressure.

**Recommendation:** Maintain a `channel`-keyed GSI on `WsConnections` and `Query` instead of `Scan`. Alternative: an in-Lambda cache invalidated every N seconds.

---

### F-9. `POST /industries/backfill` is unbounded outbound work — **Medium**

**Evidence:** `src/industries.ts:33-92` (loop body), `src/industries.ts:156-198` (FMP calls)

```ts
const industries = await fetchIndustries(apiKey);
...
for (const industry of industries) {
  const screened = await fetchScreener(apiKey, industry);   // 1+ FMP call per industry
  ...
  for (const screen of screened) {
    await upsertStockMinimal({...});                         // 1 Dynamo write per stock
    ...
  }
}
```

**Why this matters:** A single authenticated request can spin out hundreds of FMP API calls (one per industry) plus thousands of Dynamo writes. Cost is real (FMP rate-limit, Lambda duration, Dynamo WCU). The Bearer token is shared, so any caller of the API can trigger this.

**Risk:** Cost amplification, potential FMP key throttling, Lambda timeout if industry count grows.

**Recommendations:**
1. Move to async: enqueue an SQS message, return `202 Accepted` with a job ID, process asynchronously with bounded concurrency.
2. Add an idempotency token / cursor so retries don't re-run from scratch.
3. Rate-limit the route at API Gateway: `Throttling: { burstLimit: 1, rateLimit: 0.1 }` (one every 10 seconds is plenty for a backfill).

---

### F-10. No API Gateway rate limiting on any route — **Medium**

**Evidence:** `sst.config.ts:201-274` — no `transform.api.throttle` or per-route throttling parameters.

**Why this matters:** The current bearer is a single shared secret; one leak ⇒ unthrottled access to all routes including the heavy ones (`POST /industries/backfill`, `POST /pulse/refresh`, `POST /stocks/batch`).

**Recommendation:** Configure default throttling at the API Gateway level (e.g. 50 rps burst, 10 rps sustained per token), with per-route overrides for write endpoints. SST exposes this via `transform.api`.

---

### F-11. No CORS / origin policy on REST or WebSocket APIs — **Low**

**Evidence:** `sst.config.ts:201-225` — no `cors` block on `ApiGatewayV2`; `sst.config.ts:292` — no origin allow-list on `ApiGatewayWebSocket`.

**Why this matters:** Both APIs are token-gated, so cross-origin requests still need the bearer. CORS is therefore not a primary defense. Still: browsers will refuse CORS-blocked requests by default, and lack of an explicit policy means anything browser-driven that ought to be allowed (Remix from a known origin) requires the developer to set CORS at run time.

**Recommendation:** Set a strict allow-list once the production frontend origin is known.

---

### F-12. Lambda Function URLs / outputs leak management endpoint — **Info**

**Evidence:** `sst.config.ts:331-336`

```ts
return {
  api: api.url,
  realtime: realtime.url,
  ...
};
```

Stack outputs include URLs; not secret in themselves, but anyone with `cloudformation:DescribeStacks` permission in the account can enumerate them. Already-default AWS behaviour; flagged here for completeness.

---

## Pre-existing findings (delta vs `security-TODO.md`)

The earlier [`security-TODO.md`](./security-TODO.md) covers the baseline: single shared bearer token, no Cognito/JWT, no WAF, no per-route scopes, broad CORS posture, etc. Everything documented there still applies. The Kinesis / WebSocket additions did not regress any of those controls, with one exception:

- **Spec surface widened.** Before this work the dev-only `/openapi.json` exposed REST routes. Now `/asyncapi.json` additionally exposes Kinesis stream names and the WebSocket frame protocol. Same severity, larger blast radius. Tracked under **F-5** above.

---

## Not assessable from this repo

Items that require AWS console / Terraform state / CloudTrail to verify:

- Whether API Gateway access-log format strips query strings (relates to **F-1**).
- Whether CloudWatch log retention is set to a non-default value.
- Whether CloudTrail data events are enabled for the three Kinesis streams.
- Whether the AWS account has SCPs blocking unencrypted Kinesis / Dynamo (compliance baseline).
- Whether MFA is enforced on all IAM principals that can call `kinesis:GetRecords` outside SST-managed Lambdas.
- Whether KMS key rotation is enabled on any customer-managed keys (relates to **F-4**).
- Whether VPC endpoints exist for `kinesis-streams`, `execute-api`, `dynamodb` (data-plane stays in-VPC).
- API Gateway WAF / shield association.

---

## Severity-sorted action list

| # | Severity | Finding | Fix size |
| --- | --- | --- | --- |
| F-1 | **High** | WS bearer in query string | Medium (mint short-lived tokens) |
| F-4 | Medium | Kinesis streams without customer-managed KMS | Small (1 line per stream + key) |
| F-6 | Medium | External CDN scripts without SRI / CSP | Small (4 hashes + header) |
| F-9 | Medium | Unbounded backfill route | Medium (async + idempotency) |
| F-10 | Medium | No API Gateway rate limiting | Small (one `transform.api` block) |
| F-2 | Low | `$default` writes `authenticated: true` blindly | Trivial |
| F-3 | Low | Unvalidated `filters` JSON | Small (schema) |
| F-5 | Low | Spec/UI routes unauthenticated (dev-only) | Trivial |
| F-7 | Low | `WsConnections` has no TTL | Small (one field + Dynamo TTL) |
| F-8 | Low | Broadcasters Scan-on-every-batch | Small-medium (GSI) |
| F-11 | Low | No CORS policy | Trivial once origins known |
| F-12 | Info | Stack outputs visible | None (acceptable default) |

---

**Next:** the items tagged in `doc/TODO.md` under "Security" already cover the F-1/F-9/F-10 family at a higher level. Recommend mirroring F-2, F-3, F-4, F-5, F-6, F-7, F-8 into `doc/TODO.md` so they're tracked alongside the pre-existing security backlog.
