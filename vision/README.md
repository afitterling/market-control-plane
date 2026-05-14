# Vision — the Market Control Plane as the essential layer

_Last updated: 2026-05-14_

> **One thesis:** every subject that wants to act on the market — a web dashboard, a
> mobile app, an AI assistant, an MCP client, an autonomous agent, an execution
> adapter, a partner platform — does it **through the control plane**, not around it.

The control plane is not "one of many services in the stack." It is the
single place where market data becomes _state_, where state becomes _signals_,
and where signals become _allocation intent_. Everything above it is a
presentation or actuation surface; everything below it is a source of truth.

## The sketch

![Control plane — essential layer](./diagrams/control-plane-essential-layer.svg)

Source: [`diagrams/control-plane-essential-layer.mmd`](./diagrams/control-plane-essential-layer.mmd).

Regenerate:

```sh
mmdc -i vision/diagrams/control-plane-essential-layer.mmd \
     -o vision/diagrams/control-plane-essential-layer.svg \
     -b transparent -p doc/diagrams/puppeteer.json
```

## Three bands

The sketch reads top-to-bottom in three bands.

### 1. Sources of truth (top, red)

Raw inputs the plane ingests on its own cadence:

- **FMP** — quotes, fundamentals, news.
- **Macro feeds** — rates, CPI, central-bank balance sheet, liquidity proxies.
- **Geopolitical wires** — conflict, sanctions, trade-bloc realignment.
- **Alternative inputs** — filings, alt-data, partner streams.

Subjects never read these directly. If they did, the plane would lose its
position as the single source of interpreted state.

### 2. The control plane (middle, black/gold)

Four internal stages plus the egress band:

| Stage | What it owns |
| --- | --- |
| **Ingest** | Prices &amp; technicals, fundamentals, news/pulse, macro/geopolitics. |
| **Reasoning** | Pruned FAU models that classify regime, score fundamentals, build market pulse, run thesis assessments, and align scores + regime into target weights. |
| **State** | DynamoDB tables for stocks, earnings, industries, pulse, regime, alignment, and an append-only event log. |
| **Surfaces** | The contract subjects bind to — REST (OpenAPI), WebSocket (AsyncAPI), Kinesis streams, MCP server. |

The reasoning layer is what makes the plane _essential_ rather than just
convenient: regime, pulse, scoring, and alignment are derived once, written to
state once, and reused by every subject. No subject re-derives them.

### 3. Subjects (bottom, green)

Three families of consumers, all bound to the same surfaces:

- **Human-facing** — web apps, native apps, research notebooks.
- **AI-facing** — chat assistants, MCP clients (Claude Code, IDE agents),
  autonomous agents that subscribe to streams.
- **Machine-to-machine** — execution adapters (brokers, custodians), risk and
  compliance, embedded/white-label partner platforms.

The dashed return arrows are the load-bearing detail: when a subject _acts_
(an execution adapter reports a fill, a risk system raises a breach, an
assistant fires a tool call, an agent edits an alert), it writes back into the
plane through the same surfaces. The plane therefore holds the only complete
picture of what the system collectively believes _and_ what it has done.

## Why one essential layer

1. **One contract, many subjects.** A new app — web, mobile, assistant, or
   agent — binds to REST + WebSocket + MCP and is immediately first-class.
   No subject has a privileged side door.
2. **Derived state lives in one place.** Regime, pulse, scores, and alignment
   are computed by pruned FAU models once per cadence. Re-deriving them
   per-subject would be wasteful and would let subjects disagree about
   the state of the world.
3. **Auditability.** Every signal that left the plane is in the `Events`
   stream. Every action that came back in is, too. The audit trail is a
   property of the topology, not a feature anyone has to remember to use.
4. **AI-native by construction.** The MCP surface makes the same state and
   signals consumable as tools/resources by assistants and IDE agents.
   Human and AI subjects share the contract — they do not fork it.
5. **Execution stays downstream.** The plane decides _what_ should be held
   and _why_; brokers and custodians decide _how_ to fill it. Replacing an
   execution venue does not touch the plane; replacing the plane would
   touch every subject — which is exactly why it must remain stable,
   versioned, and the single essential layer.

## What this folder is

`vision/` is the forward-looking narrative — it states the target topology
and the invariants that keep it coherent as new subjects come online. The
day-to-day "what is built today" docs live under [`doc/`](../doc/) and
[`docs/`](../docs/); when the vision and the current build diverge, this
folder is the north star, and the gap is the backlog.
