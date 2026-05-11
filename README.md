# Market Control Plane

_Last updated: 2026-05-11_

An allocation market control plane that processes financial data — Financial Modeling Prep feeds and other inputs — and exposes it to downstream trading platforms.

The system:

- detects macro regimes
- interprets geopolitical shifts
- evaluates company fundamentals
- dynamically aligns allocation

The control plane is the policy and signal layer: it ingests market and fundamental data, classifies the current regime, scores instruments, and emits allocation signals that execution venues consume. Trading platforms remain responsible for order routing and execution; the control plane decides *what* should be held and *why*.

## 1. Market Regime Detection Capabilities

The system can detect:

- **Risk-On / Risk-Off** — cross-asset behaviour that distinguishes capital seeking yield from capital seeking safety.
- **Inflationary environments** — sustained price-level shifts that change the relative attractiveness of real assets, duration, and cash.
- **Liquidity-driven markets (QE/QT)** — periods where central-bank balance-sheet direction dominates fundamentals.
- **Geopolitical instability regimes** — conflict, sanctions, trade-bloc realignment, and the volatility cluster that follows.

Each detected regime becomes a signal on the event stream that allocation rules and downstream platforms can subscribe to.

## 2. Fundamental Qualification

The system ingests quarterly and yearly earnings reports, processes the data, and builds per-issuer qualifications:

- normalises filings across reporting standards and currencies
- extracts the canonical line items (revenue, margins, free cash flow, debt, guidance) and the period-over-period deltas
- derives qualification scores — growth, profitability, balance-sheet strength, earnings-quality — that the allocation engine combines with the prevailing regime

Each new filing that materially changes an issuer's qualification is emitted as a signal on the event stream, so downstream consumers do not need to re-pull fundamentals to react.

## 3. Market Pulse

The system reads the Financial Modeling Prep news feed on a 20-minute cadence and derives a rolling market pulse from it:

- dedupes and clusters headlines by issuer, sector, and macro theme
- scores each cluster for sentiment, novelty, and reach
- aggregates into a pulse index that surfaces what the market is reacting to right now and how strongly

Notable shifts in the pulse — for an issuer, a sector, or the broader tape — are emitted as signals on the event stream so the regime detector and allocation engine can react inside the same 20-minute window.

## 4. AI Models

The classifiers, scorers, and pulse aggregators run on **pruned models curated by AI experts at Friedrich-Alexander-Universität Erlangen-Nürnberg (FAU)**. Rather than training from scratch or paying for full-size foundation-model inference, the control plane consumes pruned variants as drop-in inference artifacts.

Pruning removes the weights and substructures that contribute least to a given task, producing models that are:

- **faster** — lower inference latency, which makes the 20-minute pulse cadence and per-filing scoring feasible at scale
- **lightweight** — typically a 5–20× parameter reduction over the source model, with a correspondingly smaller memory footprint and shorter Lambda cold starts
- **less prone to hallucination** — removing the parameters that encode broad off-task associations narrows the model to its in-domain behaviour, so outputs stay closer to the calibration data and away from fabricated content
- **accuracy-comparable** to the unpruned baseline on the in-domain tasks they are tuned for

The FAU workflow handles calibration-data selection, layer-wise sensitivity analysis, and post-prune fine-tuning, so this repository only needs to ship the model artifact and an inference adapter. The current pruned-model surface covers:

| Task | Model role |
| --- | --- |
| News understanding | Headline embedding, sentiment, named-entity linking for the market-pulse pipeline. |
| Fundamentals scoring | Tabular/structured-data model that produces the qualification scores from extracted filing line items. |
| Regime classification | Time-series classifier that ingests cross-asset features and emits regime labels. |

## Architecture (current scope)

This repository is the first slice of the control plane: an SST v3 API on AWS that stores reference data (stocks, positions) in DynamoDB and emits domain signals through an append-only event stream. See [`doc/signals.md`](doc/signals.md) for the signal catalogue and sequence diagrams, and [`doc/api.md`](doc/api.md) for full route documentation.

Layers planned on top of this base:

| Layer | Purpose |
| --- | --- |
| **Ingest** | Pull Financial Modeling Prep + alternative inputs into the `Stocks` cache and a fundamentals store. |
| **Regime detection** | Macro, inflation, liquidity, and geopolitical classifiers that emit regime signals. |
| **Fundamental scoring** | Per-issuer scoring driven by FMP fundamentals + regime context. |
| **Allocation engine** | Combines scores + regime to produce target weights. |
| **Execution adapters** | Translate target weights into orders for trading platforms. |

### Background jobs

The stack runs three EventBridge-driven background jobs out of the box:

