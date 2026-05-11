# Realtime: Kinesis Streams + WebSocket fan-out

_Last updated: 2026-05-12._

The control plane exposes three Kinesis Data Streams and a WebSocket API that fans them out to subscribed clients. Any consumer that speaks WebSocket — a Remix loader, a browser app, a Node service, a `wscat` shell — can subscribe.

## Topology

```
producers                       streams                consumers                       clients
─────────                       ───────                ─────────                       ───────
PullPrices cron       ─PutRecords──▶ Ticks         ──▶ BroadcastTicks Lambda        ─┐
RefreshStockReturns   ─PutRecords──▶ Ticks         ──▶ (decode → match subscribers) ─┤
                                                                                     ├──▶ ApiGatewayWebSocket
AlignMarketState cron ─PutRecords──▶ Signals       ──▶ BroadcastSignals Lambda      ─┤    (RealtimeApi)
alerts evaluator      ─PutRecords──▶ Signals                                         │
                                                                                     │      ▲
PullPulse cron        ─PutRecords──▶ PulseEvents   ──▶ BroadcastPulseEvents Lambda  ─┘      │
                                                                                            │
                                                                                            wss://… (Remix, browser, …)
```

The three streams are deliberately separate:

| Stream | Producers | Use |
|---|---|---|
| `Ticks` | `PullPrices`, `RefreshStockReturns` | Per-symbol quote stream, partition key = symbol |
| `Signals` | `AlignMarketState`, alert evaluator | Regime/alignment/alert outputs, partition key = kind |
| `PulseEvents` | `PullPulse`, `POST /pulse/refresh` | Pulse snapshots + region updates, partition key = region |

Each stream has a Lambda subscriber (`src/streamConsumer.ts`) that decodes the batch, scans the `WsConnections` table for connections subscribed to that channel, applies optional filters (symbol / region / kind), and posts the event to each matching connection through `ApiGatewayManagementApi`.

## WebSocket API contract

**Endpoint:** `wss://<RealtimeApi-id>.execute-api.<region>.amazonaws.com/<stage>`. The current URL is exported as `realtime` by `sst deploy`.

### Connect

```
wss://…/?token=<API_BEARER_TOKEN>&channels=ticks,signals,pulse-events
```

- `token` is required. It's compared against the `API_BEARER_TOKEN` SST secret using a timing-safe match.
- `channels` is optional CSV; defaults to all three (`ticks`, `signals`, `pulse-events`). Invalid names are dropped.

On accept the server returns `200 Connected`. The connection is now in the `WsConnections` Dynamo table and will receive matching events.

### Subscribe / unsubscribe at runtime

Send a JSON frame on the open socket:

```json
{ "action": "subscribe",   "channels": ["ticks"],            "filters": { "symbols": ["AAPL", "MSFT"] } }
{ "action": "subscribe",   "channels": ["pulse-events"],     "filters": { "regions": ["United States"] } }
{ "action": "subscribe",   "channels": ["signals"],          "filters": { "kinds": ["alignment", "alert"] } }
{ "action": "unsubscribe", "channels": [] }
```

The server replies with an ack frame:

```json
{ "type": "ack", "action": "subscribe", "channels": ["ticks"], "filters": { "symbols": ["AAPL", "MSFT"] } }
```

### Receiving events

Every published event arrives as:

```json
{
  "type": "event",
  "channel": "ticks",
  "data": {
    "symbol": "AAPL",
    "price": 187.42,
    "changePercent": 0.34,
    "source": "pullPrices",
    "at": "2026-05-12T13:55:01.221Z"
  }
}
```

`data` is the original record published to the Kinesis stream; one frame per record.

### Disconnect

The server cleans up the connection row on `$disconnect` and also when a target Lambda gets `410 Gone` from `PostToConnection`.

## Subscribing from Remix

Remix runs server-side on Node (or an edge runtime). Two clean shapes:

### A. Browser-side, native `WebSocket`

