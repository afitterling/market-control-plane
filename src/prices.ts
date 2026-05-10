import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { nowIso } from "./http";

const PASSES_PER_INVOCATION = 2;
const PASS_GAP_MS = 30_000;
const FMP_BATCH_SIZE = 100;

type FmpQuote = {
  symbol?: string;
  price?: number;
  change?: number;
  changesPercentage?: number;
  dayLow?: number;
  dayHigh?: number;
  open?: number;
  previousClose?: number;
  volume?: number;
  timestamp?: number;
  [key: string]: unknown;
};

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function pullPrices(): Promise<{ passes: { updated: number; symbols: number }[] }> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    throw new Error("FMP_API_KEY is not configured.");
  }

  const passes: { updated: number; symbols: number }[] = [];
  for (let pass = 0; pass < PASSES_PER_INVOCATION; pass += 1) {
    if (pass > 0) {
      await sleep(PASS_GAP_MS);
    }
    const result = await runPass(apiKey);
    passes.push(result);
  }
  return { passes };
}

async function runPass(apiKey: string): Promise<{ updated: number; symbols: number }> {
  const symbols = await listStockSymbols();
  if (symbols.length === 0) {
    return { updated: 0, symbols: 0 };
  }

  let updated = 0;
  for (let index = 0; index < symbols.length; index += FMP_BATCH_SIZE) {
    const chunk = symbols.slice(index, index + FMP_BATCH_SIZE);
    const quotes = await fetchQuotes(chunk, apiKey);
    await Promise.all(quotes.map((quote) => writeQuote(quote)));
    updated += quotes.length;
  }
  return { updated, symbols: symbols.length };
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

async function fetchQuotes(symbols: string[], apiKey: string): Promise<FmpQuote[]> {
  const url = new URL(`https://financialmodelingprep.com/api/v3/quote/${symbols.join(",")}`);
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url);
  if (!response.ok) {
    console.error("FMP quote request failed", { status: response.status, symbols });
    return [];
  }
  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as FmpQuote[]) : [];
}

async function writeQuote(quote: FmpQuote): Promise<void> {
  const symbol = quote.symbol;
  if (!symbol) {
    return;
  }
  try {
    await documentClient.send(
      new UpdateCommand({
        TableName: Resource.Stocks.name,
        Key: { symbol },
        ConditionExpression: "attribute_exists(symbol)",
        UpdateExpression:
          "SET price = :price, dailyChange = :change, dailyChangePercent = :pct, dayLow = :low, dayHigh = :high, openPrice = :open, previousClose = :prev, lastVolume = :vol, priceUpdatedAt = :now",
        ExpressionAttributeValues: {
          ":price": numericOrNull(quote.price),
          ":change": numericOrNull(quote.change),
          ":pct": numericOrNull(quote.changesPercentage),
          ":low": numericOrNull(quote.dayLow),
          ":high": numericOrNull(quote.dayHigh),
          ":open": numericOrNull(quote.open),
          ":prev": numericOrNull(quote.previousClose),
          ":vol": numericOrNull(quote.volume),
          ":now": nowIso()
        }
      })
    );
  } catch (cause) {
    if (isConditionalCheckFailed(cause)) {
      return;
    }
    console.error("failed to write quote", { symbol, cause });
  }
}

function numericOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isConditionalCheckFailed(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { name?: string }).name === "ConditionalCheckFailedException";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
