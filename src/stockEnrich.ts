import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { nowIso } from "./http";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const QUOTE_BATCH_SIZE = 200;
const FETCH_CONCURRENCY = 12;
const HISTORY_LOOKBACK_DAYS = 2 * 365 + 60;
const HISTORY_RETAIN_DAYS = 760;
const STALE_HISTORY_HOURS = 18;

type ReturnsRecord = {
  d1?: number;
  d7?: number;
  m1?: number;
  m3?: number;
  m6?: number;
  y1?: number;
  y2?: number;
  asOf?: string;
};

type HistoricalClose = { date: string; close: number };

type Fundamentals = {
  price?: number;
  marketCap?: number;
  peRatio?: number;
  pegRatio?: number;
  beta?: number;
  eps?: number;
  epsTtm?: number;
  dividendYield?: number;
  priceToBook?: number;
  enterpriseValue?: number;
  asOf?: string;
};

type Margins = {
  grossMargin?: number;
  operatingMargin?: number;
  netMargin?: number;
  ebitdaMargin?: number;
  period?: string;
  fiscalYear?: number;
  asOf?: string;
};

type EpsPoint = {
  period: string;
  date?: string;
  eps?: number;
  estimatedEps?: number;
  surprisePercent?: number;
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
  returns?: ReturnsRecord;
  historicalCloses?: HistoricalClose[];
  historicalsAsOf?: string;
  fundamentals?: Fundamentals;
  margins?: Margins;
  epsHistory?: EpsPoint[];
  enrichedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  processingState?: string;
  executedActions?: unknown[];
};

type RawQuote = {
  symbol?: string;
  price?: number;
  changePercentage?: number;
};

type RawHistorical = {
  date?: string;
  close?: number;
  price?: number;
};

type RawProfile = {
  symbol?: string;
  price?: number;
  beta?: number;
  mktCap?: number;
  marketCap?: number;
  companyName?: string;
  industry?: string;
  sector?: string;
  exchange?: string;
  currency?: string;
};

type RawKeyMetrics = {
  date?: string;
  period?: string;
  peRatio?: number;
  pegRatio?: number;
  enterpriseValue?: number;
  dividendYield?: number;
  priceToBookRatio?: number;
};

type RawIncomeStatement = {
  date?: string;
  period?: string;
  fiscalYear?: number;
  revenue?: number;
  grossProfit?: number;
  operatingIncome?: number;
  netIncome?: number;
  ebitda?: number;
  eps?: number;
  epsdiluted?: number;
  epsDiluted?: number;
};

type RawEarnings = {
  date?: string;
  symbol?: string;
  fiscalDateEnding?: string;
  eps?: number;
  epsEstimated?: number;
  surprisePercentage?: number;
};

export async function refreshHistoricals(): Promise<{ scanned: number; updated: number; failures: number }> {
  const startedAt = Date.now();
  console.log("stockEnrich.historicals.start", { at: new Date(startedAt).toISOString() });
  const apiKey = requireApiKey();
  const stocks = await scanStocks();
  const due = stocks.filter((stock) => isHistoricalsDue(stock));

  let updated = 0;
  let failures = 0;
  await runWithConcurrency(due, FETCH_CONCURRENCY, async (stock) => {
    try {
      const closes = await fetchHistorical(apiKey, stock.symbol);
      if (!closes || closes.length === 0) {
        failures += 1;
        return;
      }
      const trimmed = closes.slice(0, HISTORY_RETAIN_DAYS);
      await documentClient.send(
        new UpdateCommand({
          TableName: Resource.Stocks.name,
          Key: { symbol: stock.symbol },
          UpdateExpression: "SET historicalCloses = :h, historicalsAsOf = :a, updatedAt = :u",
          ExpressionAttributeValues: {
            ":h": trimmed,
            ":a": nowIso(),
            ":u": nowIso()
          }
        })
      );
      updated += 1;
    } catch (cause) {
      console.error("refreshHistoricals symbol failed", { symbol: stock.symbol, cause });
      failures += 1;
    }
  });

  console.log("stockEnrich.historicals.done", {
    durationMs: Date.now() - startedAt,
    scanned: stocks.length,
    due: due.length,
    updated,
    failures
  });
  return { scanned: stocks.length, updated, failures };
}

