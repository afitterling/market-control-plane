# Signals

A **signal** is a named action that the control plane emits when a domain state transition occurs. Each emission is persisted as an event on the global event stream and made available to clients through long-poll subscriptions.

Signals are fire-and-record: the emitting handler writes the event row synchronously before responding to the caller, so the eventId returned in the API response is guaranteed to be readable through `GET /events` immediately.

## Catalog

| Signal | Emitted by | Trigger | Payload |
| --- | --- | --- | --- |
| `STCO_NEW_ADDED` | `POST /stocks`, `POST /stocks/batch` | First time a `symbol` is written to the `Stocks` cache table | `{ action: "STCO_NEW_ADDED", symbol }` |
| `STCO_PROCESS_STOCK` | `POST /stocks`, `POST /stocks/batch` | Fired in the same request as `STCO_NEW_ADDED`. Marks the stock as `processingState="being_processed"` and asynchronously invokes the `ProcessStock` Lambda. | `{ action: "STCO_PROCESS_STOCK", symbol }` |
| `STCO_DATA_PULLED` | `ProcessStock` Lambda | The processor finished fetching all annual + quarterly earnings from FMP and stored them in the `Earnings` table. Stock row flips to `processingState="data_pulled"`. | `{ action: "STCO_DATA_PULLED", symbol, annualCount, quarterlyCount }` |
| `STCO_PROCESS_FAILED` | `ProcessStock` Lambda | The processor failed (FMP error, missing API key, etc). Stock row flips to `processingState="process_failed"` with `processingError` set. | `{ action: "STCO_PROCESS_FAILED", symbol, error }` |
| `SIGN_ALERT_RAISED` | `EvaluateAlerts` cron | An enabled `SignalAlerts` rule matched during a market session. | `{ action: "SIGN_ALERT_RAISED", alertId, name, session, matchedSymbols?, detail? }` |
| `SIGN_ALERT_TICK_SKIPPED` | `EvaluateAlerts` cron | The evaluator tick fired outside any market session and was skipped. | `{ action: "SIGN_ALERT_TICK_SKIPPED", reason: "market_closed", at }` |
| `PULSE_REGION_UPDATED` | `PullPulse` cron | A region's pulse cache row was rewritten and its `status` band changed (or transitioned out of `stale`). | `{ action: "PULSE_REGION_UPDATED", region, previousStatus, status, criticality, severity, articleCount, summary }` |
| `PULSE_REGION_STALE` | `PullPulse` cron | A region has had no fresh news for 4+ hours — its cache row was flagged `stale: true`. | `{ action: "PULSE_REGION_STALE", region, lastNewsAt, hoursSinceLastNews }` |

### `STCO_NEW_ADDED`

Fired when a stock symbol is inserted for the first time. Re-posting the same symbol does **not** re-emit the signal — the cached record (including the `executedActions` from the original insert) is returned instead.

The eventId of the emission is persisted on the stock row under `executedActions` and is also returned in the POST response so a client that just inserted the stock can immediately subscribe and receive its own emission.

### `STCO_PROCESS_STOCK`

Fired immediately after `STCO_NEW_ADDED` in the same POST request. The stock row is written with `processingState="being_processed"` and the `ProcessStock` Lambda is asynchronously invoked (`InvocationType: "Event"`) with `{ symbol }`. The POST response returns to the client without waiting for the backfill.

### `STCO_DATA_PULLED`

Fired by the `ProcessStock` Lambda once it has fetched all annual and quarterly income statements from Financial Modeling Prep, written them to the `Earnings` table (one row per `symbol#period`), and updated the stock row with:

- `processingState = "data_pulled"`
- `dataPulledAt` — ISO timestamp of completion
- `annualReportCount`, `quarterlyReportCount`

Clients that long-polled on the `STCO_PROCESS_STOCK` eventId will keep polling and receive this event when the backfill finishes.

### `STCO_PROCESS_FAILED`

Fired by the `ProcessStock` Lambda when the FMP fetch or the DynamoDB write fails. The stock row flips to `processingState="process_failed"` and stores the error message in `processingError`. Lambda then re-throws so the AWS retry policy kicks in (a successful retry produces `STCO_DATA_PULLED` and clears the failure state).

## Stock POST cache semantics

`POST /stocks` is idempotent and behaves as a write-through cache keyed by `symbol`:

- **Cache miss** (symbol not present) → write row, emit `STCO_NEW_ADDED`, return `201` with the new row, the executed actions, and a `subscribe` block pointing at the event stream.
- **Cache hit** (symbol already present) → return `200` with the cached row and the executed actions that were recorded on the original insert. No write, no re-emission.

![Stock POST cache and emission flow](diagrams/stock-post-flow.svg)

Source: [diagrams/stock-post-flow.mmd](diagrams/stock-post-flow.mmd)

## Subscribing to signals

Every POST response that emitted or recorded a signal carries a `subscribe` block:

```json
{
  "subscribe": {
    "method": "long-poll",
    "pollUrl": "/events?from=2026-05-10T12:00:00.000Z%23<uuid>&waitSeconds=25",
    "waitSeconds": 25,
    "eventIds": ["2026-05-10T12:00:00.000Z#<uuid>"]
  }
}
```

