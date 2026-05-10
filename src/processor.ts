import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { publishEvent } from "./events";
import { cleanSymbol, nowIso } from "./http";
import { processMacd } from "./macd";

const STOCK_DATA_PULLED_ACTION = "STCO_DATA_PULLED";
const STOCK_PROCESS_FAILED_ACTION = "STCO_PROCESS_FAILED";

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
  source: "fmp";
  fetchedAt: string;
  raw: FmpIncomeStatement;
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

  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    await markFailed(symbol, "FMP_API_KEY is not configured.");
    throw new Error("FMP_API_KEY is not configured.");
  }

  try {
    const [annual, quarterly] = await Promise.all([
      fetchIncomeStatement(symbol, "annual", apiKey),
      fetchIncomeStatement(symbol, "quarter", apiKey)
    ]);

    const rows: EarningsRow[] = [
      ...annual.map((report) => toEarningsRow(symbol, "ANNUAL", report)),
      ...quarterly.map((report) => toEarningsRow(symbol, "QUARTER", report))
    ];

    if (rows.length > 0) {
      await batchPutEarnings(rows);
    }

    await documentClient.send(
      new UpdateCommand({
        TableName: Resource.Stocks.name,
        Key: { symbol },
        UpdateExpression:
          "SET processingState = :state, dataPulledAt = :now, updatedAt = :now, annualReportCount = :annualCount, quarterlyReportCount = :quarterlyCount",
        ExpressionAttributeValues: {
          ":state": "data_pulled",
          ":now": nowIso(),
          ":annualCount": annual.length,
          ":quarterlyCount": quarterly.length
        }
      })
    );

    try {
      await processMacd({ symbol });
    } catch (cause) {
      console.error("on-enter MACD processing failed", { symbol, cause });
    }

    await publishEvent(STOCK_DATA_PULLED_ACTION, {
      action: STOCK_DATA_PULLED_ACTION,
      symbol,
      annualCount: annual.length,
      quarterlyCount: quarterly.length
    });

    return { symbol, annualCount: annual.length, quarterlyCount: quarterly.length };
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
  const url = new URL(`https://financialmodelingprep.com/api/v3/income-statement/${encodeURIComponent(symbol)}`);
  url.searchParams.set("period", period);
  url.searchParams.set("limit", "400");
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`FMP income-statement ${period} request failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as unknown;
  if (!Array.isArray(data)) {
    return [];
  }
  return data as FmpIncomeStatement[];
}

function toEarningsRow(symbol: string, kind: "ANNUAL" | "QUARTER", report: FmpIncomeStatement): EarningsRow {
  const reportDate = String(report.date ?? "");
  return {
    symbol,
    period: `${kind}#${reportDate || `${report.calendarYear ?? "UNKNOWN"}-${report.period ?? "X"}`}`,
    reportDate: reportDate || undefined,
    fiscalPeriod: report.period,
    calendarYear: report.calendarYear,
    reportedCurrency: report.reportedCurrency,
    revenue: numericOrUndefined(report.revenue),
    grossProfit: numericOrUndefined(report.grossProfit),
    operatingIncome: numericOrUndefined(report.operatingIncome),
    netIncome: numericOrUndefined(report.netIncome),
    eps: numericOrUndefined(report.eps),
    epsDiluted: numericOrUndefined(report.epsdiluted),
    source: "fmp",
    fetchedAt: nowIso(),
    raw: report
  };
}

function numericOrUndefined(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  return Number.isFinite(value) ? value : undefined;
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
