import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { nowIso } from "./http";
import { safeAnalyzeJson } from "./claude";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SCOPE = "global";
const PULSE_SCOPE = "global";
const RETENTION = 50;

/** Fixed set of focuses for the financial-policy read, in display order. */
const FOCUSES = ["Global", "US", "Europe", "Asia"] as const;
type Focus = (typeof FOCUSES)[number];

type Direction = "up" | "flat" | "down";

export type FinancialPolicyRegion = {
  region: Focus;
  centralBank: string;
  stance: "hawkish" | "neutral" | "dovish";
  ratePath: "hiking" | "hold" | "cutting";
  ratePathNote: string;
  inflation: { trend: Direction; note: string };
  yieldSpread: { signal: "steepening" | "flat" | "inverting"; note: string };
  usd: { bias: "stronger" | "neutral" | "weaker"; note: string };
  gold: { bias: "bullish" | "neutral" | "bearish"; note: string };
  marketImpact: { stance: "RISK-ON" | "NEUTRAL" | "RISK-OFF"; narrative: string; sectors: string[] };
  narrative: string;
};

export type FinancialPolicy = {
  scope?: string;
  generatedAt: string;
  cadence: string;
  summary: string;
  regions: FinancialPolicyRegion[];
};

/** Minimal read-shape of the pulse snapshot we ground the assessment in. */
type PulseSnapshotLite = {
  scope: string;
  snapshotAt: string;
  riskState?: string;
  overall?: {
    status?: string;
    score?: number;
    hotRegions?: string[];
    topThemes?: string[];
    summary?: string;
  };
  regions?: Array<{
    region: string;
    status?: string;
    criticality?: number;
    severity?: number;
    topThemes?: string[];
    summary?: string;
  }>;
  marketData?: { vix?: { value?: number; changePercent?: number; status?: string } | null };
};

const SYSTEM =
  "You are a macro and monetary-policy analyst. From the market-pulse context, write a forward-looking read on central-bank policy, rates, inflation, yields, the US dollar, gold, and the likely market impact for each requested focus. Be specific and concise. Never invent precise figures; describe direction and bias instead.";

const SHAPE = `{
  "summary": string,                       // 1-2 sentence cross-focus overview
  "regions": [                              // exactly 4 entries, in this order: Global, US, Europe, Asia
    {
      "region": "Global" | "US" | "Europe" | "Asia",
      "centralBank": string,               // e.g. "Federal Reserve", "ECB", "BoJ / PBoC", "—" for Global
      "stance": "hawkish" | "neutral" | "dovish",
      "ratePath": "hiking" | "hold" | "cutting",
      "ratePathNote": string,              // short note on the expected policy-rate direction
      "inflation": { "trend": "up" | "flat" | "down", "note": string },
      "yieldSpread": { "signal": "steepening" | "flat" | "inverting", "note": string },
      "usd": { "bias": "stronger" | "neutral" | "weaker", "note": string },
      "gold": { "bias": "bullish" | "neutral" | "bearish", "note": string },
      "marketImpact": { "stance": "RISK-ON" | "NEUTRAL" | "RISK-OFF", "narrative": string, "sectors": string[] },
      "narrative": string                  // 1-2 sentence regional read
    }
  ]
}`;

/**
 * Cron: generate an AI financial-policy read for Global/US/Europe/Asia, grounded
 * in the latest pulse snapshot, and cache it. On failure (inference or bad JSON)
 * it logs and returns, leaving the last good cache in place.
 */
export async function generate(): Promise<void> {
  const snapshot = await fetchLatestPulseSnapshot();

  const context = {
    riskState: snapshot?.riskState ?? null,
    overall: snapshot?.overall ?? null,
    regions: (snapshot?.regions ?? []).map((row) => ({
      region: row.region,
      status: row.status,
      criticality: row.criticality,
      severity: row.severity,
      topThemes: row.topThemes ?? [],
      summary: row.summary
    })),
    vix: snapshot?.marketData?.vix ?? null
  };

  const { data, error } = await safeAnalyzeJson<{ summary: string; regions: FinancialPolicyRegion[] }>({
    system: SYSTEM,
    instruction:
      "Write a financial-policy read for each of these four focuses: Global, US, Europe, Asia. For each, cover central-bank stance, the policy-rate path, the inflation trend, the yield-curve/spread signal, the US dollar bias, gold, and the likely market impact (with affected sectors).",
    shape: SHAPE,
    context
  });

  if (!data || !Array.isArray(data.regions) || data.regions.length === 0) {
    console.error("financialPolicy.generate: no usable result; keeping last cache", { error });
    return;
  }

  const regions = orderRegions(data.regions);
  const payload: FinancialPolicy = {
    scope: SCOPE,
    generatedAt: nowIso(),
    cadence: "Hourly AI assessment",
    summary: data.summary ?? "",
    regions
  };

  await persist(payload);
}

/** Latest cached financial-policy read, or null if none has been generated yet. */
export async function fetchLatestFinancialPolicy(): Promise<FinancialPolicy | null> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.FinancialPolicyCache.name,
      KeyConditionExpression: "#scope = :scope",
      ExpressionAttributeNames: { "#scope": "scope" },
      ExpressionAttributeValues: { ":scope": SCOPE },
      ScanIndexForward: false,
      Limit: 1
    })
  );
  return ((response.Items ?? []) as FinancialPolicy[])[0] ?? null;
}

async function fetchLatestPulseSnapshot(): Promise<PulseSnapshotLite | undefined> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.MarketPulseSnapshot.name,
      KeyConditionExpression: "#scope = :scope",
      ExpressionAttributeNames: { "#scope": "scope" },
      ExpressionAttributeValues: { ":scope": PULSE_SCOPE },
      ScanIndexForward: false,
      Limit: 1
    })
  );
  return ((response.Items ?? []) as PulseSnapshotLite[])[0];
}

/** Keep the four focuses in canonical order, dropping any stray entries from the model. */
function orderRegions(regions: FinancialPolicyRegion[]): FinancialPolicyRegion[] {
  const byFocus = new Map<string, FinancialPolicyRegion>();
  for (const region of regions) byFocus.set(region.region, region);
  return FOCUSES.map((focus) => byFocus.get(focus)).filter((row): row is FinancialPolicyRegion => Boolean(row));
}

async function persist(payload: FinancialPolicy): Promise<void> {
  await documentClient.send(
    new PutCommand({
      TableName: Resource.FinancialPolicyCache.name,
      Item: payload
    })
  );
  await trim();
}

async function trim(): Promise<void> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.FinancialPolicyCache.name,
      KeyConditionExpression: "#scope = :scope",
      ExpressionAttributeNames: { "#scope": "scope" },
      ExpressionAttributeValues: { ":scope": SCOPE },
      ScanIndexForward: true,
      Limit: RETENTION + 50
    })
  );
  const items = (response.Items ?? []) as FinancialPolicy[];
  if (items.length <= RETENTION) return;
  const toDelete = items.slice(0, items.length - RETENTION);
  for (const item of toDelete) {
    await documentClient.send(
      new DeleteCommand({
        TableName: Resource.FinancialPolicyCache.name,
        Key: { scope: item.scope, generatedAt: item.generatedAt }
      })
    );
  }
}
