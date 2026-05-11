import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { publishEvent } from "./events";
import { error, json, nowIso, requireBearerToken } from "./http";
import { scanAllPulse, type PulseRow, type PulseStatus } from "./pulse";
import {
  computeAndStoreRegime,
  type RegimeClassification,
  type RegimeRow,
  type RegimeScale
} from "./regime";

const ALL_SCALES: RegimeScale[] = ["intraday", "daily", "weekly", "monthly", "quarterly"];
const ALIGNMENT_SCOPE = "global";
const MARKET_STATE_UPDATED = "MARKET_STATE_UPDATED";
const MAX_LIST_LIMIT = 100;

const PULSE_RISK_SCORE: Record<PulseStatus, number> = {
  calm: 0,
  watch: 25,
  elevated: 60,
  critical: 90
};

const SCALE_BIAS_WEIGHT: Record<RegimeScale, number> = {
  intraday: 0.5,
  daily: 1,
  weekly: 1.5,
  monthly: 2,
  quarterly: 1.5
};

export type CompositeRiskLevel = "low" | "medium" | "high" | "extreme";

export type AlignmentRegimeSnapshot = {
  scale: RegimeScale;
  classification: RegimeClassification;
  score: number;
  itemCount: number;
  topThemes: string[];
  summary: string;
  computedAt: string;
};

export type AlignmentPulseSnapshot = {
  region: string;
  status: PulseStatus;
  criticality: number;
  severity: number;
  topThemes: string[];
  summary: string;
  stale: boolean;
  updatedAt: string;
};

export type MarketAlignmentRow = {
  scope: typeof ALIGNMENT_SCOPE;
  alignedAt: string;
  regimes: AlignmentRegimeSnapshot[];
  pulse: AlignmentPulseSnapshot[];
  composite: {
    riskLevel: CompositeRiskLevel;
    bias: RegimeClassification;
    biasScore: number;
    pulseRiskScore: number;
    hotRegions: string[];
    summary: string;
  };
};

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function alignMarketState(): Promise<MarketAlignmentRow> {
  const regimes = await Promise.all(
    ALL_SCALES.map(async (scale) => {
      try {
        return await computeAndStoreRegime(scale);
      } catch (cause) {
        console.error("Failed to recompute regime", { scale, cause });
        return undefined;
      }
    })
  );

  const pulse = await safeScanPulse();
  const row = buildAlignment(regimes.filter((entry): entry is RegimeRow => Boolean(entry)), pulse);

  await documentClient.send(
    new PutCommand({
      TableName: Resource.MarketAlignment.name,
      Item: row
    })
  );

  const previous = await fetchPreviousAlignment(row.alignedAt);
  if (!previous || previous.composite.riskLevel !== row.composite.riskLevel || previous.composite.bias !== row.composite.bias) {
    await publishEvent(MARKET_STATE_UPDATED, {
      action: MARKET_STATE_UPDATED,
      previousRiskLevel: previous?.composite.riskLevel ?? null,
      previousBias: previous?.composite.bias ?? null,
      riskLevel: row.composite.riskLevel,
      bias: row.composite.bias,
      biasScore: row.composite.biasScore,
      pulseRiskScore: row.composite.pulseRiskScore,
      hotRegions: row.composite.hotRegions,
      summary: row.composite.summary
    });
  }

  return row;
}

export async function current(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const latest = await fetchLatestAlignment();
  if (!latest) {
    return json({ alignment: null });
  }
  return json({ alignment: latest });
}

export async function history(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const limitParam = Number(event.queryStringParameters?.limit ?? 20);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), MAX_LIST_LIMIT) : 20;

  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.MarketAlignment.name,
      KeyConditionExpression: "#scope = :scope",
      ExpressionAttributeNames: { "#scope": "scope" },
      ExpressionAttributeValues: { ":scope": ALIGNMENT_SCOPE },
      ScanIndexForward: false,
      Limit: limit
    })
  );

  const items = (response.Items ?? []) as MarketAlignmentRow[];
  return json({ count: items.length, alignments: items });
}

export async function triggerAlign(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }
  try {
    const row = await alignMarketState();
    return json({ alignment: row }, 201);
  } catch (cause) {
    console.error("Failed to align market state", { cause });
    return error("Failed to align market state.", 500);
  }
}

