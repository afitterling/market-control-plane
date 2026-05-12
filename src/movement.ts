import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { cleanSymbol, error, json, nowIso, requireBearerToken } from "./http";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PULSE_SCOPE = "global";
const ALIGNMENT_SCOPE = "global";
const REGIME_PREFIX = "regime#";

export type MovementInterval = "1h" | "4h" | "1d" | "1w";
type RegimeScale = "intraday" | "daily" | "weekly" | "monthly" | "quarterly";
type RegimeClassification = "risk_off" | "bearish" | "neutral" | "bullish" | "risk_on";
type PulseStatus = "calm" | "watch" | "elevated" | "critical";
type RiskState = "risk-on" | "risk-off" | "neutral";
type CompositeRiskLevel = "low" | "medium" | "high" | "extreme";
type Direction = "up" | "down" | "flat" | "unknown";
type ReferenceSource = "open" | "previous-close" | "historical-close" | "intraday-change" | "unknown";
type ExpectedBias = "up" | "down" | "neutral";
type AlignmentInterpretation = "with-tape" | "against-tape" | "neutral" | "no-data";

const SUPPORTED_INTERVALS: MovementInterval[] = ["1h", "4h", "1d", "1w"];

const INTERVAL_MS: Record<MovementInterval, number> = {
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000
};

const INTERVAL_SCALE: Record<MovementInterval, RegimeScale> = {
  "1h": "intraday",
  "4h": "intraday",
  "1d": "daily",
  "1w": "weekly"
};

const INTERVAL_TRADING_DAYS_BACK: Record<MovementInterval, number> = {
  "1h": 0,
  "4h": 0,
  "1d": 1,
  "1w": 5
};

const PAST_ALIGNMENT_LIMIT = 8;
const PAST_REGIME_LIMIT = 12;
const PULSE_HISTORY_LIMIT = 100;
const HEADLINE_LIMIT = 8;
const IN_WINDOW_THEME_LIMIT = 8;

const POSITIVE_HINTS = ["rally", "surge", "gain", "beat", "upgrade", "growth", "record high", "strong"];
const NEGATIVE_HINTS = ["plunge", "slump", "crash", "loss", "warning", "downgrade", "miss", "weak", "fear"];

type HistoricalClose = { date: string; close: number };

type StockReturns = {
  d1?: number;
  d7?: number;
  m1?: number;
  m3?: number;
  m6?: number;
  y1?: number;
  y2?: number;
  asOf?: string;
};

type StockRow = {
  symbol: string;
  name?: string;
  sector?: string;
  industry?: string;
  exchange?: string;
  currency?: string;
  price?: number;
  priceAsOf?: string;
  priceUpdatedAt?: string;
  openPrice?: number | null;
  previousClose?: number | null;
  dailyChange?: number | null;
  dailyChangePercent?: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
  returns?: StockReturns;
  historicalCloses?: HistoricalClose[];
  fundamentals?: { eps?: number; epsTtm?: number; peRatio?: number; marketCap?: number; beta?: number };
  margins?: { grossMargin?: number; operatingMargin?: number; netMargin?: number; ebitdaMargin?: number };
};

type PulseLink = {
  title?: string;
  url?: string;
  site?: string;
  publishedAt?: string;
  sentiment?: number;
  themes?: string[];
};

type PulseRegionRow = {
  region: string;
  status: PulseStatus;
  criticality: number;
  severity: number;
  topThemes?: string[];
  links?: PulseLink[];
  summary?: string;
  stale?: boolean;
  updatedAt?: string;
};

type PulseSnapshot = {
  scope: string;
  snapshotAt: string;
  riskState?: RiskState;
  overall?: {
    status?: PulseStatus;
    score?: number;
    hotRegions?: string[];
    topThemes?: string[];
    summary?: string;
  };
  regions?: PulseRegionRow[];
  marketData?: {
    vix?: { value?: number; changePercent?: number; status?: string } | null;
    sectors?: Array<{ symbol: string; name: string; changePercent: number; momentum: "leading" | "lagging" | "neutral" }>;
    rotation?: { leader1m?: { bucket: string; returnPct: number } | null; riskOnBreadth?: string } | null;
  };
};

type RegimeRow = {
  scale: RegimeScale;
  date: string;
  kind: "regime";
  classification: RegimeClassification;
  score: number;
  itemCount: number;
  topThemes: string[];
  summary: string;
  computedAt: string;
};

