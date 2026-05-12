import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { publishEvent } from "./events";
import { cleanSymbol, nowIso } from "./http";
import { processMacd } from "./macd";
import { putSignal } from "./streams";

const STOCK_DATA_PULLED_ACTION = "STCO_DATA_PULLED";
const STOCK_PROCESS_FAILED_ACTION = "STCO_PROCESS_FAILED";
const STOCK_READY_ACTION = "STCO_READY";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type FmpIncomeStatement = {
  date?: string;
  symbol?: string;
  reportedCurrency?: string;
  calendarYear?: string;
  period?: string;
  revenue?: number;
  grossProfit?: number;
  operatingIncome?: number;
  netIncome?: number;
  eps?: number;
  epsdiluted?: number;
  [key: string]: unknown;
};

type FmpCashFlowStatement = {
  date?: string;
  calendarYear?: string;
  period?: string;
  operatingCashFlow?: number;
  netCashProvidedByOperatingActivities?: number;
  freeCashFlow?: number;
  capitalExpenditure?: number;
  [key: string]: unknown;
};

type EarningsAnalysis = {
  grossMargin?: number;
  operatingMargin?: number;
  netMargin?: number;
  freeCashFlow?: number;
  operatingCashFlow?: number;
  capitalExpenditure?: number;
  fcfMargin?: number;
  fcfConversion?: number;
  revenueGrowth?: number;
  netIncomeGrowth?: number;
  epsGrowth?: number;
  grossMarginDelta?: number;
  operatingMarginDelta?: number;
  narrative: string;
};

type EarningsRow = {
  symbol: string;
  period: string;
  reportDate?: string;
  fiscalPeriod?: string;
  calendarYear?: string;
  reportedCurrency?: string;
  revenue?: number;
  grossProfit?: number;
  operatingIncome?: number;
  netIncome?: number;
  eps?: number;
  epsDiluted?: number;
  analysis: EarningsAnalysis;
  source: "fmp";
  fetchedAt: string;
  raw: { income: FmpIncomeStatement; cashFlow?: FmpCashFlowStatement };
};

export async function processStock(input: { symbol?: string }): Promise<{
  symbol: string;
  annualCount: number;
  quarterlyCount: number;
}> {
  const symbol = cleanSymbol(input?.symbol);
  if (!symbol) {
    throw new Error("processStock requires a symbol.");
  }

  const apiKey = Resource.FMP_API_KEY.value;
  if (!apiKey) {
    await markFailed(symbol, "FMP_API_KEY secret is not configured.");
    throw new Error("FMP_API_KEY secret is not configured.");
  }

  try {
    const [annualIncome, quarterlyIncome, annualCashFlow, quarterlyCashFlow] = await Promise.all([
      fetchIncomeStatement(symbol, "annual", apiKey),
      fetchIncomeStatement(symbol, "quarter", apiKey),
      fetchCashFlowStatement(symbol, "annual", apiKey),
      fetchCashFlowStatement(symbol, "quarter", apiKey)
    ]);

    const annualRows = buildRows(symbol, "ANNUAL", annualIncome, annualCashFlow);
    const quarterlyRows = buildRows(symbol, "QUARTER", quarterlyIncome, quarterlyCashFlow);
    const rows = [...annualRows, ...quarterlyRows];

    if (rows.length > 0) {
      await batchPutEarnings(rows);
    }

    const latest = pickLatest(quarterlyRows, annualRows);

    await documentClient.send(
      new UpdateCommand({
        TableName: Resource.Stocks.name,
        Key: { symbol },
        UpdateExpression:
          "SET processingState = :state, dataPulledAt = :now, updatedAt = :now, annualReportCount = :annualCount, quarterlyReportCount = :quarterlyCount, latestEarningsAnalysis = :analysis",
        ExpressionAttributeValues: {
          ":state": "data_pulled",
          ":now": nowIso(),
          ":annualCount": annualIncome.length,
          ":quarterlyCount": quarterlyIncome.length,
          ":analysis": latest
            ? {
                period: latest.period,
                reportDate: latest.reportDate,
                fiscalPeriod: latest.fiscalPeriod,
                calendarYear: latest.calendarYear,
                analysis: latest.analysis
              }
            : null
        }
      })
    );

    try {
      await processMacd({ symbol });
    } catch (cause) {
      console.error("on-enter MACD seed failed", { symbol, cause });
    }

    await publishEvent(STOCK_DATA_PULLED_ACTION, {
      action: STOCK_DATA_PULLED_ACTION,
      symbol,
      annualCount: annualIncome.length,
      quarterlyCount: quarterlyIncome.length,
      latestNarrative: latest?.analysis.narrative ?? null
    });

    const readyAt = nowIso();
    await publishEvent(STOCK_READY_ACTION, {
      action: STOCK_READY_ACTION,
      symbol,
      readyAt,
      annualCount: annualIncome.length,
      quarterlyCount: quarterlyIncome.length,
      latestNarrative: latest?.analysis.narrative ?? null
    });
    await putSignal({
      kind: "alert",
      status: "stock-ready",
      alertId: `stock-ready:${symbol}`,
      payload: {
        symbol,
        annualCount: annualIncome.length,
        quarterlyCount: quarterlyIncome.length,
        latestNarrative: latest?.analysis.narrative ?? null
      },
      at: readyAt
    });

    return { symbol, annualCount: annualIncome.length, quarterlyCount: quarterlyIncome.length };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await markFailed(symbol, message);
    throw cause;
  }
}