function buildAlignment(regimes: RegimeRow[], pulse: PulseRow[]): MarketAlignmentRow {
  const alignedAt = nowIso();

  const regimeSnapshots: AlignmentRegimeSnapshot[] = regimes.map((row) => ({
    scale: row.scale,
    classification: row.classification,
    score: row.score,
    itemCount: row.itemCount,
    topThemes: row.topThemes,
    summary: row.summary,
    computedAt: row.computedAt
  }));

  const pulseSnapshots: AlignmentPulseSnapshot[] = pulse
    .map((row) => ({
      region: row.region,
      status: row.status,
      criticality: row.criticality,
      severity: row.severity,
      topThemes: row.topThemes,
      summary: row.summary,
      stale: Boolean(row.stale),
      updatedAt: row.updatedAt
    }))
    .sort((first, second) => second.criticality - first.criticality);

  let weightedBias = 0;
  let totalWeight = 0;
  for (const snapshot of regimeSnapshots) {
    const weight = SCALE_BIAS_WEIGHT[snapshot.scale];
    weightedBias += snapshot.score * weight;
    totalWeight += weight;
  }
  const biasScore = totalWeight > 0 ? Math.round((weightedBias / totalWeight) * 10) / 10 : 0;
  const bias = biasFromScore(biasScore);

  const pulseRiskScore =
    pulseSnapshots
      .filter((row) => !row.stale)
      .reduce((max, row) => Math.max(max, PULSE_RISK_SCORE[row.status], row.criticality), 0) || 0;

  const hotRegions = pulseSnapshots
    .filter((row) => !row.stale && (row.status === "elevated" || row.status === "critical"))
    .slice(0, 5)
    .map((row) => row.region);

  const riskLevel = riskLevelFrom(pulseRiskScore, biasScore);

  return {
    scope: ALIGNMENT_SCOPE,
    alignedAt,
    regimes: regimeSnapshots,
    pulse: pulseSnapshots,
    composite: {
      riskLevel,
      bias,
      biasScore,
      pulseRiskScore,
      hotRegions,
      summary: buildSummary(riskLevel, bias, biasScore, hotRegions)
    }
  };
}

function biasFromScore(score: number): RegimeClassification {
  if (score >= 50) return "risk_on";
  if (score >= 15) return "bullish";
  if (score > -15) return "neutral";
  if (score > -50) return "bearish";
  return "risk_off";
}

function riskLevelFrom(pulseRiskScore: number, biasScore: number): CompositeRiskLevel {
  const bearishDrag = biasScore < 0 ? Math.min(40, Math.abs(biasScore) * 0.4) : 0;
  const combined = pulseRiskScore + bearishDrag;
  if (combined >= 85) return "extreme";
  if (combined >= 55) return "high";
  if (combined >= 25) return "medium";
  return "low";
}

function buildSummary(
  riskLevel: CompositeRiskLevel,
  bias: RegimeClassification,
  biasScore: number,
  hotRegions: string[]
): string {
  const hotPart = hotRegions.length > 0 ? `, hot regions: ${hotRegions.join(", ")}` : "";
  return `Risk ${riskLevel} — regime bias ${bias} (${biasScore})${hotPart}.`;
}

async function fetchLatestAlignment(): Promise<MarketAlignmentRow | undefined> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.MarketAlignment.name,
      KeyConditionExpression: "#scope = :scope",
      ExpressionAttributeNames: { "#scope": "scope" },
      ExpressionAttributeValues: { ":scope": ALIGNMENT_SCOPE },
      ScanIndexForward: false,
      Limit: 1
    })
  );
  return ((response.Items ?? []) as MarketAlignmentRow[])[0];
}

async function fetchPreviousAlignment(excludingKey: string): Promise<MarketAlignmentRow | undefined> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.MarketAlignment.name,
      KeyConditionExpression: "#scope = :scope",
      ExpressionAttributeNames: { "#scope": "scope" },
      ExpressionAttributeValues: { ":scope": ALIGNMENT_SCOPE },
      ScanIndexForward: false,
      Limit: 2
    })
  );
  const rows = (response.Items ?? []) as MarketAlignmentRow[];
  return rows.find((row) => row.alignedAt !== excludingKey);
}

async function safeScanPulse(): Promise<PulseRow[]> {
  try {
    return await scanAllPulse();
  } catch (cause) {
    console.error("Failed to scan pulse during alignment", { cause });
    return [];
  }
}
