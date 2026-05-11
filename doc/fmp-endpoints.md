# Financial Modeling Prep — endpoint inventory

All FMP integrations target the `stable/*` endpoint family. Legacy
`/api/v3/*` and `/api/v4/*` paths return HTTP 401/403 for any API key
created after August 31, 2025 and must not be used.

## Endpoints used by this project

| Module / function                | Stable endpoint                                       | Notes                                  |
| -------------------------------- | ----------------------------------------------------- | -------------------------------------- |
| `pulse.fetchRecentNews`          | `/stable/news/general-latest?page=0&limit=100`        | World/general news, paged.             |
| `pulse.fetchRecentNews`          | `/stable/news/stock-latest?page=0&limit=100`          | Stock-tagged news, paged.              |
| `marketData.fetchQuotes`         | `/stable/batch-quote?symbols=A,B,C`                   | Comma-separated symbols, single call.  |
| `prices.fetchQuotes`             | `/stable/batch-quote?symbols=A,B,C`                   | Same endpoint, batched per 100.        |
| `macd.fetchCandles` (daily)      | `/stable/historical-price-eod/full?symbol=SYM`        | Returns flat array (no `historical`).  |
| `macd.fetchCandles` (intraday)   | `/stable/historical-chart/{interval}?symbol=SYM`      | `interval` ∈ `5min`, `30min`, `1hour`, `4hour`. |
| `processor.fetchIncomeStatement` | `/stable/income-statement?symbol=SYM&period=...`      | `period` ∈ `annual`, `quarter`.        |
| `processor.fetchCashFlowStatement` | `/stable/cash-flow-statement?symbol=SYM&period=...` | Same parameters.                       |

## Field renames vs legacy

Stable payloads renamed two fields relevant to this project:

| Legacy field         | Stable field        | Used in                                                                |
| -------------------- | ------------------- | ---------------------------------------------------------------------- |
| `changesPercentage`  | `changePercentage`  | `marketData.ts`, `prices.ts`                                            |
| `historical[*]`      | top-level array     | `macd.ts` (daily candles — no longer wrapped in `historical`)           |

## Date format

News and intraday endpoints return `publishedDate` / `date` as
`"YYYY-MM-DD HH:mm:ss"` (UTC, no timezone marker). `Date.parse`
interprets that string as local time, which yields the wrong instant on
non-UTC hosts. `pulse.ts` normalises through `parseFmpDate(value)`
which rewrites the value to `YYYY-MM-DDTHH:mm:ssZ` before parsing.

## What is cached vs. fetched live

`POST /pulse/refresh` and the `PullPulse` cron run the full pipeline:

1. News fetch (always live — `general-latest` + `stock-latest`)
2. Articles older than the 4-hour news window are dropped before
   region extraction. The 4 h window matches the `MarketPulse` stale
   threshold, so a region cannot stay "active" on news the system
   considers stale.
3. Region extraction and per-region scoring
4. Market data (VIX, SPDR sector ETFs, FX, oil, gold via
   `/stable/batch-quote`) — **reused from the latest
   `MarketPulseSnapshot` if `marketData.fetchedAt` is less than one
   hour old and the cached payload is non-empty (`vix` not null, or
   any sector/FX data present)**, otherwise fetched fresh. The
   non-empty check prevents a failed fetch from poisoning the cache.
5. Snapshot persisted to `MarketPulseSnapshot` (retention: latest 100)

All `GET /pulse*` routes read exclusively from DynamoDB — they never
call FMP.

## Authentication failure to watch for

A legacy `/api/v3/*` or `/api/v4/*` URL on a post-Aug-2025 key returns:

```json
{
  "Error Message": "Legacy Endpoint : Due to Legacy endpoints being no longer supported..."
}
```

with HTTP 401 or 403. If a new symbol or report ever surfaces this
error, the corresponding fetch helper has slipped back to a legacy path
and needs to be re-pointed at `/stable/...`.