async function fetchIncomeStatement(
  symbol: string,
  period: "annual" | "quarter",
  apiKey: string
): Promise<FmpIncomeStatement[]> {
  const url = new URL("https://financialmodelingprep.com/stable/income-statement");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("period", period);
  url.searchParams.set("limit", "400");
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`FMP income-statement ${period} request failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as FmpIncomeStatement[]) : [];
}

async function fetchCashFlowStatement(
  symbol: string,
  period: "annual" | "quarter",
  apiKey: string
): Promise<FmpCashFlowStatement[]> {
  const url = new URL("https://financialmodelingprep.com/stable/cash-flow-statement");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("period", period);
  url.searchParams.set("limit", "400");
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url);
  if (!response.ok) {
    console.error("FMP cash-flow request failed", { symbol, period, status: response.status });
    return [];
  }
  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as FmpCashFlowStatement[]) : [];
}

function buildRows(
  symbol: string,
  kind: "ANNUAL" | "QUARTER",
  income: FmpIncomeStatement[],
  cashFlow: FmpCashFlowStatement[]
): EarningsRow[] {
  const cashFlowByDate = new Map<string, FmpCashFlowStatement>();
  for (const entry of cashFlow) {
    if (entry.date) {
      cashFlowByDate.set(entry.date, entry);
    }
  }
  const sorted = [...income].sort((first, second) =>
    String(second.date ?? "").localeCompare(String(first.date ?? ""))
  );
  const rows: EarningsRow[] = [];
  const fetchedAt = nowIso();

  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = sorted[index + 1];
    const currentCash = cashFlowByDate.get(String(current.date ?? ""));
    const previousCash = previous ? cashFlowByDate.get(String(previous.date ?? "")) : undefined;
    rows.push(toEarningsRow(symbol, kind, current, currentCash, previous, previousCash, fetchedAt));
  }
  return rows;
}

function toEarningsRow(
  symbol: string,
  kind: "ANNUAL" | "QUARTER",
  income: FmpIncomeStatement,
  cashFlow: FmpCashFlowStatement | undefined,
  previousIncome: FmpIncomeStatement | undefined,
  previousCashFlow: FmpCashFlowStatement | undefined,
  fetchedAt: string
): EarningsRow {
  const reportDate = String(income.date ?? "");
  const analysis = analyze(income, cashFlow, previousIncome, previousCashFlow, kind);

  return {
    symbol,
    period: `${kind}#${reportDate || `${income.calendarYear ?? "UNKNOWN"}-${income.period ?? "X"}`}`,
    reportDate: reportDate || undefined,
    fiscalPeriod: income.period,
    calendarYear: income.calendarYear,
    reportedCurrency: income.reportedCurrency,
    revenue: numericOrUndefined(income.revenue),
    grossProfit: numericOrUndefined(income.grossProfit),
    operatingIncome: numericOrUndefined(income.operatingIncome),
    netIncome: numericOrUndefined(income.netIncome),
    eps: numericOrUndefined(income.eps),
    epsDiluted: numericOrUndefined(income.epsdiluted),
    analysis,
    source: "fmp",
    fetchedAt,
    raw: { income, ...(cashFlow ? { cashFlow } : {}) }
  };
}

