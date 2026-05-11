export type VixStatus = "calm" | "watch" | "elevated" | "critical";
export type SectorMomentum = "leading" | "lagging" | "neutral";
export type RiskState = "risk-on" | "risk-off" | "neutral";

export type SectorEntry = {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  momentum: SectorMomentum;
};

export type FxEntry = {
  symbol: string;
  pair: string;
  price: number;
  changePercent: number;
};

export type IndexEntry = {
  symbol: string;
  name: string;
  value: number;
  changePercent: number;
};

export type CommodityEntry = {
  symbol: string;
  name: string;
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

export type TreasuryTenor =
  | "1M" | "3M" | "6M" | "1Y" | "2Y" | "5Y" | "10Y" | "30Y";

export type TreasuryRate = {
  tenor: TreasuryTenor;
  yieldPercent: number;
  changeBp: number | null;
};

export type TreasurySnapshot = {
  asOf: string;
  rates: TreasuryRate[];
  spread10y2y: number | null;
  spreadDeltas: {
    today: number | null;
    week: number | null;
    month: number | null;
    quarter: number | null;
  };
};

export type RiskPremiumEntry = {
  country: string;
  continent?: string;
  totalEquityRiskPremium: number;
  countryRiskPremium: number;
};

export type RiskPremiumSnapshot = {
  entries: RiskPremiumEntry[];
  emeaAverage: { totalEquityRiskPremium: number; countryRiskPremium: number } | null;
};

export type RotationBucket = {
  bucket: "small-cap" | "mid-cap" | "big-cap";
  symbol: string;
  name: string;
  returns: { d1: number; w1: number | null; m1: number | null; m3: number | null };
};

export type MarketRotation = {
  buckets: RotationBucket[];
  leader1m: { bucket: RotationBucket["bucket"]; returnPct: number } | null;
  rotationSpread1m: number | null;
  riskOnBreadth: "risk-on" | "risk-off" | "mixed";
};

export type MarketDataSnapshot = {
  vix: VixEntry | null;
  oil: CommodityEntry | null;
  gold: CommodityEntry | null;
  dxy: IndexEntry | null;
  fx: FxEntry[];
  sectors: SectorEntry[];
  sectorRotation: SectorRotation;
  indices: IndexEntry[];
  commodities: CommodityEntry[];
  treasury: TreasurySnapshot | null;
  riskPremium: RiskPremiumSnapshot | null;
  rotation: MarketRotation | null;
  riskState: RiskState;
  fetchedAt: string;
};

type RawQuote = {
  symbol?: string;
  price?: number;
  change?: number;
  changePercentage?: number;
};

type RawHistoricalLight = {
  date?: string;
  price?: number;
  close?: number;
};

type RawTreasuryRow = {
  date?: string;
  month1?: number;
  month3?: number;
  month6?: number;
  year1?: number;
  year2?: number;
  year5?: number;
  year10?: number;
  year30?: number;
};

type RawRiskPremium = {
  country?: string;
  continent?: string;
  totalEquityRiskPremium?: number;
  countryRiskPremium?: number;
};

const SECTOR_ETFS: Record<string, string> = {
  XLB: "Basic Materials",
  XLC: "Communication Services",
  XLE: "Energy",
  XLF: "Financial Services",
  XLI: "Industrials",
  XLK: "Technology",
  XLP: "Consumer Defensive",
  XLRE: "Real Estate",
  XLU: "Utilities",
  XLV: "Healthcare",
  XLY: "Consumer Cyclical"
};

const INDEX_TICKERS: Record<string, string> = {
  "^NDX": "NASDAQ 100",
  "^GSPC": "S&P 500",
  "^DJI": "Dow Jones Industrial Average",
  "^RUT": "Russell 2000"
};

const FX_PAIRS: Record<string, string> = {
  EURUSD: "EUR/USD",
  USDEUR: "USD/EUR",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  JPYUSD: "JPY/USD",
  USDCHF: "USD/CHF"
};

const COMMODITY_TICKERS: Record<string, { name: string; alias: string }> = {
  "CL=F": { name: "Crude Oil", alias: "CLUSD" },
  "BZ=F": { name: "Brent Crude Oil", alias: "BZUSD" },
  "GC=F": { name: "Gold Futures", alias: "GCUSD" }
};

const ROTATION_TICKERS: Array<{ bucket: RotationBucket["bucket"]; symbol: string; name: string }> = [
  { bucket: "small-cap", symbol: "IWM", name: "Russell 2000" },
  { bucket: "mid-cap", symbol: "MDY", name: "S&P MidCap 400" },
  { bucket: "big-cap", symbol: "SPY", name: "S&P 500" }
];

const EMEA_CONTINENTS = new Set(["Europe", "Africa", "Middle East", "Western Europe", "Eastern Europe"]);
const VIX_SYMBOL = "^VIX";
const OIL_SYMBOL = "CL=F";
const GOLD_SYMBOL = "GC=F";
const BRENT_SYMBOL = "BZ=F";
const DXY_SYMBOL = "DX=F";

export async function fetchMarketData(apiKey: string): Promise<MarketDataSnapshot> {
  const symbols = [
    VIX_SYMBOL,
    OIL_SYMBOL,
    GOLD_SYMBOL,
    BRENT_SYMBOL,
    DXY_SYMBOL,
    ...Object.keys(SECTOR_ETFS),
    ...Object.keys(INDEX_TICKERS),
    ...Object.keys(FX_PAIRS),
    ...ROTATION_TICKERS.map((entry) => entry.symbol)
  ];

  const [quotes, treasury, riskPremium, rotationHistory] = await Promise.all([
    fetchQuotes(apiKey, symbols),
    fetchTreasury(apiKey).catch((cause) => {
      console.error("fetchTreasury failed", { cause });
      return null;
    }),
    fetchRiskPremium(apiKey).catch((cause) => {
      console.error("fetchRiskPremium failed", { cause });
      return null;
    }),
    fetchRotationHistory(apiKey).catch((cause) => {
      console.error("fetchRotationHistory failed", { cause });
      return new Map<string, RawHistoricalLight[]>();
    })
  ]);

  const byTicker = new Map<string, RawQuote>();
  for (const quote of quotes) {
    if (quote.symbol) {
      byTicker.set(quote.symbol, quote);
    }
  }

  const vix = toVix(byTicker.get(VIX_SYMBOL));
  const oil = toCommodityEntry(OIL_SYMBOL, byTicker.get(OIL_SYMBOL));
  const gold = toCommodityEntry(GOLD_SYMBOL, byTicker.get(GOLD_SYMBOL));
  const dxy = toIndexEntry(DXY_SYMBOL, "US Dollar Index", byTicker.get(DXY_SYMBOL));

  const sectors = buildSectorEntries(byTicker);
  const indices = buildIndexEntries(byTicker);
  const commodities = buildCommodityEntries(byTicker);
  const fx = buildFxEntries(byTicker);
  const rotation = buildRotation(byTicker, rotationHistory);
  const riskState = computeRiskState(vix, sectors, rotation);

  return {
    vix,
    oil,
    gold,
    dxy,
    fx,
    sectors,
    sectorRotation: deriveSectorRotation(sectors),
    indices,
    commodities,
    treasury,
    riskPremium,
    rotation,
    riskState,
    fetchedAt: new Date().toISOString()
  };
}

function buildSectorEntries(byTicker: Map<string, RawQuote>): SectorEntry[] {
  const sectors: SectorEntry[] = [];
  for (const [symbol, name] of Object.entries(SECTOR_ETFS)) {
    const quote = byTicker.get(symbol);
    if (!quote || quote.price === undefined) continue;
    sectors.push({
      symbol,
      name,
      price: round2(quote.price),
      changePercent: round2(quote.changePercentage),
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
  return sectors;
}

function deriveSectorRotation(sectors: SectorEntry[]): SectorRotation {
  const ranked = [...sectors].sort((first, second) => second.changePercent - first.changePercent);
  const leading = ranked.filter((entry) => entry.momentum === "leading");
  const lagging = ranked.filter((entry) => entry.momentum === "lagging");
  const leadingPart = leading
    .map((entry) => `${entry.symbol} ${formatChange(entry.changePercent)}`)
    .join(", ");
  const laggingPart = lagging
    .map((entry) => `${entry.symbol} ${formatChange(entry.changePercent)}`)
    .join(", ");
  return {
    leading: leading.map((entry) => entry.symbol),
    lagging: lagging.map((entry) => entry.symbol),
    summary: sectors.length === 0
      ? "Sector data unavailable."
      : `Leading: ${leadingPart || "n/a"}. Lagging: ${laggingPart || "n/a"}.`
  };
}

function buildIndexEntries(byTicker: Map<string, RawQuote>): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const [symbol, name] of Object.entries(INDEX_TICKERS)) {
    const quote = byTicker.get(symbol);
    if (!quote || quote.price === undefined) continue;
    out.push({
      symbol,
      name,
      value: round2(quote.price),
      changePercent: round2(quote.changePercentage)
    });
  }
  return out;
}

function buildCommodityEntries(byTicker: Map<string, RawQuote>): CommodityEntry[] {
  const out: CommodityEntry[] = [];
  for (const [symbol, meta] of Object.entries(COMMODITY_TICKERS)) {
    const quote = byTicker.get(symbol);
    if (!quote || quote.price === undefined) continue;
    out.push({
      symbol: meta.alias,
      name: meta.name,
      price: round2(quote.price),
      changePercent: round2(quote.changePercentage)
    });
  }
  return out;
}

function buildFxEntries(byTicker: Map<string, RawQuote>): FxEntry[] {
  const out: FxEntry[] = [];
  for (const [symbol, pair] of Object.entries(FX_PAIRS)) {
    const quote = byTicker.get(symbol);
    if (!quote || quote.price === undefined) continue;
    out.push({
      symbol,
      pair,
      price: round4(quote.price),
      changePercent: round2(quote.changePercentage)
    });
  }
  return out;
}

function buildRotation(
  byTicker: Map<string, RawQuote>,
  history: Map<string, RawHistoricalLight[]>
): MarketRotation | null {
  const buckets: RotationBucket[] = [];
  for (const entry of ROTATION_TICKERS) {
    const quote = byTicker.get(entry.symbol);
    if (!quote || quote.price === undefined) continue;
    const closes = history.get(entry.symbol) ?? [];
    const lastPrice = quote.price;
    buckets.push({
      bucket: entry.bucket,
      symbol: entry.symbol,
      name: entry.name,
      returns: {
        d1: round2(quote.changePercentage),
        w1: returnOver(closes, lastPrice, 5),
        m1: returnOver(closes, lastPrice, 21),
        m3: returnOver(closes, lastPrice, 63)
      }
    });
  }
  if (buckets.length === 0) return null;

  const ranked = [...buckets]
    .filter((entry) => entry.returns.m1 !== null)
    .sort((first, second) => (second.returns.m1 ?? -Infinity) - (first.returns.m1 ?? -Infinity));
  const top = ranked[0] ?? null;
  const bottom = ranked.at(-1) ?? null;
  const spread = top && bottom && top !== bottom
    ? round2((top.returns.m1 ?? 0) - (bottom.returns.m1 ?? 0))
    : null;

  let breadth: MarketRotation["riskOnBreadth"] = "mixed";
  if (top) {
    if (top.bucket === "small-cap" && (top.returns.m1 ?? 0) > 0) breadth = "risk-on";
    else if (top.bucket === "big-cap" && (top.returns.m1 ?? 0) <= 0) breadth = "risk-off";
  }

  return {
    buckets,
    leader1m: top ? { bucket: top.bucket, returnPct: round2(top.returns.m1) } : null,
    rotationSpread1m: spread,
    riskOnBreadth: breadth
  };
}

function returnOver(history: RawHistoricalLight[], lastPrice: number, tradingDays: number): number | null {
  if (history.length === 0) return null;
  const sorted = [...history].sort((first, second) => (second.date ?? "").localeCompare(first.date ?? ""));
  const target = sorted[tradingDays];
  const priceThen = (target?.close ?? target?.price);
  if (!priceThen || priceThen <= 0) return null;
  return round2(((lastPrice - priceThen) / priceThen) * 100);
}

async function fetchQuotes(apiKey: string, symbols: string[]): Promise<RawQuote[]> {
  const joined = symbols.map((symbol) => encodeURIComponent(symbol)).join(",");
  const url = `https://financialmodelingprep.com/stable/batch-quote?symbols=${joined}&apikey=${encodeURIComponent(apiKey)}`;
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

async function fetchTreasury(apiKey: string): Promise<TreasurySnapshot | null> {
  const today = new Date();
  const from = new Date(today.getTime() - 120 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const url = `https://financialmodelingprep.com/stable/treasury-rates?from=${fmt(from)}&to=${fmt(today)}&apikey=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error("FMP treasury request failed", { status: response.status });
    return null;
  }
  const raw = (await response.json()) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rows = (raw as RawTreasuryRow[]).sort((first, second) => (second.date ?? "").localeCompare(first.date ?? ""));
  const latest = rows[0];
  if (!latest?.date) return null;
  const previous = rows[1];

  const yieldsOf = (row: RawTreasuryRow): Record<TreasuryTenor, number | undefined> => ({
    "1M": row.month1,
    "3M": row.month3,
    "6M": row.month6,
    "1Y": row.year1,
    "2Y": row.year2,
    "5Y": row.year5,
    "10Y": row.year10,
    "30Y": row.year30
  });
  const current = yieldsOf(latest);
  const prev = previous ? yieldsOf(previous) : undefined;

  const rates: TreasuryRate[] = (Object.keys(current) as TreasuryTenor[])
    .filter((tenor) => Number.isFinite(current[tenor]))
    .map((tenor) => ({
      tenor,
      yieldPercent: round2(current[tenor] as number),
      changeBp: bpDelta(current[tenor], prev?.[tenor])
    }));

  const spread = current["10Y"] !== undefined && current["2Y"] !== undefined
    ? Math.round((current["10Y"] - current["2Y"]) * 100)
    : null;

  const findRow = (daysAgo: number): RawTreasuryRow | undefined => {
    const target = new Date(latest.date!);
    target.setUTCDate(target.getUTCDate() - daysAgo);
    const cutoff = target.toISOString().slice(0, 10);
    return rows.find((row) => (row.date ?? "") <= cutoff);
  };
  const spreadAt = (row: RawTreasuryRow | undefined): number | null => {
    if (!row || row.year10 === undefined || row.year2 === undefined) return null;
    return Math.round((row.year10 - row.year2) * 100);
  };
  const spreadDeltas = {
    today: spread !== null && previous ? spread - (spreadAt(previous) ?? spread) : null,
    week: spread !== null ? (spread - (spreadAt(findRow(7)) ?? spread)) : null,
    month: spread !== null ? (spread - (spreadAt(findRow(30)) ?? spread)) : null,
    quarter: spread !== null ? (spread - (spreadAt(findRow(90)) ?? spread)) : null
  };

  return {
    asOf: latest.date,
    rates,
    spread10y2y: spread,
    spreadDeltas
  };
}

async function fetchRiskPremium(apiKey: string): Promise<RiskPremiumSnapshot | null> {
  const url = `https://financialmodelingprep.com/stable/market-risk-premium?apikey=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error("FMP risk premium request failed", { status: response.status });
    return null;
  }
  const raw = (await response.json()) as unknown;
  if (!Array.isArray(raw)) return null;

  const wanted = new Set(["United States", "Germany", "European Union"]);
  const entries: RiskPremiumEntry[] = [];
  const emeaPool: RawRiskPremium[] = [];

  for (const row of raw as RawRiskPremium[]) {
    if (typeof row.country !== "string") continue;
    if (wanted.has(row.country)) {
      entries.push({
        country: row.country,
        continent: row.continent,
        totalEquityRiskPremium: round2(row.totalEquityRiskPremium),
        countryRiskPremium: round2(row.countryRiskPremium)
      });
    }
    if (row.continent && EMEA_CONTINENTS.has(row.continent)) {
      emeaPool.push(row);
    }
  }

  const order: Record<string, number> = { "United States": 0, Germany: 1, "European Union": 2 };
  entries.sort((first, second) => (order[first.country] ?? 99) - (order[second.country] ?? 99));

  let emeaAverage: RiskPremiumSnapshot["emeaAverage"] = null;
  if (emeaPool.length > 0) {
    const sample = emeaPool.slice(0, 90);
    const erpSum = sample.reduce((sum, row) => sum + Number(row.totalEquityRiskPremium ?? 0), 0);
    const crpSum = sample.reduce((sum, row) => sum + Number(row.countryRiskPremium ?? 0), 0);
    emeaAverage = {
      totalEquityRiskPremium: round2(erpSum / sample.length),
      countryRiskPremium: round2(crpSum / sample.length)
    };
  }

  return { entries, emeaAverage };
}

async function fetchRotationHistory(apiKey: string): Promise<Map<string, RawHistoricalLight[]>> {
  const out = new Map<string, RawHistoricalLight[]>();
  const today = new Date();
  const from = new Date(today.getTime() - 130 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  await Promise.all(
    ROTATION_TICKERS.map(async (entry) => {
      const url = `https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${encodeURIComponent(entry.symbol)}&from=${fmt(from)}&to=${fmt(today)}&apikey=${encodeURIComponent(apiKey)}`;
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.error("FMP historical request failed", { symbol: entry.symbol, status: response.status });
          return;
        }
        const data = (await response.json()) as unknown;
        if (Array.isArray(data)) {
          out.set(entry.symbol, data as RawHistoricalLight[]);
        } else if (data && typeof data === "object" && Array.isArray((data as { historical?: unknown }).historical)) {
          out.set(entry.symbol, (data as { historical: RawHistoricalLight[] }).historical);
        }
      } catch (cause) {
        console.error("FMP historical request errored", { symbol: entry.symbol, cause });
      }
    })
  );
  return out;
}

function computeRiskState(
  vix: VixEntry | null,
  sectors: SectorEntry[],
  rotation: MarketRotation | null
): RiskState {
  let score = 0;
  if (vix) {
    if (vix.status === "critical") score -= 3;
    else if (vix.status === "elevated") score -= 2;
    else if (vix.status === "watch") score -= 1;
    else score += 1;
  }
  const defensiveLeading = sectors.filter(
    (entry) => entry.momentum === "leading" && ["XLU", "XLP", "XLE", "XLV"].includes(entry.symbol)
  ).length;
  const cyclicalLeading = sectors.filter(
    (entry) => entry.momentum === "leading" && ["XLY", "XLK", "XLC", "XLF", "XLI"].includes(entry.symbol)
  ).length;
  score += cyclicalLeading - defensiveLeading;

  if (rotation?.riskOnBreadth === "risk-on") score += 1;
  else if (rotation?.riskOnBreadth === "risk-off") score -= 1;

  if (score >= 2) return "risk-on";
  if (score <= -2) return "risk-off";
  return "neutral";
}

function bpDelta(current: number | undefined, previous: number | undefined): number | null {
  if (current === undefined || previous === undefined) return null;
  return Math.round((current - previous) * 100);
}

function toVix(quote: RawQuote | undefined): VixEntry | null {
  if (!quote || quote.price === undefined) return null;
  return {
    value: round2(quote.price),
    changePercent: round2(quote.changePercentage),
    status: vixBand(quote.price)
  };
}

function toCommodityEntry(symbol: string, quote: RawQuote | undefined): CommodityEntry | null {
  if (!quote || quote.price === undefined) return null;
  const meta = COMMODITY_TICKERS[symbol];
  return {
    symbol: meta?.alias ?? symbol,
    name: meta?.name ?? symbol,
    price: round2(quote.price),
    changePercent: round2(quote.changePercentage)
  };
}

function toIndexEntry(symbol: string, name: string, quote: RawQuote | undefined): IndexEntry | null {
  if (!quote || quote.price === undefined) return null;
  return {
    symbol,
    name,
    value: round2(quote.price),
    changePercent: round2(quote.changePercentage)
  };
}

function vixBand(value: number): VixStatus {
  if (value >= 30) return "critical";
  if (value >= 20) return "elevated";
  if (value >= 15) return "watch";
  return "calm";
}

function formatChange(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function round2(value: number | undefined | null): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

function round4(value: number | undefined | null): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 10000) / 10000;
}
