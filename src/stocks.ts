import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
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
import { publishEvent } from "./events";
import { cleanSymbol, error, json, nowIso, parseJsonBody, requireBearerToken } from "./http";

const STOCK_NEW_ADDED_ACTION = "STCO_NEW_ADDED";
const STOCK_PROCESS_ACTION = "STCO_PROCESS_STOCK";
type StockAction = typeof STOCK_NEW_ADDED_ACTION | typeof STOCK_PROCESS_ACTION;
type ProcessingState = "being_processed" | "data_pulled";

type ExecutedAction = {
  action: StockAction;
  symbol: string;
  eventId: string;
};

type StockItem = {
  symbol: string;
  name?: string;
  exchange?: string;
  currency?: string;
  sector?: string;
  industry?: string;
  country?: string;
  isEtf?: boolean;
  isFund?: boolean;
  isAdr?: boolean;
  tags?: string[];
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
  processingState?: ProcessingState;
  executedActions?: ExecutedAction[];
};

type ProfileLookup = {
  name?: string;
  exchange?: string;
  currency?: string;
  sector?: string;
  industry?: string;
  country?: string;
  isEtf?: boolean;
  isFund?: boolean;
  isAdr?: boolean;
};

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const stocks: StockItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: Resource.Stocks.name,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    stocks.push(...((response.Items ?? []) as StockItem[]));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);

  stocks.sort((first, second) => first.symbol.localeCompare(second.symbol));

  return json({
    count: stocks.length,
    stocks
  });
}

export async function get(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const symbol = cleanSymbol(event.pathParameters?.symbol);
  if (!symbol) {
    return error("Missing stock symbol.");
  }

  const response = await documentClient.send(
    new GetCommand({
      TableName: Resource.Stocks.name,
      Key: { symbol }
    })
  );

  if (!response.Item) {
    return error("Stock not found.", 404);
  }

  return json({ stock: response.Item });
}

export async function create(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  let body: unknown;
  try {
    body = parseJsonBody(event);
  } catch {
    return error("Request body must be valid JSON.");
  }

  const stock = normalizeStock(body);
  if (!stock.ok) {
    return error(stock.message);
  }

  const existing = await getStock(stock.item.symbol);
  if (existing) {
    return json(
      {
        stock: existing,
        executedActions: existing.executedActions ?? [],
        subscribe: buildSubscription(existing.executedActions ?? []),
        cached: true
      },
      200
    );
  }

  const enriched = await applyProfileTags(stock.item);
  const executedActions = [
    await executeStockAction(STOCK_NEW_ADDED_ACTION, enriched),
    await executeStockAction(STOCK_PROCESS_ACTION, enriched)
  ];
  const item: StockItem = {
    ...enriched,
    processingState: "being_processed",
    executedActions
  };
  await putStock(item);
  await invokeProcessor(item.symbol);

  return json(
    {
      stock: item,
      executedActions,
      subscribe: buildSubscription(executedActions),
      cached: false
    },
    201
  );
}

