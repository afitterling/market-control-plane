import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { publishEvent } from "./events";
import { error, json, nowIso, parseJsonBody, requireBearerToken } from "./http";
import { scanAllPulse, type PulseRow } from "./pulse";

export type RegimeScale = "intraday" | "daily" | "weekly" | "monthly" | "quarterly";

export type RegimeClassification =
  | "risk_off"
  | "bearish"
  | "neutral"
  | "bullish"
  | "risk_on";

export type SentimentItemRow = {
  scale: RegimeScale;
  date: string;
  kind: "item";
  itemId: string;
  source: string;
  sentiment: number;
  confidence: number;
  weight: number;
  themes: string[];
  summary?: string;
  observedAt: string;
  createdAt: string;
};

export type RegimeRow = {
  scale: RegimeScale;
  date: string;
  kind: "regime";
  classification: RegimeClassification;
  score: number;
  itemCount: number;
  windowStart: string;
  windowEnd: string;
  topThemes: string[];
  summary: string;
  computedAt: string;
};

type RegimeRowAny = SentimentItemRow | RegimeRow;

const REGIME_UPDATED = "MARKET_REGIME_UPDATED";
const ALL_SCALES: RegimeScale[] = ["intraday", "daily", "weekly", "monthly", "quarterly"];

// Half-life for recency decay, in milliseconds — the "time effect" of each scale.
const SCALE_HALF_LIFE_MS: Record<RegimeScale, number> = {
  intraday: 2 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 5 * 24 * 60 * 60 * 1000,
  monthly: 20 * 24 * 60 * 60 * 1000,
  quarterly: 60 * 24 * 60 * 60 * 1000
};

// Look-back window when processing items for a scale.
const SCALE_WINDOW_MS: Record<RegimeScale, number> = {
  intraday: 12 * 60 * 60 * 1000,
  daily: 7 * 24 * 60 * 60 * 1000,
  weekly: 30 * 24 * 60 * 60 * 1000,
  monthly: 120 * 24 * 60 * 60 * 1000,
  quarterly: 365 * 24 * 60 * 60 * 1000
};

const ITEM_PREFIX = "item#";
const REGIME_PREFIX = "regime#";
const MAX_LIMIT = 200;

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const latestPerScale = await Promise.all(
    ALL_SCALES.map(async (scale) => {
      const latest = await fetchLatestRegime(scale);
      return { scale, regime: latest ?? null };
    })
  );

  return json({ count: latestPerScale.length, scales: latestPerScale });
}

export async function getScale(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const scale = parseScale(event.pathParameters?.scale);
  if (!scale.ok) {
    return error(scale.message);
  }

  const params = event.queryStringParameters ?? {};
  const from = String(params.from ?? "").trim();
  const to = String(params.to ?? "").trim();
  const kindFilter = String(params.kind ?? "").trim().toLowerCase();
  const limit = parseLimit(params.limit);

  if (from && !isIsoTimestamp(from)) {
    return error("'from' must be an ISO timestamp.");
  }
  if (to && !isIsoTimestamp(to)) {
    return error("'to' must be an ISO timestamp.");
  }
  if (kindFilter && kindFilter !== "item" && kindFilter !== "regime") {
    return error("'kind' must be 'item' or 'regime'.");
  }

  const rows = await queryScale(scale.value, { from, to, limit });
  const items = kindFilter === "regime" ? [] : rows.filter((row): row is SentimentItemRow => row.kind === "item");
  const regimes = kindFilter === "item" ? [] : rows.filter((row): row is RegimeRow => row.kind === "regime");

  return json({
    scale: scale.value,
    halfLifeMs: SCALE_HALF_LIFE_MS[scale.value],
    windowMs: SCALE_WINDOW_MS[scale.value],
    itemCount: items.length,
    regimeCount: regimes.length,
    items,
    regimes
  });
}

export async function createItem(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
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

  const normalized = normalizeItem(body);
  if (!normalized.ok) {
    return error(normalized.message);
  }

  await documentClient.send(
    new PutCommand({
      TableName: Resource.MarketRegime.name,
      Item: normalized.item
    })
  );

  const wantRecompute = String(event.queryStringParameters?.recompute ?? "").trim() === "true";
  const [regime, pulse] = await Promise.all([
    wantRecompute ? computeAndStoreRegime(normalized.item.scale) : fetchLatestRegime(normalized.item.scale),
    safeScanPulse()
  ]);

  return json(
    {
      item: normalized.item,
      regime: regime ?? null,
      pulse: {
        count: pulse.length,
        regions: pulse.sort((first, second) => second.criticality - first.criticality)
      }
    },
    201
  );
}

