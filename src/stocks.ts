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
import { publishEvent } from "./events";
import { cleanSymbol, error, json, nowIso, parseJsonBody, requireBearerToken } from "./http";

type ExecutedAction = {
  action: typeof STOCK_NEW_ADDED_ACTION;
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
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
  executedActions?: ExecutedAction[];
};

const STOCK_NEW_ADDED_ACTION = "STCO_NEW_ADDED";
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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

  const executedActions = [await executeStockAction(STOCK_NEW_ADDED_ACTION, stock.item)];
  const item: StockItem = { ...stock.item, executedActions };
  await putStock(item);

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

  const newExecutedActions = await Promise.all(
    newStocks.map((stock) => executeStockAction(STOCK_NEW_ADDED_ACTION, stock))
  );
  const newItems: StockItem[] = newStocks.map((stock, index) => ({
    ...stock,
    executedActions: [newExecutedActions[index]]
  }));

  if (newItems.length > 0) {
    await batchPutStocks(newItems);
  }

  const items = [...cachedItems, ...newItems];

  const allExecutedActions = [
    ...cachedItems.flatMap((item) => item.executedActions ?? []),
    ...newExecutedActions
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

async function executeStockAction(
  action: typeof STOCK_NEW_ADDED_ACTION,
  stock: StockItem
): Promise<{ action: typeof STOCK_NEW_ADDED_ACTION; symbol: string; eventId: string }> {
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
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      createdAt: now,
      updatedAt: now
    }
  };
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