export async function batchCreate(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  let body: unknown;
  try {
    body = parseJsonBody(event);
  } catch {
    return error("Request body must be valid JSON.");
  }

  const rawStocks = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.stocks) ? body.stocks : null;
  if (!rawStocks) {
    return error("Batch request body must be an array or an object with a stocks array.");
  }

  const normalized = rawStocks.map((item) => normalizeStock(item));
  const invalid = normalized
    .map((result, index) => ({ result, index }))
    .filter((entry): entry is { result: { ok: false; message: string }; index: number } => !entry.result.ok);

  if (invalid.length > 0) {
    return error(
      "One or more stocks are invalid.",
      400,
      invalid.map(({ index, result }) => ({ index, message: result.message }))
    );
  }

  const stocks = dedupeBySymbol(
    normalized.map((result) => {
      if (!result.ok) {
        throw new Error("Unexpected invalid stock after validation.");
      }
      return result.item;
    })
  );

  const existingBySymbol = await getStocksBySymbol(stocks.map((stock) => stock.symbol));

  const cachedItems: StockItem[] = [];
  const newStocks: StockItem[] = [];
  for (const stock of stocks) {
    const existing = existingBySymbol.get(stock.symbol);
    if (existing) {
      cachedItems.push(existing);
    } else {
      newStocks.push(stock);
    }
  }

  const enrichedStocks = await Promise.all(newStocks.map((stock) => applyProfileTags(stock)));
  const newExecutedActionsPerStock = await Promise.all(
    enrichedStocks.map(async (stock) => [
      await executeStockAction(STOCK_NEW_ADDED_ACTION, stock),
      await executeStockAction(STOCK_PROCESS_ACTION, stock)
    ])
  );
  const newItems: StockItem[] = enrichedStocks.map((stock, index) => ({
    ...stock,
    processingState: "being_processed",
    executedActions: newExecutedActionsPerStock[index]
  }));

  if (newItems.length > 0) {
    await batchPutStocks(newItems);
    await Promise.all(newItems.map((item) => invokeProcessor(item.symbol)));
  }

  const items = [...cachedItems, ...newItems];

  const allExecutedActions = [
    ...cachedItems.flatMap((item) => item.executedActions ?? []),
    ...newExecutedActionsPerStock.flat()
  ];

  return json(
    {
      count: items.length,
      stocks: items,
      executedActions: allExecutedActions,
      subscribe: buildSubscription(allExecutedActions),
      cachedCount: cachedItems.length,
      newCount: newItems.length
    },
    201
  );
}

async function getStock(symbol: string): Promise<StockItem | undefined> {
  const response = await documentClient.send(
    new GetCommand({
      TableName: Resource.Stocks.name,
      Key: { symbol }
    })
  );

  return response.Item as StockItem | undefined;
}

async function putStock(stock: StockItem): Promise<void> {
  await documentClient.send(
    new PutCommand({
      TableName: Resource.Stocks.name,
      Item: stock
    })
  );
}

async function getStocksBySymbol(symbols: string[]): Promise<Map<string, StockItem>> {
  const stocks = new Map<string, StockItem>();

  for (let index = 0; index < symbols.length; index += 100) {
    let requestKeys = symbols.slice(index, index + 100).map((symbol) => ({ symbol }));

    do {
      const response = await documentClient.send(
        new BatchGetCommand({
          RequestItems: {
            [Resource.Stocks.name]: {
              Keys: requestKeys
            }
          }
        })
      );

      for (const stock of ((response.Responses?.[Resource.Stocks.name] ?? []) as StockItem[])) {
        stocks.set(stock.symbol, stock);
      }

      requestKeys = (response.UnprocessedKeys?.[Resource.Stocks.name]?.Keys ?? []) as typeof requestKeys;
    } while (requestKeys.length > 0);
  }

  return stocks;
}

async function batchPutStocks(stocks: StockItem[]): Promise<void> {
  for (let index = 0; index < stocks.length; index += 25) {
    let requestItems = {
      [Resource.Stocks.name]: stocks.slice(index, index + 25).map((stock) => ({
        PutRequest: {
          Item: stock
        }
      }))
    };

    do {
      const response = await documentClient.send(
        new BatchWriteCommand({
          RequestItems: requestItems
        })
      );
      requestItems = response.UnprocessedItems as typeof requestItems;
    } while (requestItems?.[Resource.Stocks.name]?.length);
  }
}

function buildSubscription(executedActions: ExecutedAction[]): {
  method: "long-poll";
  pollUrl: string;
  waitSeconds: number;
  eventIds: string[];
} | null {
  if (executedActions.length === 0) {
    return null;
  }
  const firstEventId = executedActions[0].eventId;
  return {
    method: "long-poll",
    pollUrl: `/events?from=${encodeURIComponent(firstEventId)}&waitSeconds=25`,
    waitSeconds: 25,
    eventIds: executedActions.map((entry) => entry.eventId)
  };
}

async function executeStockAction(action: StockAction, stock: StockItem): Promise<ExecutedAction> {
  const execution = {
    action,
    symbol: stock.symbol
  };

  console.info("stock action executed", execution);
  const event = await publishEvent(action, execution);
  return {
    ...execution,
    eventId: event.eventId
  };
}