async function safeScanPulse(): Promise<PulseRow[]> {
  try {
    return await scanAllPulse();
  } catch (cause) {
    console.error("Failed to scan pulse on regime item create", { cause });
    return [];
  }
}

export async function processScale(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const scale = parseScale(event.pathParameters?.scale);
  if (!scale.ok) {
    return error(scale.message);
  }

  const row = await computeAndStoreRegime(scale.value);
  return json({ regime: row });
}

export async function computeAndStoreRegime(scale: RegimeScale): Promise<RegimeRow> {
  const now = new Date();
  const windowEnd = now;
  const windowStart = new Date(windowEnd.getTime() - SCALE_WINDOW_MS[scale]);
  const halfLife = SCALE_HALF_LIFE_MS[scale];

  const items = await queryItems(scale, windowStart.toISOString(), windowEnd.toISOString());

  let weightedSum = 0;
  let totalWeight = 0;
  const themeWeights = new Map<string, number>();
  for (const item of items) {
    const observedTs = Date.parse(item.observedAt);
    if (!Number.isFinite(observedTs)) {
      continue;
    }
    const ageMs = Math.max(0, windowEnd.getTime() - observedTs);
    const decay = Math.pow(0.5, ageMs / halfLife);
    const effective = decay * (item.confidence || 0) * (item.weight || 1);
    weightedSum += item.sentiment * effective;
    totalWeight += effective;
    for (const theme of item.themes) {
      themeWeights.set(theme, (themeWeights.get(theme) ?? 0) + effective);
    }
  }

  const score = totalWeight > 0 ? clamp(weightedSum / totalWeight, -100, 100) : 0;
  const classification = bandFromScore(score);
  const topThemes = [...themeWeights.entries()]
    .sort((first, second) => second[1] - first[1])
    .slice(0, 5)
    .map(([theme]) => theme);

  const computedAt = nowIso();
  const row: RegimeRow = {
    scale,
    date: `${REGIME_PREFIX}${computedAt}`,
    kind: "regime",
    classification,
    score: Math.round(score * 10) / 10,
    itemCount: items.length,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    topThemes,
    summary: buildSummary(scale, classification, items.length, topThemes),
    computedAt
  };

  await documentClient.send(
    new PutCommand({
      TableName: Resource.MarketRegime.name,
      Item: row
    })
  );

  const previous = await fetchLatestRegime(scale, row.date);
  if (!previous || previous.classification !== row.classification) {
    await publishEvent(REGIME_UPDATED, {
      action: REGIME_UPDATED,
      scale,
      previousClassification: previous?.classification ?? null,
      classification: row.classification,
      score: row.score,
      itemCount: row.itemCount,
      summary: row.summary
    });
  }

  return row;
}

async function queryScale(
  scale: RegimeScale,
  options: { from: string; to: string; limit: number }
): Promise<RegimeRowAny[]> {
  const rows: RegimeRowAny[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: Resource.MarketRegime.name,
        KeyConditionExpression: "#scale = :scale",
        ExpressionAttributeNames: { "#scale": "scale" },
        ExpressionAttributeValues: { ":scale": scale },
        ScanIndexForward: false,
        Limit: options.limit,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    for (const item of (response.Items ?? []) as RegimeRowAny[]) {
      if (options.from && extractIso(item.date) < options.from) continue;
      if (options.to && extractIso(item.date) > options.to) continue;
      rows.push(item);
      if (rows.length >= options.limit) {
        return rows;
      }
    }
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rows;
}

async function queryItems(scale: RegimeScale, fromIso: string, toIso: string): Promise<SentimentItemRow[]> {
  const items: SentimentItemRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: Resource.MarketRegime.name,
        KeyConditionExpression: "#scale = :scale AND #date BETWEEN :from AND :to",
        ExpressionAttributeNames: { "#scale": "scale", "#date": "date" },
        ExpressionAttributeValues: {
          ":scale": scale,
          ":from": `${ITEM_PREFIX}${fromIso}`,
          ":to": `${ITEM_PREFIX}${toIso}#~`
        },
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    for (const row of (response.Items ?? []) as RegimeRowAny[]) {
      if (row.kind === "item") {
        items.push(row);
      }
    }
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

async function fetchLatestRegime(scale: RegimeScale, beforeKey?: string): Promise<RegimeRow | undefined> {
  const upper = beforeKey ?? `${REGIME_PREFIX}~`;
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.MarketRegime.name,
      KeyConditionExpression: "#scale = :scale AND #date BETWEEN :lo AND :hi",
      ExpressionAttributeNames: { "#scale": "scale", "#date": "date" },
      ExpressionAttributeValues: {
        ":scale": scale,
        ":lo": REGIME_PREFIX,
        ":hi": upper
      },
      ScanIndexForward: false,
      Limit: beforeKey ? 2 : 1
    })
  );
  const rows = (response.Items ?? []) as RegimeRow[];
  if (!beforeKey) {
    return rows[0];
  }
  return rows.find((row) => row.date !== beforeKey);
}

