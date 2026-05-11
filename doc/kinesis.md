# Kinesis Streams

_Last updated: 2026-05-12._

Three Kinesis Data Streams carry high-volume events from the control plane. They're the lower-level transport behind the WebSocket fan-out documented in [`realtime.md`](./realtime.md) — but they're also directly addressable for any consumer that wants ordered, replayable shards instead of push delivery.

## Stream catalog

| Stream resource | SST name token | Use | Partition key | Default shards | Default retention |
|---|---|---|---|---|---|
| `sst.aws.KinesisStream("Ticks")` | `Resource.Ticks.name` | Per-symbol quote stream after every batch quote pull | `symbol` | 1 | 24 h |
| `sst.aws.KinesisStream("Signals")` | `Resource.Signals.name` | Regime / alignment / alert state-change emissions | `kind` | 1 | 24 h |
| `sst.aws.KinesisStream("PulseEvents")` | `Resource.PulseEvents.name` | Pulse snapshot + region updates from cron and `POST /pulse/refresh` | `region` (falls back to `type`) | 1 | 24 h |

The concrete AWS stream name resolves at deploy time and follows SST's `<app>-<stage>-<Name>Stream` convention; reach it via `Resource.<Name>.name` from any linked Lambda. Outside the Lambda runtime, look it up in the SST stack outputs or run `aws kinesis list-streams`.

Bump retention or shard count by passing options to the resource:

```ts
new sst.aws.KinesisStream("Ticks", {
  retention: "168 hours",        // 7 days
  // shards bump via transform if you outgrow on-demand defaults
});
```

## Record schemas

All records are JSON, UTF-8, base64-encoded by the Kinesis SDK on the wire. The on-the-wire `Data` decodes to one of these shapes:

### `Ticks`

```ts
{
  symbol: string;          // upper-case ticker, also the partition key
  price: number;
  changePercent?: number;
  source?: "pullPrices" | string;
  at: string;              // ISO timestamp
}
```

Producer: [`src/prices.ts`](../src/prices.ts) `runPass` → `putTicks(...)` after every FMP batch pull pass.

### `Signals`

```ts
{
  kind: "regime" | "alignment" | "alert";   // also the partition key
  status?: string;
  bias?: string;
  riskLevel?: string;
  alertId?: string;
  payload?: Record<string, unknown>;
  at: string;
}
```

Producer: [`src/alignment.ts`](../src/alignment.ts) `alignMarketState` → `putSignal(...)` when risk level or bias changes vs the previous alignment row. (Alert evaluator producer is planned — TODO entry in `doc/TODO.md`.)

### `PulseEvents`

```ts
{
  type: "PULSE_SNAPSHOT_TAKEN" | "PULSE_REGION_UPDATED" | string;
  region?: string;
  status?: "calm" | "watch" | "elevated" | "critical";
  score?: number;
  payload?: Record<string, unknown>;
  at: string;
}
```

Producer: [`src/pulse.ts`](../src/pulse.ts) `persistSnapshot` → `putPulseEvent(...)` on every snapshot regardless of status change (so downstream replay sees the full series).

## Producing records

The helper at [`src/streams.ts`](../src/streams.ts) wraps `PutRecordsCommand` with sane defaults:

```ts
import { putTicks, putSignal, putPulseEvent } from "./streams";

await putTicks([{
  symbol: "AAPL",
  price: 187.42,
  changePercent: 0.34,
  source: "pullPrices",
  at: new Date().toISOString()
}]);

await putSignal({
  kind: "alignment",
  riskLevel: "elevated",
  bias: "defensive",
  payload: { hotRegions: ["United States"] },
  at: new Date().toISOString()
});

await putPulseEvent({
  type: "PULSE_SNAPSHOT_TAKEN",
  region: "global",
  status: "elevated",
  score: 62,
  at: new Date().toISOString()
});
```

To produce from a Lambda you don't yet have wired:
1. Add the stream to the function's `link` array in `sst.config.ts` (e.g., `link: [stocks, ticksStream]`).
2. Import the helper and call it. SST grants the IAM `kinesis:PutRecord*` on the linked stream automatically.

Batches honour Kinesis' 500-records-per-call cap and chunk internally. Failures are logged and swallowed — Kinesis production is fire-and-forget by design here; the canonical write is still to DynamoDB.

## Consuming records

Three paths, increasing complexity:

### 1. Built-in WebSocket fan-out (recommended for UI)