export async function refreshReturns(): Promise<{ scanned: number; updated: number; failures: number }> {
  const startedAt = Date.now();
  console.log("stockEnrich.returns.start", { at: new Date(startedAt).toISOString() });
  const apiKey = requireApiKey();
  const stocks = await scanStocks();
  if (stocks.length === 0) {
    return { scanned: 0, updated: 0, failures: 0 };
  }

  const quoteMap = new Map<string, RawQuote>();
  const batches = chunk(stocks.map((stock) => stock.symbol), QUOTE_BATCH_SIZE);
  await runWithConcurrency(batches, FETCH_CONCURRENCY, async (batch) => {
    const quotes = await fetchBatchQuotes(apiKey, batch);
    for (const quote of quotes) {
      if (quote.symbol) {
        quoteMap.set(quote.symbol, quote);
      }
    }
  });

  let updated = 0;
  let failures = 0;
  const asOf = nowIso();
  await runWithConcurrency(stocks, FETCH_CONCURRENCY, async (stock) => {
    const quote = quoteMap.get(stock.symbol);
    if (!quote || quote.price === undefined) return;
    const returns = computeReturns(stock.historicalCloses ?? [], quote);
    if (!returns) return;
    try {
      await documentClient.send(
        new UpdateCommand({
          TableName: Resource.Stocks.name,
          Key: { symbol: stock.symbol },
          UpdateExpression: "SET #r = :r, price = :p, priceAsOf = :a, updatedAt = :u",
          ExpressionAttributeNames: { "#r": "returns" },
          ExpressionAttributeValues: {
            ":r": returns,
            ":p": round2(quote.price),
            ":a": asOf,
            ":u": asOf
          }
        })
      );
      updated += 1;
    } catch (cause) {
      console.error("refreshReturns symbol failed", { symbol: stock.symbol, cause });
      failures += 1;
    }
  });

  console.log("stockEnrich.returns.done", {
    durationMs: Date.now() - startedAt,
    scanned: stocks.length,
    quotesFetched: quoteMap.size,
    updated,
    failures
  });
  return { scanned: stocks.length, updated, failures };
}

export async function enrichFundamentals(): Promise<{ scanned: number; updated: number; failures: number }> {
  const startedAt = Date.now();
  console.log("stockEnrich.enrich.start", { at: new Date(startedAt).toISOString() });
  const apiKey = requireApiKey();
  const stocks = await scanStocks();
  let updated = 0;
  let failures = 0;
  await runWithConcurrency(stocks, FETCH_CONCURRENCY, async (stock) => {
    try {
      const [profile, metrics, income, earnings] = await Promise.all([
        fetchProfile(apiKey, stock.symbol),
        fetchKeyMetrics(apiKey, stock.symbol),
        fetchIncomeStatement(apiKey, stock.symbol),
        fetchEarningsHistory(apiKey, stock.symbol)
      ]);

      const fundamentals: Fundamentals = {
        price: profile?.price !== undefined ? round2(profile.price) : stock.fundamentals?.price,
        marketCap: profile?.marketCap ?? profile?.mktCap,
        beta: profile?.beta,
        peRatio: metrics?.peRatio,
        pegRatio: metrics?.pegRatio,
        enterpriseValue: metrics?.enterpriseValue,
        dividendYield: metrics?.dividendYield,
        priceToBook: metrics?.priceToBookRatio,
        eps: income?.eps ?? income?.epsdiluted ?? income?.epsDiluted,
        epsTtm: epsTtm(earnings),
        asOf: nowIso()
      };

      const margins = buildMargins(income);
      const epsHistory = (earnings ?? []).slice(0, 12).map((entry) => ({
        period: entry.fiscalDateEnding ?? entry.date ?? "",
        date: entry.date,
        eps: entry.eps,
        estimatedEps: entry.epsEstimated,
        surprisePercent: entry.surprisePercentage
      }));

      const update: Record<string, unknown> = {
        ":f": pruneUndefined(fundamentals),
        ":eh": epsHistory,
        ":e": nowIso(),
        ":u": nowIso()
      };
      let updateExpression = "SET fundamentals = :f, epsHistory = :eh, enrichedAt = :e, updatedAt = :u";
      if (margins) {
        update[":m"] = pruneUndefined(margins);
        updateExpression += ", margins = :m";
      }
      if (profile?.companyName && !stock.name) {
        update[":n"] = profile.companyName;
        updateExpression += ", #n = :n";
      }
      if (profile?.industry && !stock.industry) {
        update[":i"] = profile.industry;
        updateExpression += ", industry = :i";
      }
      if (profile?.sector && !stock.sector) {
        update[":s"] = profile.sector;
        updateExpression += ", sector = :s";
      }

      await documentClient.send(
        new UpdateCommand({
          TableName: Resource.Stocks.name,
          Key: { symbol: stock.symbol },
          UpdateExpression: updateExpression,
          ExpressionAttributeNames: profile?.companyName && !stock.name ? { "#n": "name" } : undefined,
          ExpressionAttributeValues: update
        })
      );
      updated += 1;
    } catch (cause) {
      console.error("enrichFundamentals symbol failed", { symbol: stock.symbol, cause });
      failures += 1;
    }
  });

  console.log("stockEnrich.enrich.done", {
    durationMs: Date.now() - startedAt,
    scanned: stocks.length,
    updated,
    failures
  });
  return { scanned: stocks.length, updated, failures };
}