type AlignmentRow = {
  scope: string;
  alignedAt: string;
  regimes: Array<{
    scale: RegimeScale;
    classification: RegimeClassification;
    score: number;
    topThemes: string[];
    summary: string;
  }>;
  composite: {
    riskLevel: CompositeRiskLevel;
    bias: RegimeClassification;
    biasScore: number;
    pulseRiskScore: number;
    hotRegions: string[];
    summary: string;
  };
};

type MovementBlock = {
  referencePrice: number | null;
  referenceAt: string | null;
  currentPrice: number | null;
  currentAt: string | null;
  changePct: number | null;
  direction: Direction;
  referenceSource: ReferenceSource;
  bars: Array<{ date: string; close: number; changePct: number | null }>;
};

type RegimeBlock = {
  scale: RegimeScale;
  classification: RegimeClassification | null;
  score: number | null;
  topThemes: string[];
  summary: string | null;
  computedAt: string | null;
};

type PulseBlock = {
  snapshotAt: string | null;
  overallStatus: PulseStatus | null;
  overallScore: number | null;
  riskState: RiskState | null;
  hotRegions: string[];
  topThemes: string[];
  inWindowSnapshots: number;
  inWindowThemes: Array<{ theme: string; count: number }>;
  vix: { value: number | null; changePercent: number | null; status: string | null };
};

type AlignmentBlock = {
  alignedAt: string | null;
  riskLevel: CompositeRiskLevel | null;
  bias: RegimeClassification | null;
  biasScore: number | null;
  pulseRiskScore: number | null;
  hotRegions: string[];
  interpretation: AlignmentInterpretation;
};

type PredictiveNewsBlock = {
  inWindowSnapshots: number;
  themes: Array<{ theme: string; weight: number; signal: "positive" | "negative" | "neutral" }>;
  headlines: Array<{ title: string; url: string; site?: string; publishedAt?: string; sentiment?: number; themes: string[] }>;
  netSentiment: number;
  expectedBias: ExpectedBias;
  rationale: string;
};

type PastRecordsBlock = {
  priorWindowChangePct: number | null;
  priorWindowSummary: string | null;
  alignmentHistory: Array<{
    alignedAt: string;
    bias: RegimeClassification;
    riskLevel: CompositeRiskLevel;
    biasScore: number;
    pulseRiskScore: number;
    hotRegions: string[];
  }>;
  regimeHistory: Array<{
    computedAt: string;
    classification: RegimeClassification;
    score: number;
    topThemes: string[];
  }>;
  stockReturns: StockReturns | null;
};

type MovementNarrative = {
  symbol: string;
  name?: string;
  sector?: string;
  industry?: string;
  interval: MovementInterval;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  movement: MovementBlock;
  regime: RegimeBlock;
  pulse: PulseBlock;
  alignment: AlignmentBlock;
  predictiveNews: PredictiveNewsBlock;
  pastRecords: PastRecordsBlock;
  drivers: string[];
  summary: string;
};