async function invokeProcessor(symbol: string): Promise<void> {
  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: Resource.ProcessStock.name,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ symbol }))
      })
    );
  } catch (cause) {
    console.error("failed to invoke ProcessStock", { symbol, cause });
  }
}

function normalizeStock(input: unknown): { ok: true; item: StockItem } | { ok: false; message: string } {
  if (!isRecord(input)) {
    return { ok: false, message: "Stock must be an object." };
  }

  const symbol = cleanSymbol(input.symbol);
  if (!symbol) {
    return { ok: false, message: "Stock symbol is required." };
  }

  const now = nowIso();
  return {
    ok: true,
    item: {
      symbol,
      ...optionalString("name", input.name),
      ...optionalString("exchange", input.exchange),
      ...optionalString("currency", input.currency),
      ...optionalString("sector", input.sector),
      ...optionalString("industry", input.industry),
      ...optionalString("country", input.country),
      ...(Array.isArray(input.tags)
        ? { tags: normalizeUserTags(input.tags) }
        : {}),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      createdAt: now,
      updatedAt: now
    }
  };
}

function normalizeUserTags(tags: unknown[]): string[] {
  const out = new Set<string>();
  for (const tag of tags) {
    const value = String(tag ?? "").trim();
    if (value) out.add(value);
  }
  return [...out];
}

async function fetchProfile(symbol: string): Promise<ProfileLookup | undefined> {
  const apiKey = Resource.FMP_API_KEY.value;
  if (!apiKey) return undefined;
  const url = `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    const data = (await response.json()) as unknown;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object") return undefined;
    const r = row as Record<string, unknown>;
    const pick = (key: string): string | undefined => {
      const value = r[key];
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };
    return {
      name: pick("companyName") ?? pick("name"),
      exchange: pick("exchange") ?? pick("exchangeShortName"),
      currency: pick("currency"),
      sector: pick("sector"),
      industry: pick("industry"),
      country: pick("country"),
      isEtf: r.isEtf === true,
      isFund: r.isFund === true,
      isAdr: r.isAdr === true
    };
  } catch (cause) {
    console.error("stocks.fetchProfile failed", { symbol, cause });
    return undefined;
  }
}

async function applyProfileTags(stock: StockItem): Promise<StockItem> {
  const profile = await fetchProfile(stock.symbol);
  const merged: StockItem = {
    ...stock,
    name: stock.name ?? profile?.name,
    exchange: stock.exchange ?? profile?.exchange,
    currency: stock.currency ?? profile?.currency,
    sector: stock.sector ?? profile?.sector,
    industry: stock.industry ?? profile?.industry,
    country: stock.country ?? profile?.country,
    isEtf: profile?.isEtf ?? stock.isEtf,
    isFund: profile?.isFund ?? stock.isFund,
    isAdr: profile?.isAdr ?? stock.isAdr
  };
  merged.tags = buildTags(merged);
  return merged;
}

function buildTags(stock: StockItem): string[] {
  const tags = new Set<string>();
  for (const value of stock.tags ?? []) {
    if (value && value.trim()) tags.add(value.trim());
  }
  if (stock.sector) tags.add(`sector:${stock.sector}`);
  if (stock.industry) tags.add(`industry:${stock.industry}`);
  if (stock.exchange) tags.add(`exchange:${stock.exchange}`);
  if (stock.country) tags.add(`country:${stock.country}`);
  if (stock.currency) tags.add(`currency:${stock.currency}`);
  if (stock.isEtf) tags.add("type:etf");
  if (stock.isFund) tags.add("type:fund");
  if (stock.isAdr) tags.add("type:adr");
  if (!stock.isEtf && !stock.isFund && !stock.isAdr) tags.add("type:equity");
  return [...tags];
}

function optionalString(key: keyof StockItem, value: unknown): Partial<StockItem> {
  if (value === undefined || value === null || String(value).trim() === "") {
    return {};
  }
  return { [key]: String(value).trim() } as Partial<StockItem>;
}

function dedupeBySymbol(stocks: StockItem[]): StockItem[] {
  const bySymbol = new Map<string, StockItem>();
  for (const stock of stocks) {
    bySymbol.set(stock.symbol, stock);
  }
  return [...bySymbol.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
