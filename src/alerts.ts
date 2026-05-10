import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { error, json, nowIso, parseJsonBody, requireBearerToken } from "./http";

export type MarketSession = "premarket" | "regular" | "afterhours";

export type SignalAlertRecord = {
  alertId: string;
  name: string;
  description?: string;
  enabled: boolean;
  sessions: MarketSession[];
  scope?: { symbols?: string[] };
  condition?: unknown;
  createdAt: string;
  updatedAt: string;
};

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const alerts = await scanAlerts();
  alerts.sort((first, second) => first.name.localeCompare(second.name));
  return json({ count: alerts.length, alerts });
}

export async function get(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const alertId = String(event.pathParameters?.alertId ?? "").trim();
  if (!alertId) {
    return error("Missing alertId.");
  }

  const response = await documentClient.send(
    new GetCommand({
      TableName: Resource.SignalAlerts.name,
      Key: { alertId }
    })
  );

  if (!response.Item) {
    return error("Alert not found.", 404);
  }
  return json({ alert: response.Item });
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

  const normalized = normalize(body);
  if (!normalized.ok) {
    return error(normalized.message);
  }

  await documentClient.send(
    new PutCommand({
      TableName: Resource.SignalAlerts.name,
      Item: normalized.item
    })
  );

  return json({ alert: normalized.item }, 201);
}

export async function remove(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const alertId = String(event.pathParameters?.alertId ?? "").trim();
  if (!alertId) {
    return error("Missing alertId.");
  }

  await documentClient.send(
    new DeleteCommand({
      TableName: Resource.SignalAlerts.name,
      Key: { alertId }
    })
  );

  return json({ alertId, deleted: true });
}

export async function scanAlerts(): Promise<SignalAlertRecord[]> {
  const alerts: SignalAlertRecord[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: Resource.SignalAlerts.name,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    alerts.push(...((response.Items ?? []) as SignalAlertRecord[]));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return alerts;
}

function normalize(input: unknown): { ok: true; item: SignalAlertRecord } | { ok: false; message: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: "Alert must be an object." };
  }
  const record = input as Record<string, unknown>;

  const name = String(record.name ?? "").trim();
  if (!name) {
    return { ok: false, message: "Alert name is required." };
  }

  const sessions = normalizeSessions(record.sessions);
  if (sessions.length === 0) {
    return { ok: false, message: "Alert sessions must include at least one of premarket, regular, afterhours." };
  }

  const scope = normalizeScope(record.scope);
  const now = nowIso();

  return {
    ok: true,
    item: {
      alertId: String(record.alertId ?? "").trim() || randomUUID(),
      name,
      ...(typeof record.description === "string" && record.description.trim() ? { description: record.description.trim() } : {}),
      enabled: record.enabled !== false,
      sessions,
      ...(scope ? { scope } : {}),
      ...(record.condition === undefined ? {} : { condition: record.condition }),
      createdAt: now,
      updatedAt: now
    }
  };
}

function normalizeSessions(value: unknown): MarketSession[] {
  if (!Array.isArray(value)) {
    return ["regular"];
  }
  const allowed: MarketSession[] = ["premarket", "regular", "afterhours"];
  const seen = new Set<MarketSession>();
  for (const entry of value) {
    const candidate = String(entry).trim().toLowerCase() as MarketSession;
    if (allowed.includes(candidate)) {
      seen.add(candidate);
    }
  }
  return [...seen];
}

function normalizeScope(value: unknown): { symbols?: string[] } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const symbols = (value as { symbols?: unknown }).symbols;
  if (!Array.isArray(symbols)) {
    return undefined;
  }
  const cleaned = symbols.map((entry) => String(entry).trim().toUpperCase()).filter(Boolean);
  return cleaned.length > 0 ? { symbols: [...new Set(cleaned)] } : undefined;
}
