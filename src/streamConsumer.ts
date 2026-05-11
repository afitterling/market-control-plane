import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { sendTo, VALID_CHANNELS, type Channel } from "./wsConnection";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type KinesisLambdaRecord = {
  kinesis: {
    data: string;
    partitionKey?: string;
    approximateArrivalTimestamp?: number;
  };
};

type KinesisLambdaEvent = {
  Records: KinesisLambdaRecord[];
};

type Subscriber = {
  connectionId: string;
  channels?: string[];
  filters?: { symbols?: string[]; regions?: string[]; kinds?: string[] };
};

export async function broadcastTicks(event: KinesisLambdaEvent): Promise<void> {
  await broadcast(event, "ticks", (record) => ({
    symbol: typeof record.symbol === "string" ? record.symbol.toUpperCase() : undefined
  }));
}

export async function broadcastSignals(event: KinesisLambdaEvent): Promise<void> {
  await broadcast(event, "signals", (record) => ({
    kind: typeof record.kind === "string" ? record.kind : undefined
  }));
}

export async function broadcastPulseEvents(event: KinesisLambdaEvent): Promise<void> {
  await broadcast(event, "pulse-events", (record) => ({
    region: typeof record.region === "string" ? record.region : undefined
  }));
}

async function broadcast(
  event: KinesisLambdaEvent,
  channel: Channel,
  index: (record: Record<string, unknown>) => { symbol?: string; region?: string; kind?: string }
): Promise<void> {
  const records = parseRecords(event);
  if (records.length === 0) return;
  const subscribers = await loadSubscribers(channel);
  if (subscribers.length === 0) return;
  const endpoint = process.env.WS_API_ENDPOINT;
  if (!endpoint) {
    console.error("streamConsumer: WS_API_ENDPOINT not set");
    return;
  }
  for (const record of records) {
    const indexed = index(record);
    for (const subscriber of subscribers) {
      if (!subscriberMatches(subscriber, indexed)) continue;
      await sendTo(endpoint, subscriber.connectionId, {
        type: "event",
        channel,
        data: record
      });
    }
  }
}

function parseRecords(event: KinesisLambdaEvent): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const record of event.Records ?? []) {
    try {
      const decoded = Buffer.from(record.kinesis.data, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed === "object") {
        out.push(parsed as Record<string, unknown>);
      }
    } catch (cause) {
      console.error("streamConsumer: failed to parse record", { cause });
    }
  }
  return out;
}

async function loadSubscribers(channel: Channel): Promise<Subscriber[]> {
  const out: Subscriber[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: Resource.WsConnections.name,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    for (const item of (response.Items ?? []) as Subscriber[]) {
      if (!item.channels || item.channels.length === 0) continue;
      if (item.channels.includes(channel)) {
        out.push(item);
      }
    }
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return out;
}

function subscriberMatches(
  subscriber: Subscriber,
  indexed: { symbol?: string; region?: string; kind?: string }
): boolean {
  const filters = subscriber.filters;
  if (!filters) return true;
  if (filters.symbols && filters.symbols.length > 0) {
    if (!indexed.symbol) return false;
    if (!filters.symbols.map((value) => value.toUpperCase()).includes(indexed.symbol)) return false;
  }
  if (filters.regions && filters.regions.length > 0) {
    if (!indexed.region) return false;
    if (!filters.regions.includes(indexed.region)) return false;
  }
  if (filters.kinds && filters.kinds.length > 0) {
    if (!indexed.kind) return false;
    if (!filters.kinds.includes(indexed.kind)) return false;
  }
  return true;
}

// Reference avoids unused import error if filters expanded later.
void VALID_CHANNELS;