The client follows `pollUrl` to read the emitted event(s). The `from` cursor is **inclusive**, so the first long-poll call returns the event the POST just emitted.

### Why long-poll instead of SSE

API Gateway HTTP API does not stream responses to clients, so a true Server-Sent Events stream cannot be served from this stack without changing the ingress (Lambda function URLs with response streaming, ALB, or WebSocket API). Long-polling against `/events` provides the same effective semantics — the connection stays open up to `waitSeconds=25`, returns as soon as a matching event lands, and the client immediately re-issues the request with the new `nextCursor`.

### Polling loop

![Event polling loop](diagrams/polling-loop.svg)

Source: [diagrams/polling-loop.mmd](diagrams/polling-loop.mmd)

## Cursor parameters

| Param | Semantics | When to use |
| --- | --- | --- |
| `from` | Inclusive — returns events with `eventId >= from` | First call after a POST, when you want the event you just emitted |
| `after` | Exclusive — returns events with `eventId > after` | Subsequent polls, using the previous `nextCursor` |

`from` and `after` are mutually exclusive in a single request.

## Stock processing state

Stocks created through `POST /stocks` (or `POST /stocks/batch`) carry a `processingState` field that tracks the asynchronous earnings backfill:

| State | Set by | Meaning |
| --- | --- | --- |
| `being_processed` | `POST /stocks` on cache miss | The row was created and `ProcessStock` was invoked. Earnings backfill is in flight. |
| `data_pulled` | `ProcessStock` Lambda on success | Annual + quarterly earnings have been fetched from FMP and stored in the `Earnings` table. |
| `process_failed` | `ProcessStock` Lambda on failure | FMP fetch or DB write failed. See `processingError` on the row. |

The state transitions are mirrored on the signal stream — clients can either poll `GET /stocks/{symbol}` for the current state or long-poll the event stream for the corresponding `STCO_*` signals.

## Earnings store

The `Earnings` DynamoDB table is keyed by `(symbol, period)` where `period` is one of:

- `ANNUAL#<reportDate>` — annual income statement
- `QUARTER#<reportDate>` — quarterly income statement

Each row contains the canonical line items extracted from the FMP income statement (`revenue`, `grossProfit`, `operatingIncome`, `netIncome`, `eps`, `epsDiluted`, `reportedCurrency`, `fiscalPeriod`, `calendarYear`), plus the full FMP payload under `raw` and a `fetchedAt` timestamp. Read via `GET /earnings/{symbol}`.

## Market pulse

The `PullPulse` cron runs every 20 minutes, pulls the FMP news feed (`/api/v3/stock_news` + `/api/v4/general_news`), and aggregates the result into a per-region cache stored in the `MarketPulse` DynamoDB table (PK: `region`).

### Pipeline

For every article published in the last 20 minutes, the cron:

1. **Extracts regions** from the headline + body via a keyword/alias dictionary (e.g. `Germany`, `Middle East`, `Latin America`).
2. **Extracts themes** (war, sanctions, default, recession, rate_hike, cyberattack, …) by the same dictionary mechanism.
3. **Scores sentiment** through a deterministic positive/negative hint list.
4. **Aggregates per region**: sums weighted theme severity/criticality, applies a small reach boost based on article count, clamps to 0–100, then maps the higher of the two scores to a status band: `calm` (<25) → `watch` (25–49) → `elevated` (50–69) → `critical` (≥70).

