import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { publishEvent } from "./events";
import { error, json, nowIso, requireBearerToken, requireSecretHeader } from "./http";
import { fetchMarketData, type MarketDataSnapshot } from "./marketData";

const PULSE_REGION_UPDATED = "PULSE_REGION_UPDATED";
const PULSE_REGION_STALE = "PULSE_REGION_STALE";
const PULSE_SNAPSHOT_TAKEN = "PULSE_SNAPSHOT_TAKEN";
const MAX_LINKS_PER_REGION = 15;
const STALE_AFTER_MS = 4 * 60 * 60 * 1000;
const SNAPSHOT_RETENTION = 100;
const SNAPSHOT_SCOPE = "global";
const MARKET_DATA_TTL_MS = 60 * 60 * 1000;

export type PulseStatus = "calm" | "watch" | "elevated" | "critical";

export type PulseLink = {
  title: string;
  url: string;
  site?: string;
  publishedAt?: string;
  sentiment?: number;
  themes: string[];
};

export type PulseRow = {
  region: string;
  status: PulseStatus;
  criticality: number;
  severity: number;
  articleCount: number;
  topThemes: string[];
  summary: string;
  links: PulseLink[];
  windowStart: string;
  windowEnd: string;
  updatedAt: string;
  lastNewsAt?: string;
  stale?: boolean;
  staleSince?: string;
};

type NewsArticle = {
  title?: string;
  text?: string;
  content?: string;
  site?: string;
  url?: string;
  publishedDate?: string;
};

export type PulseOverall = {
  status: PulseStatus;
  score: number;
  regionCount: number;
  hotRegions: string[];
  topThemes: string[];
  summary: string;
};

export type PulseSnapshot = {
  scope: typeof SNAPSHOT_SCOPE;
  snapshotAt: string;
  overall: PulseOverall;
  regions: PulseRow[];
  marketData: MarketDataSnapshot;
};