| Job | Cadence | What it does |
| --- | --- | --- |
| `ProcessStock` (async Lambda) | On first `POST /stocks` for a symbol | Runs the **fundamentals** pipeline: pulls all annual + quarterly **income statements and cash flow statements** from FMP, computes margins (gross/operating/net), free-cash-flow metrics, period-over-period deltas, and a deterministic narrative for every period, and writes them to the `Earnings` table. Also delegates the initial MACD seed to the prices/technicals pipeline so technicals exist on entry. Transitions the stock through `being_processed` → `data_pulled`. |
| `PullPrices` | Every 30 s (1 min cron, 2 passes per invocation) | Part of the **prices / technicals** pipeline. Fetches FMP real-time quotes and writes `price`, `dailyChange`, `dailyChangePercent` (and OHLC + volume) onto every `Stocks` row. |
| `PullMacd` | Every 15 min | Part of the **prices / technicals** pipeline. Recomputes MACD(12,26,9) on `5m`, `20m`, `30m`, `1h`, `2h`, `4h`, `1d`, `1w` for every stock and categorises each reading (`strong_bullish` … `strong_bearish`). |
| `EvaluateAlerts` | Every 30 min, US market sessions only | Evaluates user-defined rules stored in the `SignalAlerts` table during premarket (04:00–09:30 ET), regular (09:30–16:00) and afterhours (16:00–20:00). Ticks outside session windows are skipped. |
| `PullPulse` | Every 20 min | Polls FMP news, extracts regions + themes per article, scores criticality/severity, writes a per-region row to `MarketPulse` with the source article links. Regions with no fresh news for 4+ hours are flagged `stale`. |

See [`doc/signals.md`](doc/signals.md) for the full state machine, signal payloads, and MACD quality rules.

### Orchestration: AWS Step Functions

The regime detectors, fundamental qualifier, and market-pulse aggregator each run as state machines on AWS Step Functions. Step Functions does not perform triangulation by itself — it *orchestrates* it: a `Parallel` state fans a single classification request out to independent data sources (FMP news, fundamentals, price action, macro feeds) in parallel, and a downstream task fans the results back in to cross-confirm a signal before it is committed to the event stream. Retries, timeouts, and partial-failure handling are declarative state-machine concerns rather than per-Lambda code.

## Commands

```sh
npm install
npm run setup
npm run dev
npm run deploy
```

## Auth

All API requests require this header:

```sh
Authorization: Bearer $API_BEARER_TOKEN
```

The token is read from `.env`. Security caveats and TODOs are tracked in [`doc/security-TODO.md`](doc/security-TODO.md).

## API

Detailed API documentation lives in [`doc/api.md`](doc/api.md). Signal semantics are described in [`doc/signals.md`](doc/signals.md).

- `GET /` health check
- `GET /events` poll or long-poll the signal stream
- `GET /stocks` list stocks
- `GET /stocks/{symbol}` get one stock
- `POST /stocks` idempotent cache-or-create for one stock (emits `STCO_NEW_ADDED` + `STCO_PROCESS_STOCK` on first insert and kicks off the earnings + MACD backfill)
- `POST /stocks/batch` idempotent cache-or-create in batches of 25
- `GET /earnings/{symbol}` list earnings reports for a symbol (annual + quarterly, optional `kind=ANNUAL|QUARTER`)
- `GET /alerts`, `POST /alerts`, `GET /alerts/{alertId}`, `DELETE /alerts/{alertId}` manage signal-alert rules (evaluated every 30 min during US market sessions)
- `GET /pulse`, `GET /pulse/{region}` read the per-region market-pulse cache (refreshed every 20 min, stale after 4 h without news)
- `GET /positions` list positions
- `GET /positions?accountId={accountId}` list positions for one account
- `GET /positions/{accountId}/{symbol}` get one position
- `POST /positions` upsert one position

## Payloads

Single stock:

```json
{
  "symbol": "AAPL",
  "name": "Apple Inc.",
  "exchange": "NASDAQ",
  "currency": "USD",
  "sector": "Technology",
  "industry": "Consumer Electronics",
  "metadata": {
    "source": "fmp"
  }
}
```

Batch stocks:

```json
{
  "stocks": [
    { "symbol": "AAPL", "name": "Apple Inc." },
    { "symbol": "MSFT", "name": "Microsoft Corp." }
  ]
}
```

Position:

```json
{
  "accountId": "default",
  "symbol": "AAPL",
  "quantity": 10,
  "averageCost": 185.5,
  "currency": "USD"
}
```

## License

Copyright (C) 2026 Alex Fitterling.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/agpl-3.0.html>. The full text is also included in [`LICENSE`](LICENSE).

Because the AGPL covers network use: if you run a modified version of this control plane and expose it over a network to users, you must offer those users access to the corresponding source.