export function computeReturns(history: HistoricalClose[], quote: RawQuote): ReturnsRecord | null {
  if (quote.price === undefined) return null;
  const lastPrice = quote.price;
  const sorted = [...history].sort((first, second) => second.date.localeCompare(first.date));
  const ret = (tradingDays: number): number | undefined => {
    if (tradingDays === 0) {
      return quote.changePercentage !== undefined ? round2(quote.changePercentage) : undefined;
    }
    const target = sorted[tradingDays];
    if (!target || !target.close) return undefined;
    return round2(((lastPrice - target.close) / target.close) * 100);
  };
  const out: ReturnsRecord = {
    d1: ret(0),
    d7: ret(5),
    m1: ret(21),
    m3: ret(63),
    m6: ret(126),
    y1: ret(252),
    y2: ret(504),
    asOf: nowIso()
  };
  return pruneUndefined(out) as ReturnsRecord;
}

export async function scanStocks(): Promise<StockRow[]> {
  const stocks: StockRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: Resource.Stocks.name,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    stocks.push(...((response.Items ?? []) as StockRow[]));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return stocks;
}

export async function upsertStockMinimal(row: {
  symbol: string;
  name?: string;
  sector?: string;
  industry?: string;
  exchange?: string;
  currency?: string;
}): Promise<void> {
  const now = nowIso();
  await documentClient.send(
    new UpdateCommand({
      TableName: Resource.Stocks.name,
      Key: { symbol: row.symbol },
      UpdateExpression:
        "SET #n = if_not_exists(#n, :n), sector = if_not_exists(sector, :se), industry = if_not_exists(industry, :i), exchange = if_not_exists(exchange, :ex), currency = if_not_exists(currency, :cu), createdAt = if_not_exists(createdAt, :now), updatedAt = :now",
      ExpressionAttributeNames: { "#n": "name" },
      ExpressionAttributeValues: {
        ":n": row.name ?? "",
        ":se": row.sector ?? "",
        ":i": row.industry ?? "",
        ":ex": row.exchange ?? "",
        ":cu": row.currency ?? "",
        ":now": now
      }
    })
  );
}

function requireApiKey(): string {
  const apiKey = Resource.FMP_API_KEY.value;
  if (!apiKey) {
    throw new Error("FMP_API_KEY secret is not configured.");
  }
  return apiKey;
}

function isHistoricalsDue(stock: StockRow): boolean {
  if (!stock.historicalCloses || stock.historicalCloses.length < 252) return true;
  if (!stock.historicalsAsOf) return true;
  const ageHours = (Date.now() - Date.parse(stock.historicalsAsOf)) / 3_600_000;
  return Number.isFinite(ageHours) && ageHours >= STALE_HISTORY_HOURS;
}