export async function movement(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) return unauthorized;

  const symbol = cleanSymbol(event.pathParameters?.symbol);
  if (!symbol) return error("Missing stock symbol.");

  const intervalRaw = String(event.pathParameters?.interval ?? "").trim().toLowerCase();
  if (!SUPPORTED_INTERVALS.includes(intervalRaw as MovementInterval)) {
    return error(`'interval' must be one of: ${SUPPORTED_INTERVALS.join(", ")}.`);
  }
  const interval = intervalRaw as MovementInterval;

  const stock = await getStock(symbol);
  if (!stock) return error("Stock not found.", 404);

  const now = new Date();
  const windowEnd = now.toISOString();
  const windowStart = new Date(now.getTime() - INTERVAL_MS[interval]).toISOString();

  const [latestSnapshot, snapshotHistory, latestAlignment, alignmentHistory, regimeHistory] = await Promise.all([
    fetchLatestPulseSnapshot(),
    fetchPulseSnapshotHistory(PULSE_HISTORY_LIMIT),
    fetchLatestAlignment(),
    fetchAlignmentHistory(PAST_ALIGNMENT_LIMIT),
    fetchRegimeHistory(INTERVAL_SCALE[interval], PAST_REGIME_LIMIT)
  ]);

  const inWindowSnapshots = snapshotHistory.filter(
    (snap) => snap.snapshotAt >= windowStart && snap.snapshotAt <= windowEnd
  );

  const movementBlock = computeMovement(stock, interval);
  const regimeBlock = buildRegimeBlock(interval, regimeHistory);
  const pulseBlock = buildPulseBlock(latestSnapshot, inWindowSnapshots);
  const alignmentBlock = buildAlignmentBlock(latestAlignment, movementBlock);
  const newsBlock = buildPredictiveNews(inWindowSnapshots, latestSnapshot);
  const pastBlock = buildPastRecords(alignmentHistory, regimeHistory, stock, interval);

  const drivers = buildDrivers(movementBlock, regimeBlock, pulseBlock, alignmentBlock, newsBlock);
  const summary = buildSummary(symbol, stock, interval, movementBlock, regimeBlock, alignmentBlock, newsBlock, pastBlock);

  const payload: MovementNarrative = {
    symbol,
    name: stock.name,
    sector: stock.sector,
    industry: stock.industry,
    interval,
    windowStart,
    windowEnd,
    generatedAt: nowIso(),
    movement: movementBlock,
    regime: regimeBlock,
    pulse: pulseBlock,
    alignment: alignmentBlock,
    predictiveNews: newsBlock,
    pastRecords: pastBlock,
    drivers,
    summary
  };

  return json({ movement: payload });
}

async function getStock(symbol: string): Promise<StockRow | undefined> {
  const response = await documentClient.send(
    new GetCommand({ TableName: Resource.Stocks.name, Key: { symbol } })
  );
  return response.Item as StockRow | undefined;
}

async function fetchLatestPulseSnapshot(): Promise<PulseSnapshot | undefined> {
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
  return ((response.Items ?? []) as PulseSnapshot[])[0];
}

async function fetchPulseSnapshotHistory(limit: number): Promise<PulseSnapshot[]> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.MarketPulseSnapshot.name,
      KeyConditionExpression: "#scope = :scope",
      ExpressionAttributeNames: { "#scope": "scope" },
      ExpressionAttributeValues: { ":scope": PULSE_SCOPE },
      ScanIndexForward: false,
      Limit: limit
    })
  );
  return (response.Items ?? []) as PulseSnapshot[];
}

async function fetchLatestAlignment(): Promise<AlignmentRow | undefined> {
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
  return ((response.Items ?? []) as AlignmentRow[])[0];
}

async function fetchAlignmentHistory(limit: number): Promise<AlignmentRow[]> {
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
  return (response.Items ?? []) as AlignmentRow[];
}

async function fetchRegimeHistory(scale: RegimeScale, limit: number): Promise<RegimeRow[]> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.MarketRegime.name,
      KeyConditionExpression: "#scale = :scale AND begins_with(#date, :prefix)",
      ExpressionAttributeNames: { "#scale": "scale", "#date": "date" },
      ExpressionAttributeValues: { ":scale": scale, ":prefix": REGIME_PREFIX },
      ScanIndexForward: false,
      Limit: limit
    })
  );
  return ((response.Items ?? []) as RegimeRow[]).filter((row) => row.kind === "regime");
}