function analyze(
  income: FmpIncomeStatement,
  cashFlow: FmpCashFlowStatement | undefined,
  previousIncome: FmpIncomeStatement | undefined,
  previousCashFlow: FmpCashFlowStatement | undefined,
  kind: "ANNUAL" | "QUARTER"
): EarningsAnalysis {
  const revenue = numericOrUndefined(income.revenue);
  const grossMargin = ratio(numericOrUndefined(income.grossProfit), revenue);
  const operatingMargin = ratio(numericOrUndefined(income.operatingIncome), revenue);
  const netMargin = ratio(numericOrUndefined(income.netIncome), revenue);

  const freeCashFlow = numericOrUndefined(cashFlow?.freeCashFlow);
  const operatingCashFlow = numericOrUndefined(
    cashFlow?.operatingCashFlow ?? cashFlow?.netCashProvidedByOperatingActivities
  );
  const capitalExpenditure = numericOrUndefined(cashFlow?.capitalExpenditure);
  const fcfMargin = ratio(freeCashFlow, revenue);
  const fcfConversion = ratio(freeCashFlow, numericOrUndefined(income.netIncome));

  const previousRevenue = numericOrUndefined(previousIncome?.revenue);
  const previousNetIncome = numericOrUndefined(previousIncome?.netIncome);
  const previousEps = numericOrUndefined(previousIncome?.eps);
  const previousGrossMargin = ratio(
    numericOrUndefined(previousIncome?.grossProfit),
    previousRevenue
  );
  const previousOperatingMargin = ratio(
    numericOrUndefined(previousIncome?.operatingIncome),
    previousRevenue
  );

  void previousCashFlow;

  return {
    grossMargin: roundPct(grossMargin),
    operatingMargin: roundPct(operatingMargin),
    netMargin: roundPct(netMargin),
    freeCashFlow,
    operatingCashFlow,
    capitalExpenditure,
    fcfMargin: roundPct(fcfMargin),
    fcfConversion: roundPct(fcfConversion),
    revenueGrowth: roundPct(growth(revenue, previousRevenue)),
    netIncomeGrowth: roundPct(growth(numericOrUndefined(income.netIncome), previousNetIncome)),
    epsGrowth: roundPct(growth(numericOrUndefined(income.eps), previousEps)),
    grossMarginDelta: roundPct(delta(grossMargin, previousGrossMargin)),
    operatingMarginDelta: roundPct(delta(operatingMargin, previousOperatingMargin)),
    narrative: narrate({
      kind,
      revenue,
      revenueGrowth: growth(revenue, previousRevenue),
      grossMargin,
      grossMarginDelta: delta(grossMargin, previousGrossMargin),
      operatingMargin,
      operatingMarginDelta: delta(operatingMargin, previousOperatingMargin),
      netMargin,
      fcfMargin,
      fcfConversion,
      epsGrowth: growth(numericOrUndefined(income.eps), previousEps)
    })
  };
}