A Lambda subscriber per stream decodes the batch and posts each record to matching open WebSocket connections. See [`realtime.md`](./realtime.md) for the WebSocket contract and Remix integration. Zero Kinesis client code on the consumer side.

### 2. Direct Kinesis SDK consumer (Lambda or service)

If you want push-based delivery inside the same SST app, define another `stream.subscribe(...)`:

```ts
ticksStream.subscribe("TickAuditLogger", {
  handler: "src/audit.logTicks",
  link: [auditTable],
  startingPosition: "LATEST"   // or "TRIM_HORIZON" for backfill
});
```

The handler receives a `KinesisStreamEvent` with `Records[]`, each containing base64 `kinesis.data`:

```ts
import type { KinesisStreamEvent } from "aws-lambda";

export async function logTicks(event: KinesisStreamEvent) {
  for (const record of event.Records) {
    const decoded = Buffer.from(record.kinesis.data, "base64").toString("utf8");
    const tick = JSON.parse(decoded);
    // ...
  }
}
```

SST grants the necessary `kinesis:DescribeStream`, `kinesis:GetRecords`, `kinesis:GetShardIterator`, `kinesis:ListShards`, `kinesis:SubscribeToShard` (for enhanced fan-out), plus a CloudWatch Logs role. Multiple subscribers on the same stream are independent (separate shard iterators).

### 3. External SDK consumer

Any client with AWS credentials and `kinesis:GetRecords` on the stream can consume directly:

```sh
# get a shard id
aws kinesis describe-stream --stream-name <stream-name> \
  --query 'StreamDescription.Shards[0].ShardId' --output text

# open a shard iterator from the latest record
aws kinesis get-shard-iterator \
  --stream-name <stream-name> \
  --shard-id <ShardId> \
  --shard-iterator-type LATEST \
  --query 'ShardIterator' --output text

# pull records
aws kinesis get-records --shard-iterator <iterator> --limit 25 \
  --query 'Records[].Data' --output text \
  | base64 -d | jq .
```

Or with the SDK:

```ts
import { KinesisClient, GetRecordsCommand, GetShardIteratorCommand } from "@aws-sdk/client-kinesis";

const kinesis = new KinesisClient({ region: "<region>" });
const iter = await kinesis.send(new GetShardIteratorCommand({
  StreamName: "<stream-name>",
  ShardId: "<shardId-000000000000>",
  ShardIteratorType: "LATEST"
}));
const out = await kinesis.send(new GetRecordsCommand({ ShardIterator: iter.ShardIterator!, Limit: 100 }));
const records = (out.Records ?? []).map((entry) => JSON.parse(Buffer.from(entry.Data!).toString("utf8")));
```

For sustained reads use the [Kinesis Client Library (KCL)](https://docs.aws.amazon.com/streams/latest/dev/kcl.html) which manages shard leases and checkpointing in DynamoDB for you, or **Enhanced Fan-Out** (`SubscribeToShard`) for dedicated 2 MB/s throughput per consumer per shard.

## Operational notes

- **Ordering** is per-partition-key within a shard. Symbol-keyed ticks for `AAPL` arrive in order; ticks for different symbols are not globally ordered.
- **Replay** within retention is free — open a shard iterator at `AT_TIMESTAMP` or `TRIM_HORIZON`. Beyond retention, use Kinesis Data Streams' optional archive to S3.
- **Backpressure** on the WebSocket fan-out: `PostToConnection` failures with HTTP 410 auto-clean the connection. Lambda concurrency on the broadcast functions is the gating factor; bump reserved concurrency if you see throttling under burst load.
- **Cost shape**: shard-hours + PUT payload units (~25 KB each). Idle on-demand streams are inexpensive; sustained writes scale with shards.
- **Record size** cap: 1 MB per record, 5 MB or 500 records per `PutRecords`. The schemas above are well under both.
- **Monitoring**: CloudWatch metrics `IncomingRecords`, `IncomingBytes`, `WriteProvisionedThroughputExceeded`, `IteratorAgeMilliseconds` per stream. The last one is the key consumer-health signal — alarm if it grows beyond a minute.

## Cross-references

- WebSocket fan-out and subscription protocol: [`realtime.md`](./realtime.md)
- Architecture diagram (with streams + broadcasters): [`diagrams/sst-architecture.svg`](./diagrams/sst-architecture.svg)
- Open work (alert producer, retention tuning, alarms): [`TODO.md`](./TODO.md)