function computeMovement(stock: StockRow, interval: MovementInterval): MovementBlock {
  const sortedHistory = [...(stock.historicalCloses ?? [])].sort((first, second) =>
    second.date.localeCompare(first.date)
  );
  const currentPrice = numericOrNull(stock.price);
  const currentAt = stock.priceUpdatedAt ?? stock.priceAsOf ?? null;

  if (interval === "1h" || interval === "4h") {
    if (typeof stock.dailyChangePercent === "number" && Number.isFinite(stock.dailyChangePercent)) {
      const previousClose = numericOrNull(stock.previousClose);
      const reference = previousClose ?? (typeof stock.openPrice === "number" ? stock.openPrice : null);
      return {
        referencePrice: reference,
        referenceAt: null,
        currentPrice,
        currentAt,
        changePct: round2(stock.dailyChangePercent),
        direction: directionFrom(stock.dailyChangePercent),
        referenceSource: previousClose !== null ? "previous-close" : reference !== null ? "open" : "intraday-change",
        bars: buildIntradayBars(stock)
      };
    }
    return {
      referencePrice: null,
      referenceAt: null,
      currentPrice,
      currentAt,
      changePct: null,
      direction: "unknown",
      referenceSource: "unknown",
      bars: buildIntradayBars(stock)
    };
  }

  const tradingDaysBack = INTERVAL_TRADING_DAYS_BACK[interval];
  const referenceBar = sortedHistory[tradingDaysBack];
  const latestBar = sortedHistory[0];
  if (!referenceBar || !latestBar || !Number.isFinite(referenceBar.close) || referenceBar.close <= 0) {
    return {
      referencePrice: null,
      referenceAt: null,
      currentPrice,
      currentAt,
      changePct: null,
      direction: "unknown",
      referenceSource: "unknown",
      bars: buildDailyBars(sortedHistory, tradingDaysBack + 1)
    };
  }
  const last = currentPrice ?? latestBar.close;
  const changePct = round2(((last - referenceBar.close) / referenceBar.close) * 100);
  return {
    referencePrice: referenceBar.close,
    referenceAt: referenceBar.date,
    currentPrice: last,
    currentAt: currentAt ?? latestBar.date,
    changePct,
    direction: directionFrom(changePct),
    referenceSource: "historical-close",
    bars: buildDailyBars(sortedHistory, tradingDaysBack + 1)
  };
}

function buildIntradayBars(stock: StockRow): MovementBlock["bars"] {
  const out: MovementBlock["bars"] = [];
  if (typeof stock.previousClose === "number") {
    out.push({ date: "previous-close", close: round4(stock.previousClose), changePct: null });
  }
  if (typeof stock.openPrice === "number") {
    const ref = stock.previousClose;
    const pct = typeof ref === "number" && ref > 0 ? round2(((stock.openPrice - ref) / ref) * 100) : null;
    out.push({ date: "open", close: round4(stock.openPrice), changePct: pct });
  }
  if (typeof stock.price === "number") {
    const ref = typeof stock.openPrice === "number" ? stock.openPrice : stock.previousClose;
    const pct = typeof ref === "number" && ref > 0 ? round2(((stock.price - ref) / ref) * 100) : null;
    out.push({ date: stock.priceUpdatedAt ?? stock.priceAsOf ?? "now", close: round4(stock.price), changePct: pct });
  }
  return out;
}

function buildDailyBars(sortedHistoryDesc: HistoricalClose[], window: number): MovementBlock["bars"] {
  const slice = sortedHistoryDesc.slice(0, Math.max(window, 2)).reverse();
  return slice.map((entry, index) => {
    if (index === 0) return { date: entry.date, close: entry.close, changePct: null };
    const prev = slice[index - 1].close;
    const changePct = prev > 0 ? round2(((entry.close - prev) / prev) * 100) : null;
    return { date: entry.date, close: entry.close, changePct };
  });
}

function buildRegimeBlock(interval: MovementInterval, regimeHistory: RegimeRow[]): RegimeBlock {
  const scale = INTERVAL_SCALE[interval];
  const latest = regimeHistory[0];
  if (!latest) {
    return { scale, classification: null, score: null, topThemes: [], summary: null, computedAt: null };
  }
  return {
    scale,
    classification: latest.classification,
    score: latest.score,
    topThemes: latest.topThemes ?? [],
    summary: latest.summary,
    computedAt: latest.computedAt
  };
}

function buildPulseBlock(latest: PulseSnapshot | undefined, inWindow: PulseSnapshot[]): PulseBlock {
  const themeCounts = new Map<string, number>();
  for (const snap of inWindow) {
    for (const theme of snap.overall?.topThemes ?? []) {
      themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
    }
    for (const region of snap.regions ?? []) {
      for (const theme of region.topThemes ?? []) {
        themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
      }
    }
  }
  const inWindowThemes = [...themeCounts.entries()]
    .sort((first, second) => second[1] - first[1])
    .slice(0, IN_WINDOW_THEME_LIMIT)
    .map(([theme, count]) => ({ theme, count }));

  return {
    snapshotAt: latest?.snapshotAt ?? null,
    overallStatus: latest?.overall?.status ?? null,
    overallScore: latest?.overall?.score ?? null,
    riskState: latest?.riskState ?? null,
    hotRegions: latest?.overall?.hotRegions ?? [],
    topThemes: latest?.overall?.topThemes ?? [],
    inWindowSnapshots: inWindow.length,
    inWindowThemes,
    vix: {
      value: typeof latest?.marketData?.vix?.value === "number" ? latest!.marketData!.vix!.value! : null,
      changePercent: typeof latest?.marketData?.vix?.changePercent === "number" ? latest!.marketData!.vix!.changePercent! : null,
      status: latest?.marketData?.vix?.status ?? null
    }
  };
}

