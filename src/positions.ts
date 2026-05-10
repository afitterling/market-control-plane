import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { cleanSymbol, error, json, nowIso, parseJsonBody, requireBearerToken } from "./http";

type PositionItem = {
  accountId: string;
  symbol: string;
  quantity: number;
  averageCost?: number;
  currency?: string;
  createdAt: string;
  updatedAt: string;
};

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const accountId = String(event.queryStringParameters?.accountId ?? "").trim();
  const positions: PositionItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await documentClient.send(
      accountId
        ? new QueryCommand({
            TableName: Resource.Positions.name,
            KeyConditionExpression: "accountId = :accountId",
            ExpressionAttributeValues: {
              ":accountId": accountId
            },
            ExclusiveStartKey: exclusiveStartKey
          })
        : new ScanCommand({
            TableName: Resource.Positions.name,
            ExclusiveStartKey: exclusiveStartKey
          })
    );
    positions.push(...((response.Items ?? []) as PositionItem[]));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);

  positions.sort((first, second) => first.accountId.localeCompare(second.accountId) || first.symbol.localeCompare(second.symbol));

  return json({
    count: positions.length,
    positions
  });
}

export async function get(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const accountId = String(event.pathParameters?.accountId ?? "").trim();
  const symbol = cleanSymbol(event.pathParameters?.symbol);

  if (!accountId || !symbol) {
    return error("Missing accountId or symbol.");
  }

  const response = await documentClient.send(
    new GetCommand({
      TableName: Resource.Positions.name,
      Key: { accountId, symbol }
    })
  );

  if (!response.Item) {
    return error("Position not found.", 404);
  }

  return json({ position: response.Item });
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

  const position = normalizePosition(body);
  if (!position.ok) {
    return error(position.message);
  }

  await documentClient.send(
    new PutCommand({
      TableName: Resource.Positions.name,
      Item: position.item
    })
  );

  return json(
    {
      position: position.item
    },
    201
  );
}

function normalizePosition(input: unknown): { ok: true; item: PositionItem } | { ok: false; message: string } {
  if (!isRecord(input)) {
    return { ok: false, message: "Position must be an object." };
  }

  const accountId = String(input.accountId ?? "").trim();
  const symbol = cleanSymbol(input.symbol);
  const quantity = Number(input.quantity);

  if (!accountId) {
    return { ok: false, message: "Position accountId is required." };
  }
  if (!symbol) {
    return { ok: false, message: "Position symbol is required." };
  }
  if (!Number.isFinite(quantity)) {
    return { ok: false, message: "Position quantity must be a number." };
  }

  const averageCost = input.averageCost === undefined || input.averageCost === null ? undefined : Number(input.averageCost);
  if (averageCost !== undefined && !Number.isFinite(averageCost)) {
    return { ok: false, message: "Position averageCost must be a number when provided." };
  }

  const now = nowIso();
  return {
    ok: true,
    item: {
      accountId,
      symbol,
      quantity,
      ...(averageCost === undefined ? {} : { averageCost }),
      ...(input.currency === undefined || input.currency === null ? {} : { currency: String(input.currency).trim().toUpperCase() }),
      createdAt: now,
      updatedAt: now
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