export type PulseRunResult = {
  regionsTouched: number;
  regionsMarkedStale: number;
  articles: number;
  windowStart: string;
  windowEnd: string;
  snapshot: PulseSnapshot;
};

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function pullPulse(): Promise<PulseRunResult> {
  const startedAt = Date.now();
  console.log("pulse.start", { at: new Date(startedAt).toISOString() });
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    throw new Error("FMP_API_KEY is not configured.");
  }

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 20 * 60 * 1000);

  const articles = await fetchRecentNews(apiKey);
  console.log("pulse.news_fetched", { total: articles.length });
  const recent = articles.filter((article) => {
    if (!article.publishedDate) {
      return true;
    }
    const ts = Date.parse(article.publishedDate);
    return Number.isFinite(ts) && ts >= windowStart.getTime();
  });

  const byRegion = new Map<string, { article: NewsArticle; themes: string[]; sentiment: number }[]>();
  for (const article of recent) {
    const text = `${article.title ?? ""} ${article.text ?? article.content ?? ""}`;
    const regions = extractRegions(text);
    if (regions.length === 0) {
      continue;
    }
    const themes = extractThemes(text);
    const sentiment = scoreSentiment(text);
    for (const region of regions) {
      const bucket = byRegion.get(region) ?? [];
      bucket.push({ article, themes, sentiment });
      byRegion.set(region, bucket);
    }
  }

  const updatedAt = nowIso();
  const freshRegions = new Set(byRegion.keys());
  const allRows = await scanAllRows();
  const previousByRegion = new Map(allRows.map((row) => [row.region, row]));

  let regionsTouched = 0;
  for (const [region, entries] of byRegion.entries()) {
    const row = buildRow(region, entries, windowStart.toISOString(), windowEnd.toISOString(), updatedAt);
    await documentClient.send(
      new PutCommand({
        TableName: Resource.MarketPulse.name,
        Item: row
      })
    );
    regionsTouched += 1;

    const previous = previousByRegion.get(region);
    if (!previous || previous.status !== row.status || previous.stale) {
      await publishEvent(PULSE_REGION_UPDATED, {
        action: PULSE_REGION_UPDATED,
        region,
        previousStatus: previous?.status ?? null,
        status: row.status,
        criticality: row.criticality,
        severity: row.severity,
        articleCount: row.articleCount,
        summary: row.summary
      });
    }
  }

  let regionsMarkedStale = 0;
  for (const row of allRows) {
    if (freshRegions.has(row.region) || row.stale) {
      continue;
    }
    const lastNewsTs = row.lastNewsAt ? Date.parse(row.lastNewsAt) : Date.parse(row.updatedAt);
    if (!Number.isFinite(lastNewsTs)) {
      continue;
    }
    if (windowEnd.getTime() - lastNewsTs < STALE_AFTER_MS) {
      continue;
    }
    const stalenessSince = nowIso();
    await documentClient.send(
      new PutCommand({
        TableName: Resource.MarketPulse.name,
        Item: {
          ...row,
          stale: true,
          staleSince: stalenessSince,
          summary: `${row.region} stale — no fresh news for ${Math.round((windowEnd.getTime() - lastNewsTs) / 3_600_000)}h.`,
          updatedAt: stalenessSince
        }
      })
    );
    regionsMarkedStale += 1;
    await publishEvent(PULSE_REGION_STALE, {
      action: PULSE_REGION_STALE,
      region: row.region,
      lastNewsAt: row.lastNewsAt ?? row.updatedAt,
      hoursSinceLastNews: Math.round((windowEnd.getTime() - lastNewsTs) / 3_600_000)
    });
  }

  const previousSnapshot = await fetchLatestSnapshot();
  const marketData = await getMarketDataWithCache(apiKey, previousSnapshot);
  const regionsAfterRun = await scanAllRows();
  const overall = computeOverall(regionsAfterRun);
  const snapshot: PulseSnapshot = {
    scope: SNAPSHOT_SCOPE,
    snapshotAt: updatedAt,
    overall,
    regions: regionsAfterRun.sort((first, second) => second.criticality - first.criticality),
    marketData
  };

  await persistSnapshot(snapshot);

  const result: PulseRunResult = {
    regionsTouched,
    regionsMarkedStale,
    articles: recent.length,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    snapshot
  };

  console.log("pulse.done", {
    durationMs: Date.now() - startedAt,
    regionsTouched,
    regionsMarkedStale,
    articles: recent.length,
    overall: overall.status,
    score: overall.score,
    hotRegions: overall.hotRegions,
    vix: marketData.vix?.value ?? null,
    marketDataAge: cached(marketData, previousSnapshot)
  });

  return result;
}

function cached(current: MarketDataSnapshot, previous: PulseSnapshot | undefined): string {
  if (!previous) return "fresh";
  return current.fetchedAt === previous.marketData.fetchedAt ? "cached" : "fresh";
}

async function fetchMarketDataSafely(apiKey: string): Promise<MarketDataSnapshot> {
  try {
    return await fetchMarketData(apiKey);
  } catch (cause) {
    console.error("fetchMarketData failed", { cause });
    return {
      vix: null,
      oil: null,
      gold: null,
      dxy: null,
      fx: [],
      sectors: [],
      sectorRotation: { leading: [], lagging: [], summary: "Market data unavailable." },
      fetchedAt: new Date().toISOString()
    };
  }
}

async function getMarketDataWithCache(
  apiKey: string,
  previous: PulseSnapshot | undefined
): Promise<MarketDataSnapshot> {
  const cached = previous?.marketData;
  if (cached?.fetchedAt) {
    const ageMs = Date.now() - Date.parse(cached.fetchedAt);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < MARKET_DATA_TTL_MS) {
      return cached;
    }
  }
  return fetchMarketDataSafely(apiKey);
}