function buildAlignmentBlock(
  latest: AlignmentRow | undefined,
  movementBlock: MovementBlock
): AlignmentBlock {
  if (!latest) {
    return {
      alignedAt: null,
      riskLevel: null,
      bias: null,
      biasScore: null,
      pulseRiskScore: null,
      hotRegions: [],
      interpretation: "no-data"
    };
  }
  const bias = latest.composite.bias;
  const biasDirection = biasDirectionFor(bias);
  let interpretation: AlignmentInterpretation = "neutral";
  if (movementBlock.direction === "unknown" || biasDirection === "neutral") {
    interpretation = biasDirection === "neutral" ? "neutral" : "no-data";
  } else if (movementBlock.direction === biasDirection) {
    interpretation = "with-tape";
  } else {
    interpretation = "against-tape";
  }
  return {
    alignedAt: latest.alignedAt,
    riskLevel: latest.composite.riskLevel,
    bias,
    biasScore: latest.composite.biasScore,
    pulseRiskScore: latest.composite.pulseRiskScore,
    hotRegions: latest.composite.hotRegions ?? [],
    interpretation
  };
}

function buildPredictiveNews(inWindow: PulseSnapshot[], latest: PulseSnapshot | undefined): PredictiveNewsBlock {
  const themeWeights = new Map<string, number>();
  const seenLinks = new Map<string, PulseLink & { snapshotAt: string }>();
  let sentimentTotal = 0;
  let sentimentSamples = 0;

  for (const snap of inWindow) {
    for (const region of snap.regions ?? []) {
      const regionWeight = Math.max(1, Math.round((region.criticality + region.severity) / 20));
      for (const theme of region.topThemes ?? []) {
        themeWeights.set(theme, (themeWeights.get(theme) ?? 0) + regionWeight);
      }
      for (const link of region.links ?? []) {
        if (typeof link.sentiment === "number" && Number.isFinite(link.sentiment)) {
          sentimentTotal += link.sentiment;
          sentimentSamples += 1;
        } else {
          const inferred = inferSentiment(link.title);
          if (inferred !== 0) {
            sentimentTotal += inferred;
            sentimentSamples += 1;
          }
        }
        const key = link.url ?? link.title ?? "";
        if (key && !seenLinks.has(key)) {
          seenLinks.set(key, { ...link, snapshotAt: snap.snapshotAt });
        }
      }
    }
  }

  if (inWindow.length === 0 && latest) {
    for (const region of latest.regions ?? []) {
      for (const link of region.links ?? []) {
        const key = link.url ?? link.title ?? "";
        if (key && !seenLinks.has(key)) {
          seenLinks.set(key, { ...link, snapshotAt: latest.snapshotAt });
        }
      }
    }
  }

  const netSentiment = sentimentSamples > 0 ? round2(sentimentTotal / sentimentSamples) : 0;
  const themes = [...themeWeights.entries()]
    .sort((first, second) => second[1] - first[1])
    .slice(0, IN_WINDOW_THEME_LIMIT)
    .map(([theme, weight]) => ({ theme, weight, signal: themeSignal(theme) }));

  const headlines = [...seenLinks.values()]
    .sort((first, second) => {
      const aDate = first.publishedAt ?? first.snapshotAt;
      const bDate = second.publishedAt ?? second.snapshotAt;
      return bDate.localeCompare(aDate);
    })
    .slice(0, HEADLINE_LIMIT)
    .map((link) => ({
      title: String(link.title ?? ""),
      url: String(link.url ?? ""),
      site: link.site,
      publishedAt: link.publishedAt,
      sentiment: link.sentiment,
      themes: link.themes ?? []
    }))
    .filter((entry) => entry.title && entry.url);

  const themeNegative = themes.filter((entry) => entry.signal === "negative").reduce((sum, entry) => sum + entry.weight, 0);
  const themePositive = themes.filter((entry) => entry.signal === "positive").reduce((sum, entry) => sum + entry.weight, 0);

  const expectedBias = predictBias(netSentiment, themeNegative, themePositive);
  const rationale = buildNewsRationale(themes, netSentiment, expectedBias, inWindow.length);

  return {
    inWindowSnapshots: inWindow.length,
    themes,
    headlines,
    netSentiment,
    expectedBias,
    rationale
  };
}