async function fetchHistorical(apiKey: string, symbol: string): Promise<HistoricalClose[] | null> {
  const today = new Date();
  const from = new Date(today.getTime() - HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${encodeURIComponent(symbol)}&from=${fmt(from)}&to=${fmt(today)}&apikey=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const data = (await response.json()) as unknown;
  const raw = Array.isArray(data)
    ? (data as RawHistorical[])
    : (data && typeof data === "object" && Array.isArray((data as { historical?: unknown }).historical)
      ? ((data as { historical: RawHistorical[] }).historical)
      : []);
  return raw
    .filter((entry): entry is RawHistorical & { date: string } => typeof entry.date === "string")
    .map((entry) => ({
      date: entry.date,
      close: round4(entry.close ?? entry.price)
    }))
    .filter((entry) => Number.isFinite(entry.close) && entry.close > 0)
    .sort((first, second) => second.date.localeCompare(first.date));
}

async function fetchBatchQuotes(apiKey: string, symbols: string[]): Promise<RawQuote[]> {
  if (symbols.length === 0) return [];
  const joined = symbols.map((symbol) => encodeURIComponent(symbol)).join(",");
  const url = `https://financialmodelingprep.com/stable/batch-quote?symbols=${joined}&apikey=${encodeURIComponent(apiKey)}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = (await response.json()) as unknown;
    return Array.isArray(data) ? (data as RawQuote[]) : [];
  } catch (cause) {
    console.error("batch-quote failed", { cause });
    return [];
  }
}

async function fetchProfile(apiKey: string, symbol: string): Promise<RawProfile | undefined> {
  const url = `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
  return await fetchFirst<RawProfile>(url);
}

async function fetchKeyMetrics(apiKey: string, symbol: string): Promise<RawKeyMetrics | undefined> {
  const url = `https://financialmodelingprep.com/stable/key-metrics-ttm?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
  return await fetchFirst<RawKeyMetrics>(url);
}

async function fetchIncomeStatement(apiKey: string, symbol: string): Promise<RawIncomeStatement | undefined> {
  const url = `https://financialmodelingprep.com/stable/income-statement?symbol=${encodeURIComponent(symbol)}&limit=4&apikey=${encodeURIComponent(apiKey)}`;
  return await fetchFirst<RawIncomeStatement>(url);
}

async function fetchEarningsHistory(apiKey: string, symbol: string): Promise<RawEarnings[]> {
  const url = `https://financialmodelingprep.com/stable/earnings?symbol=${encodeURIComponent(symbol)}&limit=12&apikey=${encodeURIComponent(apiKey)}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = (await response.json()) as unknown;
    return Array.isArray(data) ? (data as RawEarnings[]) : [];
  } catch (cause) {
    console.error("earnings fetch failed", { symbol, cause });
    return [];
  }
}

async function fetchFirst<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    const data = (await response.json()) as unknown;
    if (Array.isArray(data) && data.length > 0) return data[0] as T;
    if (data && typeof data === "object" && !Array.isArray(data)) return data as T;
    return undefined;
  } catch (cause) {
    console.error("fetch failed", { url, cause });
    return undefined;
  }
}

function buildMargins(income: RawIncomeStatement | undefined): Margins | undefined {
  if (!income) return undefined;
  const revenue = Number(income.revenue);
  if (!Number.isFinite(revenue) || revenue <= 0) return undefined;
  const ratio = (numerator: number | undefined): number | undefined => {
    if (numerator === undefined || !Number.isFinite(numerator)) return undefined;
    return round4(numerator / revenue);
  };
  return pruneUndefined({
    grossMargin: ratio(income.grossProfit),
    operatingMargin: ratio(income.operatingIncome),
    netMargin: ratio(income.netIncome),
    ebitdaMargin: ratio(income.ebitda),
    period: income.period ?? income.date,
    fiscalYear: income.fiscalYear,
    asOf: nowIso()
  }) as Margins;
}

function epsTtm(earnings: RawEarnings[]): number | undefined {
  if (earnings.length < 4) return undefined;
  const last4 = earnings.slice(0, 4).map((entry) => Number(entry.eps)).filter((value) => Number.isFinite(value));
  if (last4.length < 4) return undefined;
  return round4(last4.reduce((sum, value) => sum + value, 0));
}

async function runWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out as T;
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
