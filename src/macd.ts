import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { cleanSymbol, nowIso } from "./http";

const FAST_PERIOD = 12;
const SLOW_PERIOD = 26;
const SIGNAL_PERIOD = 9;
const MIN_CLOSES = SLOW_PERIOD + SIGNAL_PERIOD + 5;
const SYMBOL_CONCURRENCY = 4;

export type Timeframe = "5m" | "20m" | "30m" | "1h" | "2h" | "4h" | "1d" | "1w";
export type MacdQuality =
  | "strong_bullish"
  | "bullish"
  | "neutral_bullish"
  | "neutral_bearish"
  | "bearish"
  | "strong_bearish"
  | "insufficient_data";

type FmpInterval = "5min" | "30min" | "1hour" | "4hour" | "daily";
type TimeframeSpec = { fmpInterval: FmpInterval; aggregate?: number };

const TIMEFRAMES: Record<Timeframe, TimeframeSpec> = {
  "5m": { fmpInterval: "5min" },
  "20m": { fmpInterval: "5min", aggregate: 4 },
  "30m": { fmpInterval: "30min" },
  "1h": { fmpInterval: "1hour" },
  "2h": { fmpInterval: "1hour", aggregate: 2 },
  "4h": { fmpInterval: "4hour" },
  "1d": { fmpInterval: "daily" },
  "1w": { fmpInterval: "daily", aggregate: 5 }
};

type Candle = { date: string; close: number };

type MacdReading = {
  macd: number;
  signal: number;
  histogram: number;
  previousHistogram: number | null;
  quality: MacdQuality;
  asOf: string;
  sampleSize: number;
};

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function processMacd(input: { symbol?: string }): Promise<{ symbol: string; readings: Record<Timeframe, MacdReading | null> }> {
  const symbol = cleanSymbol(input?.symbol);
  if (!symbol) {
    throw new Error("processMacd requires a symbol.");
  }

  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    throw new Error("FMP_API_KEY is not configured.");
  }

  const readings = await computeAllTimeframes(symbol, apiKey);
  await writeReadings(symbol, readings);
  return { symbol, readings };
}

export async function processAllMacd(): Promise<{ scanned: number; updated: number }> {
  const startedAt = Date.now();
  console.log("macd.start", { at: new Date(startedAt).toISOString() });
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    throw new Error("FMP_API_KEY is not configured.");
  }

  const symbols = await listStockSymbols();
  let updated = 0;
  let failed = 0;

  for (let index = 0; index < symbols.length; index += SYMBOL_CONCURRENCY) {
    const batch = symbols.slice(index, index + SYMBOL_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (symbol) => {
        const readings = await computeAllTimeframes(symbol, apiKey);
        await writeReadings(symbol, readings);
      })
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        updated += 1;
      } else {
        failed += 1;
        console.error("MACD update failed", { cause: result.reason });
      }
    }
  }

  console.log("macd.done", {
    durationMs: Date.now() - startedAt,
    scanned: symbols.length,
    updated,
    failed
  });
  return { scanned: symbols.length, updated };
}

async function computeAllTimeframes(symbol: string, apiKey: string): Promise<Record<Timeframe, MacdReading | null>> {
  const candleCache = new Map<FmpInterval, Candle[]>();
  const readings = {} as Record<Timeframe, MacdReading | null>;

  for (const [name, spec] of Object.entries(TIMEFRAMES) as [Timeframe, TimeframeSpec][]) {
    let candles = candleCache.get(spec.fmpInterval);
    if (!candles) {
      candles = await fetchCandles(symbol, spec.fmpInterval, apiKey);
      candleCache.set(spec.fmpInterval, candles);
    }
    const series = spec.aggregate ? aggregate(candles, spec.aggregate) : candles;
    readings[name] = computeMacdFromCloses(series);
  }
  return readings;
}

async function fetchCandles(symbol: string, interval: FmpInterval, apiKey: string): Promise<Candle[]> {
  if (interval === "daily") {
    const url = new URL(`https://financialmodelingprep.com/api/v3/historical-price-full/${encodeURIComponent(symbol)}`);
    url.searchParams.set("serietype", "line");
    url.searchParams.set("apikey", apiKey);
    const response = await fetch(url);
    if (!response.ok) {
      console.error("FMP daily request failed", { symbol, status: response.status });
      return [];
    }
    const data = (await response.json()) as { historical?: { date: string; close: number }[] };
    return (data.historical ?? [])
      .map((bar) => ({ date: bar.date, close: bar.close }))
      .reverse();
  }

  const url = new URL(`https://financialmodelingprep.com/api/v3/historical-chart/${interval}/${encodeURIComponent(symbol)}`);
  url.searchParams.set("apikey", apiKey);
  const response = await fetch(url);
  if (!response.ok) {
    console.error("FMP intraday request failed", { symbol, interval, status: response.status });
    return [];
  }
  const data = (await response.json()) as unknown;
  if (!Array.isArray(data)) {
    return [];
  }
  return (data as { date: string; close: number }[])
    .map((bar) => ({ date: bar.date, close: bar.close }))
    .reverse();
}