function computeOverall(regions: PulseRow[]): PulseOverall {
  const active = regions.filter((row) => !row.stale);
  if (active.length === 0) {
    return {
      status: "calm",
      score: 0,
      regionCount: 0,
      hotRegions: [],
      topThemes: [],
      summary: "No active regions."
    };
  }
  const score = Math.round(
    active.reduce((sum, row) => sum + Math.max(row.criticality, row.severity), 0) / active.length
  );
  const hotRegions = active
    .filter((row) => row.status === "elevated" || row.status === "critical")
    .map((row) => row.region)
    .slice(0, 5);
  const themeCounts = new Map<string, number>();
  for (const row of active) {
    for (const theme of row.topThemes) {
      themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
    }
  }
  const topThemes = [...themeCounts.entries()]
    .sort((first, second) => second[1] - first[1])
    .slice(0, 5)
    .map(([theme]) => theme);
  const status = bandFromOverall(score, hotRegions.length);
  return {
    status,
    score,
    regionCount: active.length,
    hotRegions,
    topThemes,
    summary: buildOverallSummary(status, active.length, hotRegions, topThemes)
  };
}

function bandFromOverall(score: number, hotCount: number): PulseStatus {
  if (score >= 70 || hotCount >= 4) return "critical";
  if (score >= 50 || hotCount >= 2) return "elevated";
  if (score >= 25) return "watch";
  return "calm";
}

function buildOverallSummary(
  status: PulseStatus,
  regionCount: number,
  hotRegions: string[],
  topThemes: string[]
): string {
  const hotPart = hotRegions.length > 0 ? `, hot: ${hotRegions.join(", ")}` : "";
  const themesPart = topThemes.length > 0 ? `, themes: ${topThemes.join(", ")}` : "";
  return `Overall ${status} across ${regionCount} region${regionCount === 1 ? "" : "s"}${hotPart}${themesPart}.`;
}

async function persistSnapshot(snapshot: PulseSnapshot): Promise<void> {
  await documentClient.send(
    new PutCommand({
      TableName: Resource.MarketPulseSnapshot.name,
      Item: snapshot
    })
  );
  await trimSnapshots();
  const previous = await fetchPreviousSnapshot(snapshot.snapshotAt);
  if (!previous || previous.overall.status !== snapshot.overall.status) {
    await publishEvent(PULSE_SNAPSHOT_TAKEN, {
      action: PULSE_SNAPSHOT_TAKEN,
      previousStatus: previous?.overall.status ?? null,
      status: snapshot.overall.status,
      score: snapshot.overall.score,
      hotRegions: snapshot.overall.hotRegions,
      vix: snapshot.marketData.vix?.value ?? null,
      summary: snapshot.overall.summary
    });
  }
}

async function trimSnapshots(): Promise<void> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.MarketPulseSnapshot.name,
      KeyConditionExpression: "#scope = :scope",
      ExpressionAttributeNames: { "#scope": "scope" },
      ExpressionAttributeValues: { ":scope": SNAPSHOT_SCOPE },
      ScanIndexForward: true,
      Limit: SNAPSHOT_RETENTION + 50
    })
  );
  const items = (response.Items ?? []) as PulseSnapshot[];
  if (items.length <= SNAPSHOT_RETENTION) return;
  const toDelete = items.slice(0, items.length - SNAPSHOT_RETENTION);
  for (const item of toDelete) {
    await documentClient.send(
      new DeleteCommand({
        TableName: Resource.MarketPulseSnapshot.name,
        Key: { scope: item.scope, snapshotAt: item.snapshotAt }
      })
    );
  }
}

async function fetchLatestSnapshot(): Promise<PulseSnapshot | undefined> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.MarketPulseSnapshot.name,
      KeyConditionExpression: "#scope = :scope",
      ExpressionAttributeNames: { "#scope": "scope" },
      ExpressionAttributeValues: { ":scope": SNAPSHOT_SCOPE },
      ScanIndexForward: false,
      Limit: 1
    })
  );
  return ((response.Items ?? []) as PulseSnapshot[])[0];
}

