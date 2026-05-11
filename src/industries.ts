import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { error, json, nowIso, requireBearerToken } from "./http";

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
  }

  await batchPut(rows);

  console.log("industries.backfill.done", {
    durationMs: Date.now() - startedAt,
    industries: rows.length,
    totalSymbols: rows.reduce((sum, row) => sum + row.symbolCount, 0)
  });

  return json({
    count: rows.length,
    totalSymbols: rows.reduce((sum, row) => sum + row.symbolCount, 0),
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
