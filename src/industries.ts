import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { error, json, nowIso, requireBearerToken } from "./http";
import { upsertStockMinimal } from "./stockEnrich";

type IndustryRow = {
  industry: string;
  sector?: string;
  symbolCount: number;
  symbols: string[];
  updatedAt: string;
};

type ScreenerRow = {
  symbol?: string;
  companyName?: string;
  sector?: string;
  industry?: string;
  exchange?: string;
};

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SCREENER_LIMIT = 1000;
const MAX_SYMBOLS_STORED = 500;

export async function backfill(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const apiKey = Resource.FMP_API_KEY.value;
  if (!apiKey) {
    return error("FMP_API_KEY secret is not configured.", 500);
  }

  const startedAt = Date.now();
  console.log("industries.backfill.start", { at: new Date(startedAt).toISOString() });

  const industries = await fetchIndustries(apiKey);
  if (industries.length === 0) {
    return error("FMP returned no industries.", 502);
  }

  const rows: IndustryRow[] = [];
  let seeded = 0;
  for (const industry of industries) {
    const screened = await fetchScreener(apiKey, industry);
    const symbols = dedupeSymbols(screened.map((row) => (row.symbol ?? "").trim().toUpperCase()).filter(Boolean));
    const sector = inferSector(screened);
    rows.push({
      industry,
      sector,
      symbolCount: symbols.length,
      symbols: symbols.slice(0, MAX_SYMBOLS_STORED),
      updatedAt: nowIso()
    });
    for (const screen of screened) {
      const symbol = (screen.symbol ?? "").trim().toUpperCase();
      if (!symbol) continue;
      try {
        await upsertStockMinimal({
          symbol,
          name: screen.companyName,
          sector: screen.sector ?? sector,
          industry: screen.industry ?? industry,
          exchange: screen.exchange
        });
        seeded += 1;
      } catch (cause) {
        console.error("industries.backfill stock upsert failed", { symbol, cause });
      }
    }
  }

  await batchPut(rows);

  console.log("industries.backfill.done", {
    durationMs: Date.now() - startedAt,
    industries: rows.length,
    totalSymbols: rows.reduce((sum, row) => sum + row.symbolCount, 0),
    stocksSeeded: seeded
  });

  return json({
    count: rows.length,
    totalSymbols: rows.reduce((sum, row) => sum + row.symbolCount, 0),
    stocksSeeded: seeded,
    industries: rows.map((row) => ({ industry: row.industry, sector: row.sector, symbolCount: row.symbolCount }))
  }, 201);
}

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const rows: IndustryRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: Resource.Industries.name,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    rows.push(...((response.Items ?? []) as IndustryRow[]));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);

  rows.sort((first, second) => first.industry.localeCompare(second.industry));

  return json({
    count: rows.length,
    industries: rows.map((row) => ({
      industry: row.industry,
      sector: row.sector,
      symbolCount: row.symbolCount,
      updatedAt: row.updatedAt
    }))
  });
}

export async function get(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }
  const industry = decodeURIComponent(event.pathParameters?.industry ?? "").trim();
  if (!industry) {
    return error("Missing industry.");
  }
  const response = await documentClient.send(
    new GetCommand({
      TableName: Resource.Industries.name,
      Key: { industry }
    })
  );
  if (!response.Item) {
    return error("Industry not found.", 404);
  }
  return json({ industry: response.Item });
}

async function fetchIndustries(apiKey: string): Promise<string[]> {
  const url = `https://financialmodelingprep.com/stable/available-industries?apikey=${encodeURIComponent(apiKey)}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error("FMP available-industries failed", { status: response.status });
      return [];
    }
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) return [];
    const names = new Set<string>();
    for (const entry of data) {
      if (typeof entry === "string" && entry.trim()) {
        names.add(entry.trim());
        continue;
      }
      if (entry && typeof entry === "object") {
        const candidate = (entry as { industry?: unknown; name?: unknown }).industry
          ?? (entry as { industry?: unknown; name?: unknown }).name;
        if (typeof candidate === "string" && candidate.trim()) {
          names.add(candidate.trim());
        }
      }
    }
    return [...names].sort();
  } catch (cause) {
    console.error("FMP available-industries errored", { cause });
    return [];
  }
}

async function fetchScreener(apiKey: string, industry: string): Promise<ScreenerRow[]> {
  const url = `https://financialmodelingprep.com/stable/company-screener?industry=${encodeURIComponent(industry)}&limit=${SCREENER_LIMIT}&apikey=${encodeURIComponent(apiKey)}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error("FMP screener failed", { industry, status: response.status });
      return [];
    }
    const data = (await response.json()) as unknown;
    return Array.isArray(data) ? (data as ScreenerRow[]) : [];
  } catch (cause) {
    console.error("FMP screener errored", { industry, cause });
    return [];
  }
}

function inferSector(rows: ScreenerRow[]): string | undefined {
  for (const row of rows) {
    if (row.sector && row.sector.trim()) {
      return row.sector.trim();
    }
  }
  return undefined;
}

function dedupeSymbols(symbols: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const symbol of symbols) {
    if (!seen.has(symbol)) {
      seen.add(symbol);
      out.push(symbol);
    }
  }
  return out;
}

async function batchPut(rows: IndustryRow[]): Promise<void> {
  for (let index = 0; index < rows.length; index += 25) {
    const chunk = rows.slice(index, index + 25);
    let requestItems = {
      [Resource.Industries.name]: chunk.map((row) => ({
        PutRequest: { Item: row }
      }))
    };
    do {
      const response = await documentClient.send(
        new BatchWriteCommand({ RequestItems: requestItems })
      );
      requestItems = response.UnprocessedItems as typeof requestItems;
    } while (requestItems?.[Resource.Industries.name]?.length);
  }
}

