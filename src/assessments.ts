import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { cleanSymbol, error, json, nowIso, parseJsonBody, requireBearerToken } from "./http";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export type Precondition = {
  code: string;
  description: string;
};

export type AssessmentNarrative = {
  id: string;
  name: string;
  icon: string;
  description: string;
  example?: string;
  stages?: Array<{ id: string; name: string; example?: string }>;
  valuationLevers: string[];
  promptTemplate: string;
};

export type AssessmentStrategy = {
  id: string;
  name: string;
  icon: string;
  model: string;
  description: string;
  basePrompt: string;
  preconditions: Precondition[];
  narratives: AssessmentNarrative[];
};

const DEFAULT_MODEL = "claude-opus-4-7";

const VALUE_STRATEGY: AssessmentStrategy = {
  id: "value",
  name: "Value Investing Assessment",
  icon: "📊",
  model: DEFAULT_MODEL,
  description:
    "Identify profitable businesses where sentiment has overcorrected the price relative to the durable cash-flow base.",
  basePrompt: [
    "You are a value-investing analyst. Evaluate the stock against the strategy preconditions and the selected narrative.",
    "Cite specific numbers from the stock context. Be explicit when a precondition is unmet.",
    "Output: precondition checklist (met/unmet with evidence), narrative fit (1-5), valuation range, key risks, action."
  ].join(" "),
  preconditions: [
    { code: "PROFITABLE", description: "Currently profitable with real cash flows" },
    { code: "PRICE_DECLINE", description: "Stock price significantly declined from a previously stable level" },
    { code: "SENTIMENT_DRIVEN", description: "Decline is sentiment-driven, not fundamentals-driven" },
    { code: "CASH_FLOW_STABLE", description: "Cash flows stable or growing" },
    { code: "NO_STRUCTURAL_THREAT", description: "No structural threat to the business model" }
  ],
  narratives: [
    {
      id: "sentiment-overcorrection",
      name: "Sentiment Overcorrection on Profitable Business",
      icon: "💰",
      description:
        "A profitable business has been re-rated lower on sentiment despite stable or growing cash flows.",
      example: "SFM — DCF · EV/EBITDA · P/FCF",
      valuationLevers: ["DCF", "EV/EBITDA", "P/FCF"],
      promptTemplate: [
        "Narrative: Sentiment Overcorrection on Profitable Business.",
        "Triangulate fair value using DCF, EV/EBITDA, and P/FCF.",
        "State the implied upside vs current price and the catalyst that re-rates sentiment."
      ].join(" ")
    }
  ]
};

const CATALYST_STRATEGY: AssessmentStrategy = {
  id: "catalyst",
  name: "Catalyst-Based Assessment",
  icon: "🚀",
  model: DEFAULT_MODEL,
  description:
    "Identify pre-profitable businesses where revenue growth, narrowing losses, and operating leverage are converging on an EPS crossover.",
  basePrompt: [
    "You are a growth-and-catalyst analyst. Evaluate the stock against the strategy preconditions and the selected narrative.",
    "Cite trends from the last 4–8 quarters. Flag any one-time items inflating the trajectory.",
    "Output: precondition checklist (met/unmet with evidence), narrative fit (1-5), stage placement, time-to-crossover, re-rating thesis, risks, action."
  ].join(" "),
  preconditions: [
    { code: "REVENUE_GROWING", description: "Revenue growing consistently" },
    { code: "EPS_NARROWING", description: "EPS losses narrowing directionally" },
    { code: "GROSS_MARGIN_STABLE", description: "Gross margin stable or expanding" },
    { code: "OPERATING_LEVERAGE", description: "Operating leverage demonstrable" },
    { code: "NO_ONE_TIME_ITEMS", description: "No one-time items masking trajectory" },
    { code: "BALANCE_SHEET_SURVIVES", description: "Balance sheet survives until crossover" }
  ],
  narratives: [
    {
      id: "eps-crossover",
      name: "EPS Crossover — Loss to Profit Turnaround",
      icon: "⚡",
      description:
        "A business approaching or just past EPS crossover, where the market is expected to re-rate the multiple as profitability arrives.",
      example: "TBLA at crossover · TYGO pre-crossover",
      stages: [
        { id: "pre", name: "Pre-Crossover", example: "TYGO" },
        { id: "at", name: "At Crossover", example: "TBLA Q1 2026" },
        { id: "post", name: "Post-Crossover", example: "Multiple re-rating" }
      ],
      valuationLevers: ["EV/Sales → forward P/E bridge", "Operating leverage model", "Crossover quarter estimate"],
      promptTemplate: [
        "Narrative: EPS Crossover — Loss to Profit Turnaround.",
        "Place the stock in one of: Pre-Crossover, At Crossover, Post-Crossover.",
        "Estimate quarters-to-crossover, the multiple re-rating path, and risk to thesis."
      ].join(" ")
    }
  ]
};