function normalizeItem(input: unknown): { ok: true; item: SentimentItemRow } | { ok: false; message: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: "Sentiment item must be an object." };
  }
  const record = input as Record<string, unknown>;

  const scaleResult = parseScale(record.scale);
  if (!scaleResult.ok) {
    return { ok: false, message: scaleResult.message };
  }

  const source = String(record.source ?? "").trim();
  if (!source) {
    return { ok: false, message: "Sentiment item 'source' is required." };
  }

  const sentimentNum = Number(record.sentiment);
  if (!Number.isFinite(sentimentNum)) {
    return { ok: false, message: "Sentiment item 'sentiment' must be a number between -100 and 100." };
  }
  const sentiment = clamp(sentimentNum, -100, 100);

  const confidenceRaw = record.confidence === undefined ? 1 : Number(record.confidence);
  if (!Number.isFinite(confidenceRaw)) {
    return { ok: false, message: "'confidence' must be a number between 0 and 1." };
  }
  const confidence = clamp(confidenceRaw, 0, 1);

  const weightRaw = record.weight === undefined ? 1 : Number(record.weight);
  if (!Number.isFinite(weightRaw) || weightRaw < 0) {
    return { ok: false, message: "'weight' must be a non-negative number." };
  }
  const weight = weightRaw;

  const observedAt = String(record.observedAt ?? record.date ?? nowIso()).trim();
  if (!isIsoTimestamp(observedAt)) {
    return { ok: false, message: "'observedAt' must be an ISO timestamp." };
  }

  const themes = Array.isArray(record.themes)
    ? [...new Set(record.themes.map((entry) => String(entry).trim()).filter(Boolean))]
    : [];

  const summary = typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : undefined;
  const itemId = String(record.itemId ?? "").trim() || randomUUID();
  const createdAt = nowIso();

  return {
    ok: true,
    item: {
      scale: scaleResult.value,
      date: `${ITEM_PREFIX}${observedAt}#${itemId}`,
      kind: "item",
      itemId,
      source,
      sentiment,
      confidence,
      weight,
      themes,
      ...(summary ? { summary } : {}),
      observedAt,
      createdAt
    }
  };
}

function parseScale(value: unknown): { ok: true; value: RegimeScale } | { ok: false; message: string } {
  const candidate = String(value ?? "").trim().toLowerCase();
  if (!ALL_SCALES.includes(candidate as RegimeScale)) {
    return { ok: false, message: `Scale must be one of: ${ALL_SCALES.join(", ")}.` };
  }
  return { ok: true, value: candidate as RegimeScale };
}

function parseLimit(value: string | undefined): number {
  const limit = Number(value ?? MAX_LIMIT);
  if (!Number.isFinite(limit)) {
    return MAX_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function isIsoTimestamp(value: string): boolean {
  if (!value) return false;
  const ts = Date.parse(value);
  return Number.isFinite(ts);
}

function extractIso(sortKey: string): string {
  if (sortKey.startsWith(ITEM_PREFIX)) {
    const rest = sortKey.slice(ITEM_PREFIX.length);
    return rest.split("#")[0] ?? "";
  }
  if (sortKey.startsWith(REGIME_PREFIX)) {
    return sortKey.slice(REGIME_PREFIX.length);
  }
  return sortKey;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function bandFromScore(score: number): RegimeClassification {
  if (score >= 50) return "risk_on";
  if (score >= 15) return "bullish";
  if (score > -15) return "neutral";
  if (score > -50) return "bearish";
  return "risk_off";
}

function buildSummary(scale: RegimeScale, classification: RegimeClassification, itemCount: number, themes: string[]): string {
  if (itemCount === 0) {
    return `${scale} regime ${classification} — no items in window.`;
  }
  const themesPart = themes.length > 0 ? `themes: ${themes.join(", ")}` : "no dominant theme";
  return `${scale} regime ${classification} — ${itemCount} item${itemCount === 1 ? "" : "s"}, ${themesPart}.`;
}