function buildPastRecords(
  alignments: AlignmentRow[],
  regimes: RegimeRow[],
  stock: StockRow,
  interval: MovementInterval
): PastRecordsBlock {
  const alignmentHistory = alignments.map((row) => ({
    alignedAt: row.alignedAt,
    bias: row.composite.bias,
    riskLevel: row.composite.riskLevel,
    biasScore: row.composite.biasScore,
    pulseRiskScore: row.composite.pulseRiskScore,
    hotRegions: row.composite.hotRegions ?? []
  }));

  const regimeHistory = regimes.map((row) => ({
    computedAt: row.computedAt,
    classification: row.classification,
    score: row.score,
    topThemes: row.topThemes ?? []
  }));

  const sortedHistory = [...(stock.historicalCloses ?? [])].sort((first, second) =>
    second.date.localeCompare(first.date)
  );
  const tradingDaysBack = INTERVAL_TRADING_DAYS_BACK[interval];
  let priorWindowChangePct: number | null = null;
  let priorWindowSummary: string | null = null;
  if (tradingDaysBack > 0) {
    const priorEnd = sortedHistory[tradingDaysBack];
    const priorStart = sortedHistory[tradingDaysBack * 2];
    if (priorEnd && priorStart && priorStart.close > 0) {
      priorWindowChangePct = round2(((priorEnd.close - priorStart.close) / priorStart.close) * 100);
      priorWindowSummary = `Prior ${interval} window (${priorStart.date} → ${priorEnd.date}): ${formatPct(priorWindowChangePct)}.`;
    }
  } else if (typeof stock.returns?.d1 === "number") {
    priorWindowChangePct = stock.returns.d1;
    priorWindowSummary = `Last full session move: ${formatPct(stock.returns.d1)}.`;
  }

  return {
    priorWindowChangePct,
    priorWindowSummary,
    alignmentHistory,
    regimeHistory,
    stockReturns: stock.returns ?? null
  };
}

function buildDrivers(
  movementBlock: MovementBlock,
  regimeBlock: RegimeBlock,
  pulseBlock: PulseBlock,
  alignmentBlock: AlignmentBlock,
  newsBlock: PredictiveNewsBlock
): string[] {
  const drivers: string[] = [];
  if (movementBlock.changePct !== null) {
    const word = movementBlock.changePct >= 0 ? "up" : "down";
    drivers.push(`Stock ${word} ${formatPct(movementBlock.changePct)} via ${movementBlock.referenceSource}`);
  }
  if (regimeBlock.classification) {
    drivers.push(`${regimeBlock.scale} regime ${regimeBlock.classification} (score ${regimeBlock.score ?? 0})`);
  }
  if (alignmentBlock.riskLevel) {
    drivers.push(`Composite risk ${alignmentBlock.riskLevel}, bias ${alignmentBlock.bias} (${alignmentBlock.biasScore ?? 0})`);
  }
  if (pulseBlock.vix.value !== null && pulseBlock.vix.changePercent !== null) {
    drivers.push(`VIX ${pulseBlock.vix.value} (${formatPct(pulseBlock.vix.changePercent)})`);
  }
  if (pulseBlock.hotRegions.length > 0) {
    drivers.push(`Hot regions: ${pulseBlock.hotRegions.join(", ")}`);
  }
  if (newsBlock.themes.length > 0) {
    drivers.push(`Top news themes: ${newsBlock.themes.slice(0, 3).map((entry) => entry.theme).join(", ")}`);
  }
  if (newsBlock.expectedBias !== "neutral") {
    drivers.push(`Predictive news bias: ${newsBlock.expectedBias}`);
  }
  return drivers;
}

