# Market Control Plane

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
- `POST /stocks` idempotent cache-or-create for one stock (emits `STCO_NEW_ADDED` on first insert)
- `POST /stocks/batch` idempotent cache-or-create in batches of 25
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
