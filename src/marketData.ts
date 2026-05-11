export type VixStatus = "calm" | "watch" | "elevated" | "critical";
export type SectorMomentum = "leading" | "lagging" | "neutral";

export type SectorEntry = {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  momentum: SectorMomentum;
};

export type FxEntry = {
  symbol: string;
  price: number;
  changePercent: number;
};

export type IndexEntry = {
  value: number;
  changePercent: number;
};

export type CommodityEntry = {
  price: number;
  changePercent: number;
};

export type VixEntry = {
  value: number;
  changePercent: number;
  status: VixStatus;
};

export type SectorRotation = {
  leading: string[];
  lagging: string[];
  summary: string;
};

export type MarketDataSnapshot = {
  vix: VixEntry | null;
  oil: CommodityEntry | null;
  gold: CommodityEntry | null;
  dxy: IndexEntry | null;
  fx: FxEntry[];
  sectors: SectorEntry[];
  sectorRotation: SectorRotation;
  fetchedAt: string;
};

type RawQuote = {
  symbol?: string;
  price?: number;
  change?: number;
  changesPercentage?: number;
};

const SECTOR_ETFS: Record<string, string> = {
  XLB: "Materials",
  XLC: "Communication Services",
  XLE: "Energy",
  XLF: "Financials",
  XLI: "Industrials",
  XLK: "Technology",
  XLP: "Consumer Staples",
  XLRE: "Real Estate",
  XLU: "Utilities",
  XLV: "Healthcare",
  XLY: "Consumer Discretionary"
};

const FX_PAIRS = ["EURUSD", "USDJPY", "GBPUSD"];
const VIX_SYMBOL = "^VIX";
const OIL_SYMBOL = "CL=F";
const GOLD_SYMBOL = "GC=F";
const DXY_SYMBOL = "DX=F";

export async function fetchMarketData(apiKey: string): Promise<MarketDataSnapshot> {
  const symbols = [
    VIX_SYMBOL,
    OIL_SYMBOL,
    GOLD_SYMBOL,
    DXY_SYMBOL,
    ...Object.keys(SECTOR_ETFS),
    ...FX_PAIRS
  ];

  const quotes = await fetchQuotes(apiKey, symbols);
  const byTicker = new Map<string, RawQuote>();
  for (const quote of quotes) {
    if (quote.symbol) {
      byTicker.set(quote.symbol, quote);
    }
  }

  const vix = toVix(byTicker.get(VIX_SYMBOL));
  const oil = toCommodity(byTicker.get(OIL_SYMBOL));
  const gold = toCommodity(byTicker.get(GOLD_SYMBOL));
  const dxy = toIndex(byTicker.get(DXY_SYMBOL));

  const sectors: SectorEntry[] = [];
  for (const [symbol, name] of Object.entries(SECTOR_ETFS)) {
    const quote = byTicker.get(symbol);
    if (!quote || quote.price === undefined) continue;
    sectors.push({
      symbol,
      name,
      price: round2(quote.price),
      changePercent: round2(quote.changesPercentage),
      momentum: "neutral"
    });
  }

  const ranked = [...sectors].sort((first, second) => second.changePercent - first.changePercent);
  const leadingCount = Math.min(3, ranked.length);
  const laggingCount = Math.min(3, Math.max(0, ranked.length - leadingCount));
  const leadingSet = new Set(ranked.slice(0, leadingCount).map((entry) => entry.symbol));
  const laggingSet = new Set(ranked.slice(-laggingCount).map((entry) => entry.symbol));
  for (const sector of sectors) {
    if (leadingSet.has(sector.symbol)) sector.momentum = "leading";
    else if (laggingSet.has(sector.symbol)) sector.momentum = "lagging";
  }

  const fx: FxEntry[] = [];
  for (const symbol of FX_PAIRS) {
    const quote = byTicker.get(symbol);
    if (!quote || quote.price === undefined) continue;
    fx.push({
      symbol,
      price: round4(quote.price),
      changePercent: round2(quote.changesPercentage)
    });
  }

  return {
    vix,
    oil,
    gold,
    dxy,
    fx,
    sectors,
    sectorRotation: {
      leading: [...leadingSet],
      lagging: [...laggingSet],
      summary: buildRotationSummary(ranked, leadingSet, laggingSet)
    },
    fetchedAt: new Date().toISOString()
  };
}

async function fetchQuotes(apiKey: string, symbols: string[]): Promise<RawQuote[]> {
  const joined = symbols.map((symbol) => encodeURIComponent(symbol)).join(",");
  const url = `https://financialmodelingprep.com/api/v3/quote/${joined}?apikey=${encodeURIComponent(apiKey)}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error("FMP quote request failed", { status: response.status });
      return [];
    }
    const data = (await response.json()) as unknown;
    return Array.isArray(data) ? (data as RawQuote[]) : [];
  } catch (cause) {
    console.error("FMP quote request errored", { cause });
    return [];
  }
}

function toVix(quote: RawQuote | undefined): VixEntry | null {
  if (!quote || quote.price === undefined) return null;
  return {
    value: round2(quote.price),
    changePercent: round2(quote.changesPercentage),
    status: vixBand(quote.price)
  };
}

function toCommodity(quote: RawQuote | undefined): CommodityEntry | null {
  if (!quote || quote.price === undefined) return null;
  return {
    price: round2(quote.price),
    changePercent: round2(quote.changesPercentage)
  };
}

function toIndex(quote: RawQuote | undefined): IndexEntry | null {
  if (!quote || quote.price === undefined) return null;
  return {
    value: round2(quote.price),
    changePercent: round2(quote.changesPercentage)
  };
}

function vixBand(value: number): VixStatus {
  if (value >= 30) return "critical";
  if (value >= 20) return "elevated";
  if (value >= 15) return "watch";
  return "calm";
}

function buildRotationSummary(
  ranked: SectorEntry[],
  leadingSet: Set<string>,
  laggingSet: Set<string>
): string {
  if (ranked.length === 0) {
    return "Sector data unavailable.";
  }
  const leading = ranked.filter((entry) => leadingSet.has(entry.symbol));
  const lagging = ranked.filter((entry) => laggingSet.has(entry.symbol));
  const leadingPart = leading
    .map((entry) => `${entry.symbol} ${formatChange(entry.changePercent)}`)
    .join(", ");
  const laggingPart = lagging
    .map((entry) => `${entry.symbol} ${formatChange(entry.changePercent)}`)
    .join(", ");
  return `Leading: ${leadingPart || "n/a"}. Lagging: ${laggingPart || "n/a"}.`;
}

function formatChange(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function round2(value: number | undefined): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

function round4(value: number | undefined): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 10000) / 10000;
}