function aggregate(candles: Candle[], factor: number): Candle[] {
  if (factor <= 1 || candles.length === 0) {
    return candles;
  }
  const out: Candle[] = [];
  for (let index = 0; index + factor <= candles.length; index += factor) {
    const window = candles.slice(index, index + factor);
    out.push({
      date: window[window.length - 1].date,
      close: window[window.length - 1].close
    });
  }
  return out;
}

function computeMacdFromCloses(candles: Candle[]): MacdReading | null {
  const closes = candles.map((bar) => bar.close).filter((value) => Number.isFinite(value));
  if (closes.length < MIN_CLOSES) {
    return {
      macd: 0,
      signal: 0,
      histogram: 0,
      previousHistogram: null,
      quality: "insufficient_data",
      asOf: candles.at(-1)?.date ?? nowIso(),
      sampleSize: closes.length
    };
  }

  const emaFast = ema(closes, FAST_PERIOD);
  const emaSlow = ema(closes, SLOW_PERIOD);
  const macdLine = closes.map((_, index) => emaFast[index] - emaSlow[index]);
  const signalLine = ema(macdLine.slice(SLOW_PERIOD - 1), SIGNAL_PERIOD);

  const lastIndex = macdLine.length - 1;
  const signalIndex = signalLine.length - 1;
  const lastMacd = macdLine[lastIndex];
  const lastSignal = signalLine[signalIndex];
  const histogram = lastMacd - lastSignal;
  const previousHistogram = signalIndex > 0
    ? macdLine[lastIndex - 1] - signalLine[signalIndex - 1]
    : null;

  return {
    macd: round(lastMacd),
    signal: round(lastSignal),
    histogram: round(histogram),
    previousHistogram: previousHistogram === null ? null : round(previousHistogram),
    quality: classify(lastMacd, lastSignal, histogram, previousHistogram),
    asOf: candles.at(-1)?.date ?? nowIso(),
    sampleSize: closes.length
  };
}

function ema(values: number[], period: number): number[] {
  if (values.length === 0) {
    return [];
  }
  const multiplier = 2 / (period + 1);
  const out: number[] = new Array(values.length);
  let prev = values[0];
  out[0] = prev;
  for (let index = 1; index < values.length; index += 1) {
    prev = values[index] * multiplier + prev * (1 - multiplier);
    out[index] = prev;
  }
  return out;
}

function classify(macd: number, signal: number, histogram: number, previousHistogram: number | null): MacdQuality {
  const aboveSignal = macd > signal;
  const histAbsScale = Math.max(Math.abs(macd), Math.abs(signal), 1e-6);
  const strength = Math.abs(histogram) / histAbsScale;
  const expanding = previousHistogram === null ? false : Math.abs(histogram) > Math.abs(previousHistogram);
  const bothPositive = macd > 0 && signal > 0;
  const bothNegative = macd < 0 && signal < 0;

  if (aboveSignal) {
    if (bothPositive && expanding && strength > 0.25) {
      return "strong_bullish";
    }
    if (strength > 0.05) {
      return "bullish";
    }
    return "neutral_bullish";
  }
  if (bothNegative && expanding && strength > 0.25) {
    return "strong_bearish";
  }
  if (strength > 0.05) {
    return "bearish";
  }
  return "neutral_bearish";
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

async function writeReadings(symbol: string, readings: Record<Timeframe, MacdReading | null>): Promise<void> {
  await documentClient.send(
    new UpdateCommand({
      TableName: Resource.Stocks.name,
      Key: { symbol },
      ConditionExpression: "attribute_exists(symbol)",
      UpdateExpression: "SET macd = :macd, macdUpdatedAt = :now",
      ExpressionAttributeValues: {
        ":macd": readings,
        ":now": nowIso()
      }
    })
  ).catch((cause) => {
    if (isConditionalCheckFailed(cause)) {
      return;
    }
    throw cause;
  });
}

async function listStockSymbols(): Promise<string[]> {
  const symbols: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: Resource.Stocks.name,
        ProjectionExpression: "symbol",
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    for (const item of (response.Items ?? []) as { symbol: string }[]) {
      if (item.symbol) {
        symbols.push(item.symbol);
      }
    }
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return symbols;
}

function isConditionalCheckFailed(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { name?: string }).name === "ConditionalCheckFailedException";
}