async function fetchPreviousSnapshot(excludingKey: string): Promise<PulseSnapshot | undefined> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.MarketPulseSnapshot.name,
      KeyConditionExpression: "#scope = :scope",
      ExpressionAttributeNames: { "#scope": "scope" },
      ExpressionAttributeValues: { ":scope": SNAPSHOT_SCOPE },
      ScanIndexForward: false,
      Limit: 2
    })
  );
  const rows = (response.Items ?? []) as PulseSnapshot[];
  return rows.find((row) => row.snapshotAt !== excludingKey);
}

export async function refresh(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireSecretHeader(event, "x-refresh-token", "PULSE_REFRESH_TOKEN");
  if (unauthorized) {
    return unauthorized;
  }
  try {
    const result = await pullPulse();
    return json({ run: result }, 201);
  } catch (cause) {
    console.error("Forced pulse refresh failed", { cause });
    return error("Pulse refresh failed.", 500);
  }
}

export async function snapshot(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }
  const latest = await fetchLatestSnapshot();
  if (!latest) {
    return json({ snapshot: null });
  }
  return json({ snapshot: latest });
}

export async function history(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }
  const limitParam = Number(event.queryStringParameters?.limit ?? SNAPSHOT_RETENTION);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.trunc(limitParam), 1), SNAPSHOT_RETENTION)
    : SNAPSHOT_RETENTION;
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.MarketPulseSnapshot.name,
      KeyConditionExpression: "#scope = :scope",
      ExpressionAttributeNames: { "#scope": "scope" },
      ExpressionAttributeValues: { ":scope": SNAPSHOT_SCOPE },
      ScanIndexForward: false,
      Limit: limit
    })
  );
  const snapshots = (response.Items ?? []) as PulseSnapshot[];
  return json({ count: snapshots.length, snapshots });
}

export async function scanAllPulse(): Promise<PulseRow[]> {
  return scanAllRows();
}

async function scanAllRows(): Promise<PulseRow[]> {
  const rows: PulseRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: Resource.MarketPulse.name,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    rows.push(...((response.Items ?? []) as PulseRow[]));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rows;
}

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }
  const rows: PulseRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: Resource.MarketPulse.name,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    rows.push(...((response.Items ?? []) as PulseRow[]));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);

  rows.sort((first, second) => second.criticality - first.criticality);
  return json({ count: rows.length, regions: rows });
}

export async function get(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }
  const region = String(event.pathParameters?.region ?? "").trim();
  if (!region) {
    return error("Missing region.");
  }
  const response = await documentClient.send(
    new GetCommand({
      TableName: Resource.MarketPulse.name,
      Key: { region }
    })
  );
  if (!response.Item) {
    return error("Region not found.", 404);
  }
  return json({ region: response.Item });
}

async function fetchRecentNews(apiKey: string): Promise<NewsArticle[]> {
  const endpoints = [
    `https://financialmodelingprep.com/api/v3/stock_news?limit=100&apikey=${encodeURIComponent(apiKey)}`,
    `https://financialmodelingprep.com/api/v4/general_news?page=0&size=100&apikey=${encodeURIComponent(apiKey)}`
  ];

  const results = await Promise.all(
    endpoints.map(async (url) => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.error("FMP news request failed", { url, status: response.status });
          return [];
        }
        const data = (await response.json()) as unknown;
        return Array.isArray(data) ? (data as NewsArticle[]) : [];
      } catch (cause) {
        console.error("FMP news request errored", { cause });
        return [];
      }
    })
  );

  return dedupe(results.flat());
}

function dedupe(articles: NewsArticle[]): NewsArticle[] {
  const seen = new Set<string>();
  const out: NewsArticle[] = [];
  for (const article of articles) {
    const key = article.url ?? article.title;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(article);
  }
  return out;
}

