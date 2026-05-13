# Assessment Model

Two assessment strategies drive single-stock analysis: **Value Investing** and **Catalyst-Based**. Each carries a model, a base prompt, a list of preconditions that gate eligibility, and one or more narratives that specialize the prompt against a thesis pattern.

## Diagram

The source-of-truth diagram is [`assessment-strategy.mmd`](./assessment-strategy.mmd). It renders natively in GitHub, VS Code, and any Mermaid-capable viewer.

> SVG export is not committed. Local `mmdc` rendering and external renderer upload were both blocked in this environment. To render locally:
>
> ```sh
> npx @mermaid-js/mermaid-cli mmdc -i docs/model/assessment-strategy.mmd -o docs/model/assessment-strategy.svg -b transparent
> ```

## Strategies

### Value Investing (`value`)
- **Model**: `claude-opus-4-7`
- **Thesis**: Profitable businesses where sentiment overcorrected price relative to durable cash flows.
- **Preconditions**: profitable today, significant price decline from stable level, decline is sentiment-driven, cash flows stable/growing, no structural business-model threat.
- **Narratives**:
  - `sentiment-overcorrection` — **💰 Sentiment Overcorrection on Profitable Business.** A fundamentally healthy, cash-generating business gets sold off heavily due to sentiment, macro fear, or short-term disappointment — not because the underlying economics broke. The stock price detaches from intrinsic value; a DCF or cash flow multiple reveals the gap; mean reversion to fair value is the return mechanism. Valuation levers: DCF, EV/EBITDA, P/FCF. _Example: SFM — profitable, growing, but stock dropped ~59% on sentiment; cash flows never deteriorated._

### Catalyst-Based (`catalyst`)
- **Model**: `claude-opus-4-7`
- **Thesis**: Pre-profitable businesses converging on an EPS crossover where multiple re-rating is the catalyst.
- **Preconditions**: revenue growing consistently, EPS losses narrowing, gross margin stable/expanding, operating leverage, no one-time items, balance sheet survives until crossover.
- **Narratives**:
  - `eps-crossover` — **⚡ EPS Crossover — Loss to Profit Turnaround.** A loss-making company with growing revenue and narrowing EPS losses approaches zero and crosses into profitability. The market, which had been pricing it on a compressed revenue multiple, is forced to re-classify and re-rate it onto an earnings multiple. The crossover moment — especially when it beats a negative consensus — triggers a disproportionate price reaction.
    - **Pre-Crossover** — losses narrowing, not yet profitable (e.g. TYGO)
    - **At Crossover** — first positive EPS print, consensus beat (e.g. TBLA Q1 2026)
    - **Post-Crossover** — sustained profitability, multiple expansion continues

    _Example: TBLA — EPS went -$0.08 → -$0.03 → +$0.20, stock surged 37% in one session._

## API

All routes require `Authorization: Bearer <API_BEARER_TOKEN>`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/assessments` | List strategies with id, name, model, narrative summaries. |
| GET | `/assessments/{strategy}` | Full strategy: model, base prompt, preconditions, narratives. |
| POST | `/assessments/{strategy}/{narrative}` | Run an assessment against a stock. |

### POST request body

```json
{ "symbol": "TYGO" }
```

or pass a full stock context object:

```json
{ "stock": { "symbol": "TYGO", "price": 1.84, "fundamentals": { "eps": -0.02 } } }
```

If only `symbol` is provided, the handler hydrates the row from the `Stocks` table. When `stock` is provided, supplied fields override the stored row.

### POST response shape

```json
{
  "generatedAt": "2026-05-13T...",
  "strategy": { "id": "catalyst", "name": "Catalyst-Based Assessment", "model": "claude-opus-4-7" },
  "narrative": { "id": "eps-crossover", "name": "EPS Crossover — Loss to Profit Turnaround" },
  "stock": { "symbol": "TYGO", "...": "..." },
  "preconditions": [{ "code": "REVENUE_GROWING", "description": "..." }, ...],
  "prompt": "...rendered prompt with stock context inlined...",
  "status": "prepared",
  "note": "LLM execution not wired; this response returns the rendered prompt and stock context ready for inference."
}
```

The endpoint currently returns the assembled prompt and stock context. Wiring the actual LLM invocation (Anthropic Messages API) is the next step — the response contract already carries `strategy.model` and a fully rendered prompt, so the call site becomes a single `fetch` to the Messages endpoint.