function buildSummary(
  symbol: string,
  stock: StockRow,
  interval: MovementInterval,
  movementBlock: MovementBlock,
  regimeBlock: RegimeBlock,
  alignmentBlock: AlignmentBlock,
  newsBlock: PredictiveNewsBlock,
  pastBlock: PastRecordsBlock
): string {
  const label = stock.name ? `${stock.name} (${symbol})` : symbol;
  const parts: string[] = [];

  if (movementBlock.changePct !== null) {
    const dir = movementBlock.changePct >= 0 ? "up" : "down";
    parts.push(`${label} ${dir} ${formatPct(movementBlock.changePct)} over the ${interval} window`);
  } else {
    parts.push(`${label} has no usable price reference for the ${interval} window`);
  }

  if (regimeBlock.classification) {
    parts.push(`${regimeBlock.scale} regime ${regimeBlock.classification} (score ${regimeBlock.score ?? 0})`);
  }

  if (alignmentBlock.bias) {
    const interp =
      alignmentBlock.interpretation === "with-tape"
        ? "moving with the tape"
        : alignmentBlock.interpretation === "against-tape"
          ? "moving against the tape"
          : "tracking the tape";
    parts.push(`composite bias ${alignmentBlock.bias} at ${alignmentBlock.riskLevel} risk, ${interp}`);
  }

  if (newsBlock.expectedBias !== "neutral") {
    parts.push(`predictive news leans ${newsBlock.expectedBias} (net sentiment ${newsBlock.netSentiment})`);
  } else if (newsBlock.themes.length > 0) {
    parts.push(`predictive news neutral with themes ${newsBlock.themes.slice(0, 3).map((entry) => entry.theme).join(", ")}`);
  }

  if (pastBlock.priorWindowSummary) {
    parts.push(pastBlock.priorWindowSummary.replace(/\.$/, ""));
  }

  return parts.join("; ") + ".";
}

function buildNewsRationale(
  themes: PredictiveNewsBlock["themes"],
  netSentiment: number,
  expectedBias: ExpectedBias,
  snapshotCount: number
): string {
  if (snapshotCount === 0 && themes.length === 0) {
    return "No in-window pulse snapshots to derive a predictive read.";
  }
  const topThemes = themes.slice(0, 3).map((entry) => `${entry.theme} (${entry.signal})`).join(", ");
  const themePart = topThemes ? `themes ${topThemes}` : "no dominant themes";
  return `Across ${snapshotCount} pulse snapshot${snapshotCount === 1 ? "" : "s"}, ${themePart}; net sentiment ${netSentiment} ⇒ ${expectedBias}.`;
}

function predictBias(netSentiment: number, themeNegative: number, themePositive: number): ExpectedBias {
  const sentimentBias: ExpectedBias = netSentiment >= 1 ? "up" : netSentiment <= -1 ? "down" : "neutral";
  const themeDelta = themePositive - themeNegative;
  const themeBias: ExpectedBias = themeDelta >= 3 ? "up" : themeDelta <= -3 ? "down" : "neutral";
  if (sentimentBias === themeBias) return sentimentBias;
  if (sentimentBias === "neutral") return themeBias;
  if (themeBias === "neutral") return sentimentBias;
  return "neutral";
}

function themeSignal(theme: string): "positive" | "negative" | "neutral" {
  const negative = new Set([
    "war",
    "invasion",
    "missile_strike",
    "conflict",
    "sanctions",
    "embargo",
    "default",
    "bankruptcy",
    "recession",
    "inflation",
    "rate_hike",
    "trade_war",
    "tariff",
    "cyberattack",
    "energy_shock",
    "natural_disaster",
    "coup",
    "protest"
  ]);
  const positive = new Set(["rate_cut"]);
  if (negative.has(theme)) return "negative";
  if (positive.has(theme)) return "positive";
  return "neutral";
}

function inferSentiment(text: string | undefined): number {
  if (!text) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  for (const word of POSITIVE_HINTS) {
    if (haystack.includes(word)) score += 1;
  }
  for (const word of NEGATIVE_HINTS) {
    if (haystack.includes(word)) score -= 1;
  }
  return score;
}

function biasDirectionFor(bias: RegimeClassification): "up" | "down" | "neutral" {
  if (bias === "risk_on" || bias === "bullish") return "up";
  if (bias === "risk_off" || bias === "bearish") return "down";
  return "neutral";
}

function directionFrom(value: number | null | undefined): Direction {
  if (value === null || value === undefined || !Number.isFinite(value)) return "unknown";
  if (Math.abs(value) < 0.05) return "flat";
  return value > 0 ? "up" : "down";
}

function numericOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function formatPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
}
