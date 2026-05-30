# Narratives

Assessment narratives defined in [`src/assessments.ts`](src/assessments.ts), grouped by strategy.
Each narrative pairs with its strategy's preconditions and is executed via
`POST /assessments/{strategy}/{narrative}`.

## 📊 Value Investing Assessment (`value`)

Identify profitable businesses where sentiment has overcorrected the price relative to the
durable cash-flow base.

**Preconditions:** `PROFITABLE`, `PRICE_DECLINE`, `SENTIMENT_DRIVEN`, `CASH_FLOW_STABLE`, `NO_STRUCTURAL_THREAT`

| Narrative | ID | Description | Valuation levers |
|-----------|----|-------------|------------------|
| 💰 Sentiment Overcorrection on Profitable Business | `sentiment-overcorrection` | Sentiment-driven sell-off of a profitable business whose cash flows never deteriorated; mean reversion to fair value is the return mechanism. | DCF, EV/EBITDA, P/FCF |
| 🏰 Quality Compounder De-Rating | `quality-derating` | A durable, high-return compounder whose multiple compressed on a growth scare or factor rotation while the economics stayed intact; re-rating toward its historical band is the return mechanism. | Forward P/E vs own 5y band, EV/EBIT, ROIC × reinvestment runway |
| 🔄 Cyclical Trough Mispricing | `cyclical-trough` | A cyclical near the bottom of its cycle where the market extrapolates depressed trough earnings as permanent; normalized mid-cycle earnings power reveals the gap and normalization is the return mechanism. | Normalized mid-cycle EPS, Price/tangible book vs cycle, Through-cycle FCF / replacement value |
| 💸 Underappreciated Capital Return | `capital-return` | A profitable, cash-generative business shrinking its share count and/or growing its dividend at a high FCF yield the market ignores; buyback-driven EPS accretion plus yield is the return mechanism. | FCF yield, Buyback-adjusted EPS accretion, Shareholder yield |

### Stages — Cyclical Trough Mispricing
- **Down-Cycle** — earnings falling, estimates still being cut
- **Trough** — earnings depressed/negative, inventories peaking, sentiment capitulating
- **Early Recovery** — orders/pricing inflecting, estimates beginning to rise

## 🚀 Catalyst-Based Assessment (`catalyst`)

Identify pre-profitable (or sub-scale) businesses where revenue growth, narrowing losses, and
operating leverage are converging on an inflection.

**Preconditions:** `REVENUE_GROWING`, `EPS_NARROWING`, `GROSS_MARGIN_STABLE`, `OPERATING_LEVERAGE`, `NO_ONE_TIME_ITEMS`, `BALANCE_SHEET_SURVIVES`

| Narrative | ID | Description | Valuation levers |
|-----------|----|-------------|------------------|
| ⚡ EPS Crossover — Loss to Profit Turnaround | `eps-crossover` | Loss-to-profit EPS crossover where the market is forced to re-rate from a revenue multiple onto an earnings multiple. | EV/Sales → forward P/E bridge, Operating leverage model, Crossover quarter estimate |
| 📈 Margin Inflection — Operating Leverage Unlock | `margin-inflection` | An already-profitable, revenue-growing business hitting the scale point where a heavy fixed-cost base converts incremental revenue into disproportionate margin and EPS expansion ahead of consensus; upward estimate revisions are the return mechanism. | Incremental operating margin, Opex growth vs revenue growth, Forward EPS on normalized margins |

### Stages — EPS Crossover
- **Pre-Crossover** — losses narrowing, not yet profitable (e.g. TYGO)
- **At Crossover** — first positive EPS print, consensus beat (e.g. TBLA Q1 2026)
- **Post-Crossover** — sustained profitability, multiple expansion continues

### Stages — Margin Inflection
- **Pre-Inflection** — revenue growing, margins flat, fixed costs still absorbed
- **At Inflection** — incremental margins jump, estimate revisions begin
- **Post-Inflection** — operating leverage sustained, multiple expansion