```tsx
// app/routes/_index.tsx
import { useEffect, useState } from "react";
import { useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";

export const loader = ({ context }: LoaderFunctionArgs) => ({
  // expose URL + a short-lived token to the browser
  url: process.env.REALTIME_WS_URL!,
  token: process.env.PUBLIC_REALTIME_TOKEN!
});

export default function Index() {
  const { url, token } = useLoaderData<typeof loader>();
  const [ticks, setTicks] = useState<unknown[]>([]);

  useEffect(() => {
    const socket = new WebSocket(`${url}?token=${token}&channels=ticks`);
    socket.onopen = () => {
      socket.send(JSON.stringify({
        action: "subscribe",
        channels: ["ticks"],
        filters: { symbols: ["AAPL", "NVDA", "MSFT"] }
      }));
    };
    socket.onmessage = (msg) => {
      const frame = JSON.parse(msg.data as string);
      if (frame.type === "event" && frame.channel === "ticks") {
        setTicks((current) => [frame.data, ...current].slice(0, 50));
      }
    };
    return () => socket.close();
  }, [url, token]);

  return <pre>{JSON.stringify(ticks, null, 2)}</pre>;
}
```

Trade-off: the bearer token reaches the browser. Mint short-lived per-user tokens server-side (e.g., a signed JWT minted by a Remix loader) and validate them in `$connect` instead of using `API_BEARER_TOKEN` directly.

### B. Server-side, forwarded to the browser as Server-Sent Events

Open the WebSocket from the Remix server, re-emit each frame as SSE so the browser never sees the token. Works well behind a CDN and keeps secrets server-side.

```ts
// app/routes/stream.tsx
import { eventStream } from "remix-utils/sse/server";
import WebSocket from "ws";
import type { LoaderFunctionArgs } from "@remix-run/node";

export function loader({ request }: LoaderFunctionArgs) {
  return eventStream(request.signal, (send) => {
    const socket = new WebSocket(
      `${process.env.REALTIME_WS_URL}?token=${process.env.REALTIME_TOKEN}&channels=ticks,signals,pulse-events`
    );
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "event") {
        send({ event: frame.channel, data: JSON.stringify(frame.data) });
      }
    });
    return () => socket.close();
  });
}
```

```tsx
// app/components/LivePulse.tsx
import { useEventSource } from "remix-utils/sse/react";

export function LivePulse() {
  const tick = useEventSource("/stream", { event: "ticks" });
  const signal = useEventSource("/stream", { event: "signals" });
  return (
    <div>
      <pre>{tick}</pre>
      <pre>{signal}</pre>
    </div>
  );
}
```

The `remix-utils` package gives you `eventStream` (server) and `useEventSource` (client). Browser only ever sees `text/event-stream`; the bearer token stays on the Remix server.

### C. Quick smoke test from a terminal

```sh
npm i -g wscat
wscat -c "wss://<RealtimeApi-id>.execute-api.<region>.amazonaws.com/$default?token=$API_BEARER_TOKEN&channels=ticks"
> {"action":"subscribe","channels":["ticks"],"filters":{"symbols":["AAPL"]}}
< {"type":"ack","action":"subscribe","channels":["ticks"],"filters":{"symbols":["AAPL"]}}
< {"type":"event","channel":"ticks","data":{"symbol":"AAPL","price":187.42,...}}
```

## Operational notes

- Kinesis retention is the SST default (24h). Bump per stream by setting `retention` on `sst.aws.KinesisStream` once you want longer replay.
- Each broadcast Lambda scans `WsConnections` on every batch. Fine up to a few hundred connections; beyond that, switch to a GSI by `channel` or maintain an in-memory cache keyed off a connection-count Lambda extension.
- The `$default` route handles subscribe/unsubscribe frames. Anything else is rejected with `400`.
- `WsConnections` rows have no TTL today. Add `expiresAt` + Dynamo TTL when you start seeing stale rows.
- `PostToConnection` failures with HTTP 410 (stale connection) auto-clean the row.
- Outbound message size cap is 128 KB per frame; the streams' records are well under this.