const STRATEGIES: AssessmentStrategy[] = [VALUE_STRATEGY, CATALYST_STRATEGY];
const STRATEGY_INDEX = new Map(STRATEGIES.map((strategy) => [strategy.id, strategy]));

type StockRow = {
  symbol: string;
  name?: string;
  sector?: string;
  industry?: string;
  exchange?: string;
  currency?: string;
  price?: number;
  priceAsOf?: string;
  returns?: Record<string, number | string | undefined>;
  fundamentals?: Record<string, number | undefined>;
  margins?: Record<string, number | undefined>;
};

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) return unauthorized;

  return json({
    count: STRATEGIES.length,
    strategies: STRATEGIES.map(toSummary)
  });
}

export async function get(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) return unauthorized;

  const strategy = STRATEGY_INDEX.get(String(event.pathParameters?.strategy ?? "").trim().toLowerCase());
  if (!strategy) return error("Strategy not found.", 404);

  return json({ strategy });
}

export async function assess(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) return unauthorized;

  const strategyId = String(event.pathParameters?.strategy ?? "").trim().toLowerCase();
  const narrativeId = String(event.pathParameters?.narrative ?? "").trim().toLowerCase();

  const strategy = STRATEGY_INDEX.get(strategyId);
  if (!strategy) return error("Strategy not found.", 404);

  const narrative = strategy.narratives.find((entry) => entry.id === narrativeId);
  if (!narrative) return error("Narrative not found.", 404);

  let body: unknown;
  try {
    body = parseJsonBody(event);
  } catch {
    return error("Request body must be valid JSON.");
  }

  const stockInput = extractStockInput(body);
  if (!stockInput) return error("Body must include `stock` (object) or `symbol` (string).");

  const stock = await resolveStock(stockInput);
  if (!stock) return error("Stock not found.", 404);

  const renderedPrompt = renderPrompt(strategy, narrative, stock);

  return json({
    generatedAt: nowIso(),
    strategy: { id: strategy.id, name: strategy.name, model: strategy.model },
    narrative: { id: narrative.id, name: narrative.name },
    stock: {
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      industry: stock.industry,
      price: stock.price,
      priceAsOf: stock.priceAsOf
    },
    preconditions: strategy.preconditions,
    prompt: renderedPrompt,
    status: "prepared",
    note: "LLM execution not wired; this response returns the rendered prompt and stock context ready for inference."
  });
}

function toSummary(strategy: AssessmentStrategy) {
  return {
    id: strategy.id,
    name: strategy.name,
    icon: strategy.icon,
    model: strategy.model,
    description: strategy.description,
    preconditionCount: strategy.preconditions.length,
    narratives: strategy.narratives.map((narrative) => ({
      id: narrative.id,
      name: narrative.name,
      icon: narrative.icon
    }))
  };
}

function extractStockInput(body: unknown): { symbol?: string; row?: StockRow } | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (record.stock && typeof record.stock === "object") {
    const row = record.stock as StockRow;
    if (typeof row.symbol === "string" && row.symbol.trim()) {
      return { row: { ...row, symbol: cleanSymbol(row.symbol) } };
    }
  }
  if (typeof record.symbol === "string" && record.symbol.trim()) {
    return { symbol: cleanSymbol(record.symbol) };
  }
  return null;
}

async function resolveStock(input: { symbol?: string; row?: StockRow }): Promise<StockRow | undefined> {
  if (input.row) {
    const stored = await fetchStock(input.row.symbol);
    return stored ? { ...stored, ...input.row } : input.row;
  }
  if (!input.symbol) return undefined;
  return fetchStock(input.symbol);
}

async function fetchStock(symbol: string): Promise<StockRow | undefined> {
  const response = await documentClient.send(
    new GetCommand({ TableName: Resource.Stocks.name, Key: { symbol } })
  );
  return response.Item as StockRow | undefined;
}

function renderPrompt(strategy: AssessmentStrategy, narrative: AssessmentNarrative, stock: StockRow): string {
  const preconditionList = strategy.preconditions
    .map((entry) => `- [${entry.code}] ${entry.description}`)
    .join("\n");
  const stockContext = JSON.stringify(
    {
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      industry: stock.industry,
      price: stock.price,
      priceAsOf: stock.priceAsOf,
      returns: stock.returns,
      fundamentals: stock.fundamentals,
      margins: stock.margins
    },
    null,
    2
  );
  return [
    strategy.basePrompt,
    "",
    narrative.promptTemplate,
    "",
    "Preconditions to evaluate:",
    preconditionList,
    "",
    `Valuation levers: ${narrative.valuationLevers.join(", ")}`,
    "",
    "Stock context:",
    stockContext
  ].join("\n");
}