The v1 extractor is intentionally rule-based and deterministic. The repo-level plan (see [`README.md`](../README.md#4-ai-models)) is to swap this for the FAU-pruned NER + sentiment model behind the same interface.

### Cache semantics

- **Cache is rewritten every 20 minutes** for every region that had at least one article in the window — `PutCommand` overwrites the prior row entirely.
- **No news for 4 hours or more → marked stale.** After the fresh-region passes, the cron scans the table; any region whose `lastNewsAt` is older than 4h is rewritten with `stale: true`, `staleSince`, and a summary explaining how many hours have passed. The row is *not* deleted — historical context (links, scores) remains available, just flagged.
- When stale data eventually receives fresh news, the next run rewrites the row with `stale: false` and emits `PULSE_REGION_UPDATED` because the staleness flag flipped.

### Row shape

```json
{
  "region": "Middle East",
  "status": "elevated",
  "criticality": 58,
  "severity": 47,
  "articleCount": 6,
  "topThemes": ["sanctions", "energy_shock"],
  "summary": "Middle East elevated — 6 articles in window, themes: sanctions, energy_shock.",
  "links": [
    {
      "title": "OPEC+ signals deeper cuts amid Gulf tensions",
      "url": "https://example.com/opec-cuts",
      "site": "example.com",
      "publishedAt": "2026-05-11T08:14:00.000Z",
      "sentiment": -3,
      "themes": ["energy_shock", "sanctions"]
    }
  ],
  "windowStart": "2026-05-11T07:55:00.000Z",
  "windowEnd": "2026-05-11T08:15:00.000Z",
  "lastNewsAt": "2026-05-11T08:14:00.000Z",
  "stale": false,
  "updatedAt": "2026-05-11T08:15:01.103Z"
}
```

## Signal alerts

User-defined rules live in the `SignalAlerts` DynamoDB table and are evaluated by the `EvaluateAlerts` cron every 30 minutes — but **only during US market sessions** (in `America/New_York` time, Mon-Fri):

| Session | Window (ET) |
| --- | --- |
| `premarket` | 04:00 – 09:30 |
| `regular` | 09:30 – 16:00 |
| `afterhours` | 16:00 – 20:00 |

Outside those windows (overnight gap 20:00–04:00, and all of Saturday/Sunday) the cron fires but emits a `SIGN_ALERT_TICK_SKIPPED` event and does no work. Public-holiday closures are not yet modelled — alerts will still evaluate on US market holidays.

### Alert row shape

```json
{
  "alertId": "a3a0f4c2-…",
  "name": "AAPL gap up > 2% premarket",
  "description": "Free-text explanation shown alongside the raised alert.",
  "enabled": true,
  "sessions": ["premarket", "regular"],
  "scope":    { "symbols": ["AAPL"] },
  "condition": { "...": "TBD — rule body shape is intentionally open" },
  "createdAt": "2026-05-11T08:00:00.000Z",
  "updatedAt": "2026-05-11T08:00:00.000Z"
}
```

`condition` is intentionally typed as `unknown` for now — the rule grammar (price thresholds, MACD-quality predicates, fundamental triggers, multi-condition AND/OR) is yet to be defined. The evaluator currently treats every rule with a non-empty `condition` as a stub (no match), so rolling out a rule grammar is a pure addition without breaking the storage or signal contract.

### What gets emitted

For every rule that matches in the current session, the evaluator emits `SIGN_ALERT_RAISED` with `{ alertId, name, session, matchedSymbols?, detail? }`. Downstream consumers subscribe through `GET /events` like any other signal.

## MACD pipeline

For each stock, MACD(12,26,9) is computed across eight timeframes and stored on the `Stocks` row under `macd`:

| Timeframe | FMP source | Aggregation |
| --- | --- | --- |
| `5m` | `historical-chart/5min` | — |
| `20m` | `historical-chart/5min` | 4 × 5min bars |
| `30m` | `historical-chart/30min` | — |
| `1h` | `historical-chart/1hour` | — |
| `2h` | `historical-chart/1hour` | 2 × 1hour bars |
| `4h` | `historical-chart/4hour` | — |
| `1d` | `historical-price-full` | — |
| `1w` | `historical-price-full` | 5 × daily bars |

The reading per timeframe is:

```json
{
  "macd": -0.124,
  "signal": -0.088,
  "histogram": -0.036,
  "previousHistogram": -0.028,
  "quality": "bearish",
  "asOf": "2026-05-11 09:00:00",
  "sampleSize": 312
}
```

### Quality categories

Quality is derived from the relationship between MACD, signal, histogram, and the *change* in histogram against the previous bar:

| Category | Meaning |
| --- | --- |
| `strong_bullish` | MACD above signal, both lines above zero, histogram expanding, strength > 25% of MACD magnitude |
| `bullish` | MACD above signal, histogram strength > 5% of MACD magnitude |
| `neutral_bullish` | MACD above signal but histogram small (potential weakening uptrend or early cross) |
| `neutral_bearish` | MACD below signal but histogram small (potential weakening downtrend or early cross) |
| `bearish` | MACD below signal, histogram strength > 5% |
| `strong_bearish` | MACD below signal, both lines below zero, histogram expanding, strength > 25% |
| `insufficient_data` | Fewer than 40 closing prices were available from FMP for that interval |

### Triggers

The MACD readings are refreshed in two ways:

1. **On stock entry.** The `ProcessStock` Lambda calls `processMacd` after the earnings backfill completes, so a freshly entered stock has a full set of MACD readings as soon as `STCO_DATA_PULLED` fires.
2. **15-minute cron.** The `PullMacd` EventBridge cron runs every 15 minutes, scans the `Stocks` table, and recomputes the MACD readings for every symbol with bounded concurrency (4 symbols in flight at a time).

## Real-time prices

A `PullPrices` cron runs on an EventBridge `rate(1 minute)` schedule. EventBridge does not support sub-minute schedules, so the cron lambda runs **two passes per invocation, 30 seconds apart**, giving an effective 30-second refresh cadence.

Each pass scans the `Stocks` table for symbols, batches them into FMP `/quote/{symbols}` requests (up to 100 symbols per call), and writes the following fields back to each stock row:

- `price`, `dailyChange`, `dailyChangePercent`
- `dayLow`, `dayHigh`, `openPrice`, `previousClose`, `lastVolume`
- `priceUpdatedAt`

Quotes for symbols that are not in the `Stocks` table (or that FMP does not return) are silently skipped. Failures hitting FMP are logged but do not abort the pass — partial updates are preferable to none.
