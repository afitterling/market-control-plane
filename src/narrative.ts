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
const DEFAULT_BAR_DAYS = 14;
const MAX_BAR_DAYS = 60;

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
  returns?: StockReturns;
  historicalCloses?: HistoricalClose[];
  fundamentals?: { eps?: number; epsTtm?: number; peRatio?: number; marketCap?: number; beta?: number };
  margins?: { grossMargin?: number; operatingMargin?: number; netMargin?: number; ebitdaMargin?: number };
  enrichedAt?: string;
  processingState?: string;
};

type PulseSnapshot = {
  scope: string;
  snapshotAt: string;
  riskState?: "risk-on" | "risk-off" | "neutral";
  overall?: { status?: string; score?: number; hotRegions?: string[]; topThemes?: string[]; summary?: string };
  marketData?: {
    vix?: { value?: number; changePercent?: number; status?: string } | null;
    sectors?: Array<{
      symbol: string;
      name: string;
      changePercent: number;
      momentum: "leading" | "lagging" | "neutral";
    }>;
    rotation?: {
      leader1m?: { bucket: string; returnPct: number } | null;
      riskOnBreadth?: string;
    } | null;
    treasury?: { rates?: Array<{ tenor: string; yieldPercent: number; changeBp: number | null }> } | null;
  };
};

type Bar = { date: string; close: number; changePct: number | null };

type Narrative = {
  symbol: string;
  name?: string;
  sector?: string;
  industry?: string;
  generatedAt: string;
  windowDays: number;
  bars: Bar[];
  returns: {
    window: number | null;
    d1: number | null;
    d7: number | null;
    m1: number | null;
    m3: number | null;
    m6: number | null;
    y1: number | null;
    y2: number | null;
  };
  market: {
    riskState: "risk-on" | "risk-off" | "neutral";
    pulseStatus: string | null;
    pulseScore: number | null;
    hotRegions: string[];
    vixValue: number | null;
    vixStatus: string | null;
  };
  alignment: {
    sectorChangePct: number | null;
    sectorMomentum: "leading" | "lagging" | "neutral" | null;
    stockMinusSectorWindowPct: number | null;
    capRotation: string | null;
    interpretation: "with-sector" | "against-sector" | "neutral" | "no-sector-data";
  };
  fundamentals: StockRow["fundamentals"];
  margins: StockRow["margins"];
  summary: string;
  drivers: string[];
};

export async function narrative(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) return unauthorized;

  const symbol = cleanSymbol(event.pathParameters?.symbol);
  if (!symbol) return error("Missing stock symbol.");

  const days = clampInt(Number(event.queryStringParameters?.days ?? DEFAULT_BAR_DAYS), 3, MAX_BAR_DAYS);

  const stock = await getStock(symbol);
  if (!stock) return error("Stock not found.", 404);

  const snapshot = await fetchLatestSnapshot();
  const bars = buildBars(stock.historicalCloses ?? [], days);
  const windowReturn = computeWindowReturn(bars);
  const sectorEntry = findSectorEntry(snapshot, stock.sector);
  const alignment = buildAlignment(windowReturn, sectorEntry, snapshot);
  const drivers = buildDrivers(snapshot, stock, alignment, windowReturn);
  const summary = buildSummary(symbol, stock, windowReturn, sectorEntry, snapshot, alignment);

  const payload: Narrative = {
    symbol,
    name: stock.name,
    sector: stock.sector,
    industry: stock.industry,
    generatedAt: nowIso(),
    windowDays: days,
    bars,
    returns: {
      window: windowReturn,
      d1: stock.returns?.d1 ?? null,
      d7: stock.returns?.d7 ?? null,
      m1: stock.returns?.m1 ?? null,
      m3: stock.returns?.m3 ?? null,
      m6: stock.returns?.m6 ?? null,
      y1: stock.returns?.y1 ?? null,
      y2: stock.returns?.y2 ?? null
    },
    market: {
      riskState: snapshot?.riskState ?? "neutral",
      pulseStatus: snapshot?.overall?.status ?? null,
      pulseScore: snapshot?.overall?.score ?? null,
      hotRegions: snapshot?.overall?.hotRegions ?? [],
      vixValue: snapshot?.marketData?.vix?.value ?? null,
      vixStatus: snapshot?.marketData?.vix?.status ?? null
    },
    alignment,
    fundamentals: stock.fundamentals,
    margins: stock.margins,
    summary,
    drivers
  };

  return json({ narrative: payload });
}

async function getStock(symbol: string): Promise<StockRow | undefined> {
  const response = await documentClient.send(
    new GetCommand({ TableName: Resource.Stocks.name, Key: { symbol } })
  );
  return response.Item as StockRow | undefined;
}