export async function putIndustry(row: IndustryRow): Promise<void> {
  await documentClient.send(
    new PutCommand({
      TableName: Resource.Industries.name,
      Item: row
    })
  );
}

type ReturnsRecord = {
  d1?: number;
  d7?: number;
  m1?: number;
  m3?: number;
  m6?: number;
  y1?: number;
  y2?: number;
  asOf?: string;
};

type EnrichedStockRow = {
  symbol: string;
  name?: string;
  sector?: string;
  industry?: string;
  exchange?: string;
  currency?: string;
  price?: number;
  priceAsOf?: string;
  returns?: ReturnsRecord;
  fundamentals?: Record<string, unknown>;
  margins?: Record<string, unknown>;
  epsHistory?: unknown[];
  enrichedAt?: string;
  updatedAt?: string;
};

const RETURN_WINDOWS: Array<keyof Pick<ReturnsRecord, "d1" | "d7" | "m1" | "m3" | "m6" | "y1" | "y2">> = [
  "d1", "d7", "m1", "m3", "m6", "y1", "y2"
];

export async function performance(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }
  const includeStocks = parseBool(event.queryStringParameters?.includeStocks);
  const industries = await scanIndustries();
  if (industries.length === 0) {
    return json({ count: 0, industries: [] });
  }
  const allSymbols = dedupeSymbols(industries.flatMap((row) => row.symbols));
  const stocksBySymbol = await batchGetStocks(allSymbols);

  const result = industries.map((row) => {
    const stocks = row.symbols
      .map((symbol) => stocksBySymbol.get(symbol))
      .filter((stock): stock is EnrichedStockRow => Boolean(stock));
    const aggregates = aggregateReturns(stocks);
    return {
      industry: row.industry,
      sector: row.sector,
      symbolCount: row.symbolCount,
      stockCount: stocks.length,
      aggregates,
      updatedAt: row.updatedAt,
      ...(includeStocks ? { stocks: stocks.map(stripForList) } : {})
    };
  });
  result.sort((first, second) => first.industry.localeCompare(second.industry));

  return json({ count: result.length, industries: result });
}

export async function industryDetail(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }
  const industry = decodeURIComponent(event.pathParameters?.industry ?? "").trim();
  if (!industry) {
    return error("Missing industry.");
  }
  const response = await documentClient.send(
    new GetCommand({
      TableName: Resource.Industries.name,
      Key: { industry }
    })
  );
  const row = response.Item as IndustryRow | undefined;
  if (!row) {
    return error("Industry not found.", 404);
  }
  const stocksBySymbol = await batchGetStocks(row.symbols);
  const stocks = row.symbols
    .map((symbol) => stocksBySymbol.get(symbol))
    .filter((stock): stock is EnrichedStockRow => Boolean(stock));
  const aggregates = aggregateReturns(stocks);

  return json({
    industry: row.industry,
    sector: row.sector,
    symbolCount: row.symbolCount,
    stockCount: stocks.length,
    aggregates,
    updatedAt: row.updatedAt,
    stocks: stocks.map((stock) => ({
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      industry: stock.industry,
      exchange: stock.exchange,
      currency: stock.currency,
      price: stock.price,
      priceAsOf: stock.priceAsOf,
      returns: stock.returns,
      fundamentals: stock.fundamentals,
      margins: stock.margins,
      epsHistory: stock.epsHistory,
      enrichedAt: stock.enrichedAt
    }))
  });
}

async function scanIndustries(): Promise<IndustryRow[]> {
  const rows: IndustryRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: Resource.Industries.name,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    rows.push(...((response.Items ?? []) as IndustryRow[]));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rows;
}

async function batchGetStocks(symbols: string[]): Promise<Map<string, EnrichedStockRow>> {
  const out = new Map<string, EnrichedStockRow>();
  for (let index = 0; index < symbols.length; index += 100) {
    let keys = symbols.slice(index, index + 100).map((symbol) => ({ symbol }));
    do {
      const response = await documentClient.send(
        new BatchGetCommand({
          RequestItems: {
            [Resource.Stocks.name]: { Keys: keys }
          }
        })
      );
      for (const item of ((response.Responses?.[Resource.Stocks.name] ?? []) as EnrichedStockRow[])) {
        out.set(item.symbol, item);
      }
      keys = (response.UnprocessedKeys?.[Resource.Stocks.name]?.Keys ?? []) as typeof keys;
    } while (keys.length > 0);
  }
  return out;
}

function aggregateReturns(stocks: EnrichedStockRow[]): Record<string, { avg: number | null; median: number | null; count: number }> {
  const aggregates: Record<string, { avg: number | null; median: number | null; count: number }> = {};
  for (const window of RETURN_WINDOWS) {
    const values = stocks
      .map((stock) => stock.returns?.[window])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    aggregates[window] = {
      avg: values.length === 0 ? null : roundTo(values.reduce((sum, value) => sum + value, 0) / values.length, 2),
      median: values.length === 0 ? null : roundTo(median(values), 2),
      count: values.length
    };
  }
  return aggregates;
}

function stripForList(stock: EnrichedStockRow) {
  return {
    symbol: stock.symbol,
    name: stock.name,
    price: stock.price,
    returns: stock.returns,
    fundamentals: stock.fundamentals
      ? {
          eps: (stock.fundamentals as { eps?: unknown }).eps,
          epsTtm: (stock.fundamentals as { epsTtm?: unknown }).epsTtm,
          peRatio: (stock.fundamentals as { peRatio?: unknown }).peRatio,
          marketCap: (stock.fundamentals as { marketCap?: unknown }).marketCap
        }
      : undefined,
    margins: stock.margins,
    enrichedAt: stock.enrichedAt
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}