function buildRow(
  region: string,
  entries: { article: NewsArticle; themes: string[]; sentiment: number }[],
  windowStart: string,
  windowEnd: string,
  updatedAt: string
): PulseRow {
  const themeTotals = new Map<string, number>();
  let severitySum = 0;
  let criticalitySum = 0;
  for (const { themes, sentiment } of entries) {
    for (const theme of themes) {
      themeTotals.set(theme, (themeTotals.get(theme) ?? 0) + THEME_WEIGHTS[theme].severity);
      severitySum += THEME_WEIGHTS[theme].severity;
      criticalitySum += THEME_WEIGHTS[theme].criticality;
    }
    severitySum -= sentiment;
    criticalitySum -= sentiment;
  }
  const reachBoost = Math.min(20, Math.log2(entries.length + 1) * 6);
  const criticality = clamp(criticalitySum + reachBoost);
  const severity = clamp(severitySum);
  const status = bandFromScore(Math.max(criticality, severity));

  const topThemes = [...themeTotals.entries()]
    .sort((first, second) => second[1] - first[1])
    .slice(0, 5)
    .map(([theme]) => theme);

  const links: PulseLink[] = entries
    .map(({ article, themes, sentiment }) => ({
      title: article.title ?? "",
      url: article.url ?? "",
      site: article.site,
      publishedAt: article.publishedDate,
      sentiment,
      themes
    }))
    .filter((link) => link.title && link.url)
    .sort((first, second) => Date.parse(second.publishedAt ?? "") - Date.parse(first.publishedAt ?? ""))
    .slice(0, MAX_LINKS_PER_REGION);

  const lastNewsAt = links.find((link) => link.publishedAt)?.publishedAt ?? updatedAt;

  return {
    region,
    status,
    criticality,
    severity,
    articleCount: entries.length,
    topThemes,
    summary: buildSummary(region, status, topThemes, entries.length),
    links,
    windowStart,
    windowEnd,
    updatedAt,
    lastNewsAt,
    stale: false
  };
}

function buildSummary(region: string, status: PulseStatus, themes: string[], count: number): string {
  if (count === 0) {
    return `No fresh signal for ${region}.`;
  }
  const themesPart = themes.length > 0 ? `themes: ${themes.join(", ")}` : "no dominant theme";
  return `${region} ${status} — ${count} article${count === 1 ? "" : "s"} in window, ${themesPart}.`;
}

function bandFromScore(score: number): PulseStatus {
  if (score >= 70) return "critical";
  if (score >= 50) return "elevated";
  if (score >= 25) return "watch";
  return "calm";
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

const THEME_WEIGHTS: Record<string, { severity: number; criticality: number }> = {
  war: { severity: 35, criticality: 30 },
  invasion: { severity: 35, criticality: 30 },
  missile_strike: { severity: 30, criticality: 25 },
  conflict: { severity: 25, criticality: 20 },
  sanctions: { severity: 20, criticality: 25 },
  embargo: { severity: 20, criticality: 20 },
  default: { severity: 25, criticality: 30 },
  bankruptcy: { severity: 20, criticality: 15 },
  recession: { severity: 20, criticality: 25 },
  inflation: { severity: 15, criticality: 20 },
  rate_hike: { severity: 12, criticality: 20 },
  rate_cut: { severity: 10, criticality: 15 },
  central_bank: { severity: 10, criticality: 15 },
  election: { severity: 15, criticality: 10 },
  coup: { severity: 25, criticality: 20 },
  protest: { severity: 10, criticality: 8 },
  trade_war: { severity: 20, criticality: 25 },
  tariff: { severity: 15, criticality: 18 },
  cyberattack: { severity: 25, criticality: 20 },
  energy_shock: { severity: 25, criticality: 25 },
  natural_disaster: { severity: 20, criticality: 15 }
};

const THEME_KEYWORDS: Record<string, string[]> = {
  war: ["war", " warfare"],
  invasion: ["invasion", "invaded", "invades"],
  missile_strike: ["missile", "drone strike", "airstrike", "missile strike"],
  conflict: ["conflict", "clash", "skirmish", "battle"],
  sanctions: ["sanction", "sanctions"],
  embargo: ["embargo"],
  default: ["sovereign default", "debt default", "defaults on", "missed payment"],
  bankruptcy: ["bankruptcy", "files for chapter 11", "insolvency"],
  recession: ["recession", "contraction", "stagflation"],
  inflation: ["inflation", "cpi", "ppi rises", "price surge"],
  rate_hike: ["rate hike", "raises rates", "hikes rates", "tightening"],
  rate_cut: ["rate cut", "cuts rates", "easing cycle"],
  central_bank: ["federal reserve", "fed ", "ecb", "boj", "pboc", "bank of england", "central bank"],
  election: ["election", "vote ", "ballot"],
  coup: ["coup ", "military takeover", "ousted"],
  protest: ["protest", "riot", "demonstration"],
  trade_war: ["trade war", "trade tensions"],
  tariff: ["tariff", "duties on imports"],
  cyberattack: ["cyberattack", "ransomware", "data breach"],
  energy_shock: ["oil shock", "gas shortage", "energy crisis", "opec cut"],
  natural_disaster: ["earthquake", "hurricane", "tsunami", "flood", "wildfire"]
};

const NEGATIVE_HINTS = ["plunge", "slump", "crash", "loss", "warning", "downgrade", "miss", "weak", "fear"];
const POSITIVE_HINTS = ["rally", "surge", "gain", "beat", "upgrade", "growth", "record high", "strong"];

function extractThemes(text: string): string[] {
  const haystack = text.toLowerCase();
  const matched: string[] = [];
  for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      matched.push(theme);
    }
  }
  return matched;
}