async function fetchLatestSnapshot(): Promise<PulseSnapshot | undefined> {
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

function buildBars(closes: HistoricalClose[], days: number): Bar[] {
  if (closes.length === 0) return [];
  const sorted = [...closes].sort((first, second) => first.date.localeCompare(second.date));
  const slice = sorted.slice(-days);
  return slice.map((entry, index) => {
    if (index === 0) {
      return { date: entry.date, close: entry.close, changePct: null };
    }
    const prev = slice[index - 1].close;
    const changePct = prev > 0 ? round2(((entry.close - prev) / prev) * 100) : null;
    return { date: entry.date, close: entry.close, changePct };
  });
}

function computeWindowReturn(bars: Bar[]): number | null {
  if (bars.length < 2) return null;
  const first = bars[0].close;
  const last = bars.at(-1)?.close ?? null;
  if (!first || !last || first <= 0) return null;
  return round2(((last - first) / first) * 100);
}

function findSectorEntry(snapshot: PulseSnapshot | undefined, sectorName: string | undefined) {
  if (!snapshot?.marketData?.sectors || !sectorName) return null;
  return (
    snapshot.marketData.sectors.find(
      (entry) => entry.name.toLowerCase() === sectorName.toLowerCase()
    ) ?? null
  );
}

function buildAlignment(
  windowReturn: number | null,
  sectorEntry: ReturnType<typeof findSectorEntry>,
  snapshot: PulseSnapshot | undefined
): Narrative["alignment"] {
  const sectorChange = sectorEntry?.changePercent ?? null;
  const momentum = sectorEntry?.momentum ?? null;
  const capRotation = snapshot?.marketData?.rotation?.leader1m
    ? `${snapshot.marketData.rotation.leader1m.bucket} leading ${snapshot.marketData.rotation.leader1m.returnPct}% over 1M`
    : null;
  if (windowReturn === null || sectorChange === null) {
    return {
      sectorChangePct: sectorChange,
      sectorMomentum: momentum,
      stockMinusSectorWindowPct: null,
      capRotation,
      interpretation: sectorEntry ? "neutral" : "no-sector-data"
    };
  }
  const diff = round2(windowReturn - sectorChange);
  const interpretation: Narrative["alignment"]["interpretation"] =
    Math.abs(diff) < 0.5 ? "neutral" : diff > 0 ? "against-sector" : "with-sector";
  return {
    sectorChangePct: sectorChange,
    sectorMomentum: momentum,
    stockMinusSectorWindowPct: diff,
    capRotation,
    interpretation
  };
}

function buildDrivers(
  snapshot: PulseSnapshot | undefined,
  stock: StockRow,
  alignment: Narrative["alignment"],
  windowReturn: number | null
): string[] {
  const drivers: string[] = [];
  if (snapshot?.marketData?.vix && typeof snapshot.marketData.vix.changePercent === "number") {
    const vix = snapshot.marketData.vix;
    const dir = vix.changePercent! >= 0 ? "rising" : "easing";
    drivers.push(`VIX ${dir} (${formatPct(vix.changePercent!)}, ${vix.status ?? "n/a"})`);
  }
  if (alignment.sectorMomentum === "leading") {
    drivers.push(`${stock.sector ?? "sector"} is leading the tape (${formatPct(alignment.sectorChangePct ?? 0)} today)`);
  } else if (alignment.sectorMomentum === "lagging") {
    drivers.push(`${stock.sector ?? "sector"} is lagging the tape (${formatPct(alignment.sectorChangePct ?? 0)} today)`);
  }
  if (alignment.capRotation) drivers.push(alignment.capRotation);
  const treasury10y = snapshot?.marketData?.treasury?.rates?.find((rate) => rate.tenor === "10Y");
  if (treasury10y && treasury10y.changeBp !== null) {
    const dir = treasury10y.changeBp < 0 ? "compressing" : "rising";
    drivers.push(`10Y yield ${dir} ${Math.abs(treasury10y.changeBp)}bp`);
  }
  if (typeof stock.fundamentals?.peRatio === "number") {
    drivers.push(`Trading at ${stock.fundamentals.peRatio.toFixed(1)}x P/E${stock.fundamentals.epsTtm ? `, TTM EPS ${stock.fundamentals.epsTtm}` : ""}`);
  }
  if (windowReturn !== null && Math.abs(windowReturn) >= 10) {
    drivers.push(`${windowReturn >= 0 ? "Strong" : "Sharp"} ${windowReturn >= 0 ? "rally" : "drawdown"} over the window (${formatPct(windowReturn)})`);
  }
  return drivers;
}

function buildSummary(
  symbol: string,
  stock: StockRow,
  windowReturn: number | null,
  sectorEntry: ReturnType<typeof findSectorEntry>,
  snapshot: PulseSnapshot | undefined,
  alignment: Narrative["alignment"]
): string {
  const name = stock.name ? `${stock.name} (${symbol})` : symbol;
  const parts: string[] = [];

  if (windowReturn !== null) {
    const direction = windowReturn >= 0 ? "up" : "down";
    parts.push(`${name} is ${direction} ${formatPct(windowReturn)} over the past ${stock.historicalCloses?.length ? "bars in window" : "available history"}`);
  } else {
    parts.push(`${name} has insufficient historical bars to compute a window return`);
  }

  if (sectorEntry && alignment.stockMinusSectorWindowPct !== null) {
    const delta = alignment.stockMinusSectorWindowPct;
    if (alignment.interpretation === "with-sector") {
      parts.push(`underperforming ${stock.sector} by ${formatPct(Math.abs(delta))}`);
    } else if (alignment.interpretation === "against-sector") {
      parts.push(`outperforming ${stock.sector} by ${formatPct(Math.abs(delta))}`);
    } else {
      parts.push(`tracking ${stock.sector} closely (${formatPct(delta)} vs sector)`);
    }
  } else if (stock.sector) {
    parts.push(`sector context (${stock.sector}) not available in the latest snapshot`);
  }

  const riskState = snapshot?.riskState ?? "neutral";
  const pulseStatus = snapshot?.overall?.status;
  if (pulseStatus) {
    parts.push(`tape is ${riskState} with pulse ${pulseStatus}`);
  } else {
    parts.push(`tape is ${riskState}`);
  }

  const vix = snapshot?.marketData?.vix;
  if (vix && typeof vix.value === "number") {
    parts.push(`VIX ${vix.value}${typeof vix.changePercent === "number" ? ` (${formatPct(vix.changePercent)})` : ""}`);
  }

  return parts.join("; ") + ".";
}

function formatPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
