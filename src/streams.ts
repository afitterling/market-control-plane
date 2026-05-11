import { KinesisClient, PutRecordsCommand } from "@aws-sdk/client-kinesis";
import { Resource } from "sst";

const kinesisClient = new KinesisClient({});

export type TickRecord = {
  symbol: string;
  price: number;
  changePercent?: number;
  source?: string;
  at: string;
};

export type SignalRecord = {
  kind: "regime" | "alignment" | "alert";
  status?: string;
  bias?: string;
  riskLevel?: string;
  alertId?: string;
  payload?: Record<string, unknown>;
  at: string;
};

export type PulseEventRecord = {
  type: string;
  region?: string;
  status?: string;
  score?: number;
  payload?: Record<string, unknown>;
  at: string;
};

const MAX_RECORDS_PER_PUT = 500;

export async function putTicks(records: TickRecord[]): Promise<void> {
  await putBatch(Resource.Ticks.name, records, (record) => record.symbol);
}

export async function putSignal(record: SignalRecord): Promise<void> {
  await putBatch(Resource.Signals.name, [record], (entry) => entry.kind);
}

export async function putSignals(records: SignalRecord[]): Promise<void> {
  await putBatch(Resource.Signals.name, records, (record) => record.kind);
}

export async function putPulseEvent(record: PulseEventRecord): Promise<void> {
  await putBatch(Resource.PulseEvents.name, [record], (entry) => entry.region ?? entry.type);
}

async function putBatch<T>(
  streamName: string,
  records: T[],
  partitionKey: (record: T) => string
): Promise<void> {
  if (records.length === 0) return;
  for (let index = 0; index < records.length; index += MAX_RECORDS_PER_PUT) {
    const chunk = records.slice(index, index + MAX_RECORDS_PER_PUT);
    try {
      await kinesisClient.send(
        new PutRecordsCommand({
          StreamName: streamName,
          Records: chunk.map((record) => ({
            Data: Buffer.from(JSON.stringify(record)),
            PartitionKey: partitionKey(record) || "default"
          }))
        })
      );
    } catch (cause) {
      console.error("kinesis.putRecords failed", { streamName, count: chunk.length, cause });
    }
  }
}