function scoreSentiment(text: string): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const word of POSITIVE_HINTS) {
    if (haystack.includes(word)) score += 3;
  }
  for (const word of NEGATIVE_HINTS) {
    if (haystack.includes(word)) score -= 3;
  }
  return score;
}

const REGION_ALIASES: Record<string, string[]> = {
  "United States": ["united states", "u.s.", " us ", "usa", "america", "washington", "wall street"],
  "European Union": ["european union", " eu ", "eurozone", "euro area", "brussels"],
  "United Kingdom": ["united kingdom", "britain", " uk ", "london"],
  Germany: ["germany", "german ", "berlin", "frankfurt"],
  France: ["france", "french ", "paris"],
  Italy: ["italy", "italian ", "rome", "milan"],
  Spain: ["spain", "spanish ", "madrid"],
  China: ["china", "chinese ", "beijing", "shanghai", "shenzhen", "pboc"],
  "Hong Kong": ["hong kong", "hkex"],
  Taiwan: ["taiwan", "taipei"],
  Japan: ["japan", "japanese ", "tokyo", "boj"],
  "South Korea": ["south korea", "korean ", "seoul"],
  India: ["india", "indian ", "mumbai", "new delhi"],
  Russia: ["russia", "russian ", "moscow", "kremlin"],
  Ukraine: ["ukraine", "ukrainian ", "kyiv", "kiev"],
  Israel: ["israel", "israeli ", "tel aviv", "jerusalem"],
  "Saudi Arabia": ["saudi arabia", "saudi ", "riyadh"],
  Iran: ["iran", "iranian ", "tehran"],
  Turkey: ["turkey", "turkish ", "ankara", "istanbul"],
  Brazil: ["brazil", "brazilian ", "brasilia", "sao paulo"],
  Mexico: ["mexico", "mexican ", "mexico city"],
  Canada: ["canada", "canadian ", "ottawa", "toronto"],
  Australia: ["australia", "australian ", "sydney", "canberra"],
  Argentina: ["argentina", "argentine ", "buenos aires"],
  "South Africa": ["south africa", "johannesburg", "pretoria"],
  Nigeria: ["nigeria", "lagos", "abuja"],
  "Middle East": ["middle east", "gulf states", "opec"],
  "Latin America": ["latin america", "latam"],
  "Asia Pacific": ["asia pacific", "apac", "asia-pacific"]
};

function extractRegions(text: string): string[] {
  const haystack = ` ${text.toLowerCase()} `;
  const matched = new Set<string>();
  for (const [region, aliases] of Object.entries(REGION_ALIASES)) {
    if (aliases.some((alias) => haystack.includes(alias))) {
      matched.add(region);
    }
  }
  return [...matched];
}