function narrate(args: {
  kind: "ANNUAL" | "QUARTER";
  revenue?: number;
  revenueGrowth?: number;
  grossMargin?: number;
  grossMarginDelta?: number;
  operatingMargin?: number;
  operatingMarginDelta?: number;
  netMargin?: number;
  fcfMargin?: number;
  fcfConversion?: number;
  epsGrowth?: number;
}): string {
  const parts: string[] = [];
  const periodLabel = args.kind === "ANNUAL" ? "YoY" : "QoQ";

  if (args.revenueGrowth !== undefined) {
    const direction = args.revenueGrowth >= 0 ? "up" : "down";
    parts.push(`Revenue ${direction} ${pct(Math.abs(args.revenueGrowth))} ${periodLabel}`);
  } else if (args.revenue !== undefined) {
    parts.push("Revenue reported, no prior period for comparison");
  }

  if (args.operatingMarginDelta !== undefined && args.operatingMargin !== undefined) {
    const move =
      Math.abs(args.operatingMarginDelta) < 0.005
        ? "stable"
        : args.operatingMarginDelta > 0
          ? "expanding"
          : "compressing";
    parts.push(`operating margin ${move} to ${pct(args.operatingMargin)}`);
  } else if (args.operatingMargin !== undefined) {
    parts.push(`operating margin ${pct(args.operatingMargin)}`);
  }

  if (args.grossMarginDelta !== undefined && Math.abs(args.grossMarginDelta) > 0.01 && args.grossMargin !== undefined) {
    parts.push(
      `gross margin ${args.grossMarginDelta > 0 ? "up" : "down"} to ${pct(args.grossMargin)}`
    );
  }

  if (args.fcfConversion !== undefined) {
    const tag = args.fcfConversion >= 1 ? "strong" : args.fcfConversion >= 0.7 ? "healthy" : args.fcfConversion >= 0 ? "weak" : "negative";
    parts.push(`FCF conversion ${tag} at ${pct(args.fcfConversion)}`);
  } else if (args.fcfMargin !== undefined) {
    parts.push(`FCF margin ${pct(args.fcfMargin)}`);
  }

  if (args.epsGrowth !== undefined && Math.abs(args.epsGrowth) > 0.01) {
    parts.push(`EPS ${args.epsGrowth >= 0 ? "+" : ""}${pct(args.epsGrowth)} ${periodLabel}`);
  }

  if (parts.length === 0) {
    return "Insufficient comparable data to summarise.";
  }
  return `${capitalize(parts[0])}${parts.length > 1 ? `; ${parts.slice(1).join(", ")}` : ""}.`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ratio(numerator: number | undefined, denominator: number | undefined): number | undefined {
  if (numerator === undefined || denominator === undefined || denominator === 0) {
    return undefined;
  }
  return numerator / denominator;
}

function growth(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined || previous === 0) {
    return undefined;
  }
  return (current - previous) / Math.abs(previous);
}

function delta(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined) {
    return undefined;
  }
  return current - previous;
}

function roundPct(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.round(value * 10000) / 10000;
}

function numericOrUndefined(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  return Number.isFinite(value) ? value : undefined;
}

function pickLatest(quarterly: EarningsRow[], annual: EarningsRow[]): EarningsRow | undefined {
  const candidate = (rows: EarningsRow[]) =>
    [...rows].sort((first, second) =>
      String(second.reportDate ?? "").localeCompare(String(first.reportDate ?? ""))
    )[0];
  return candidate(quarterly) ?? candidate(annual);
}

async function batchPutEarnings(rows: EarningsRow[]): Promise<void> {
  for (let index = 0; index < rows.length; index += 25) {
    let requestItems: Record<string, { PutRequest: { Item: EarningsRow } }[]> = {
      [Resource.Earnings.name]: rows.slice(index, index + 25).map((row) => ({
        PutRequest: { Item: row }
      }))
    };

    do {
      const response = await documentClient.send(
        new BatchWriteCommand({
          RequestItems: requestItems
        })
      );
      requestItems = (response.UnprocessedItems ?? {}) as typeof requestItems;
    } while (requestItems?.[Resource.Earnings.name]?.length);
  }
}

async function markFailed(symbol: string, message: string): Promise<void> {
  try {
    await documentClient.send(
      new UpdateCommand({
        TableName: Resource.Stocks.name,
        Key: { symbol },
        UpdateExpression: "SET processingState = :state, processingError = :err, updatedAt = :now",
        ExpressionAttributeValues: {
          ":state": "process_failed",
          ":err": message,
          ":now": nowIso()
        }
      })
    );
    await publishEvent(STOCK_PROCESS_FAILED_ACTION, {
      action: STOCK_PROCESS_FAILED_ACTION,
      symbol,
      error: message
    });
  } catch (cause) {
    console.error("failed to mark stock failed", { symbol, cause });
  }
}
