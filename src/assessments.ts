import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { cleanSymbol, error, json, nowIso, parseJsonBody, requireBearerToken } from "./http";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const MIN_QUARTERS_FOR_DEPTH = 4;
const QUARTER_FETCH_LIMIT = 8;

export type Precondition = {
  code: string;
  description: string;
};

export type AssessmentNarrative = {
  id: string;
  name: string;
  icon: string;
  description: string;
  /** Verbatim narrative story; rendered into the prompt under `## Narrative`. */
  story: string;
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
        "Sentiment-driven sell-off of a profitable business whose cash flows never deteriorated; mean reversion to fair value is the return mechanism.",
      story: [
        "💰 Narrative — Sentiment Overcorrection on a Profitable Business",
        "(Assessment Type: Value Investing)",
        "",
        "The story: A fundamentally healthy, cash-generating business gets sold off heavily due to sentiment, macro fear,",
        "or short-term disappointment — not because the underlying economics broke. The stock price detaches from intrinsic value.",
        "A DCF or cash flow multiple reveals the gap. Mean reversion to fair value is the return mechanism.",
        "",
        "Example: SFM — profitable, growing, but stock dropped ~59% on sentiment. Cash flows never deteriorated."
      ].join("\n"),
      example: "SFM — profitable, growing, but stock dropped ~59% on sentiment. Cash flows never deteriorated.",
      valuationLevers: ["DCF", "EV/EBITDA", "P/FCF"],
      promptTemplate: [
        "Narrative: Sentiment Overcorrection on Profitable Business.",
        "Confirm cash flows are stable or growing while price has detached.",
        "Triangulate fair value using DCF, EV/EBITDA, and P/FCF.",
        "State the implied upside vs current price and the catalyst that resets sentiment toward fair value."
      ].join(" ")
    },
    {
      id: "quality-derating",
      name: "Quality Compounder De-Rating",
      icon: "🏰",
      description:
        "A durable, high-return compounder whose multiple compressed on a growth scare or factor rotation while the underlying economics stayed intact; re-rating back toward its historical multiple band is the return mechanism.",
      story: [
        "🏰 Narrative — Quality Compounder De-Rating",
        "(Assessment Type: Value Investing)",
        "",
        "The story: A high-quality business — wide moat, high returns on capital, consistent free cash flow — gets de-rated",
        "because growth decelerated for a quarter or two, a factor rotation pushed money out of quality, or a temporary margin",
        "wobble spooked the market. The compounding engine is intact; only the multiple compressed. The gap shows up as a P/E or",
        "EV/EBIT well below the company's own multi-year average despite an unchanged competitive position. Re-rating back toward",
        "the historical band, on top of continued compounding, is the return mechanism.",
        "",
        "Example: a 20%+ ROIC franchise that fell from ~28x to ~17x forward earnings on a single soft guide, with the moat untouched."
      ].join("\n"),
      example: "A 20%+ ROIC franchise de-rated from ~28x to ~17x forward earnings on one soft guide — moat and reinvestment runway intact.",
      valuationLevers: ["Forward P/E vs own 5y band", "EV/EBIT", "ROIC × reinvestment runway"],
      promptTemplate: [
        "Narrative: Quality Compounder De-Rating.",
        "Establish that returns on capital and the moat are intact and that the de-rate is multiple-driven, not earnings-driven.",
        "Compare the current multiple to the company's own multi-year average band and quantify the re-rating upside plus continued compounding.",
        "State what reset the multiple and what would re-rate it."
      ].join(" ")
    },
    {
      id: "cyclical-trough",
      name: "Cyclical Trough Mispricing",
      icon: "🔄",
      description:
        "A cyclical business near the bottom of its cycle where the market extrapolates depressed trough earnings as permanent; normalized mid-cycle earnings power reveals the mispricing and normalization is the return mechanism.",
      story: [
        "🔄 Narrative — Cyclical Trough Mispricing",
        "(Assessment Type: Value Investing)",
        "",
        "The story: A cyclical company — commodities, semis, housing, freight, memory — is near a cyclical trough. Earnings are",
        "depressed or briefly negative, headlines are bleak, and the market capitalizes trough EPS as if it were permanent. The",
        "error is extrapolation: pricing the worst point of the cycle into perpetuity. Normalized mid-cycle earnings power,",
        "replacement value, or through-cycle free cash flow reveal the gap. The return mechanism is normalization as the cycle turns.",
        "Counter-intuitively, a cyclical can look 'expensive' on trough P/E precisely when it is cheapest on normalized earnings.",
        "",
        "Three stages:",
        "- Down-Cycle — earnings falling, estimates still being cut",
        "- Trough — earnings depressed/negative, inventories peaking, sentiment capitulating",
        "- Early Recovery — orders/pricing inflecting, estimates beginning to rise",
        "",
        "Example: a semi-cap or memory name trading near tangible book at the bottom of an inventory cycle, with mid-cycle EPS multiples higher than trough."
      ].join("\n"),
      example: "A cyclical trading near tangible book at the bottom of an inventory cycle — trough EPS depressed, normalized mid-cycle earnings several times higher.",
      stages: [
        { id: "downcycle", name: "Down-Cycle", example: "Earnings falling, estimates still being cut" },
        { id: "trough", name: "Trough", example: "Earnings depressed/negative, inventories peaking, sentiment capitulating" },
        { id: "recovery", name: "Early Recovery", example: "Orders/pricing inflecting, estimates beginning to rise" }
      ],
      valuationLevers: ["Normalized mid-cycle EPS", "Price/tangible book vs cycle", "Through-cycle FCF / replacement value"],
      promptTemplate: [
        "Narrative: Cyclical Trough Mispricing.",
        "Place the stock in the cycle (Down-Cycle, Trough, Early Recovery) and avoid valuing it on trough EPS alone.",
        "Estimate normalized mid-cycle earnings power and value off that, cross-checked against price/tangible book versus prior cycle lows.",
        "Identify the indicator that signals the cycle is turning and the risk that the trough deepens or extends."
      ].join(" ")
    },
    {
      id: "capital-return",
      name: "Underappreciated Capital Return",
      icon: "💸",
      description:
        "A profitable, cash-generative business steadily shrinking its share count and/or growing its dividend at a high free-cash-flow yield the market is ignoring; buyback-driven EPS accretion plus yield is the return mechanism.",
      story: [
        "💸 Narrative — Underappreciated Capital Return",
        "(Assessment Type: Value Investing)",
        "",
        "The story: A mature, profitable business throws off far more free cash flow than the market is paying for. Management",
        "returns it aggressively — buying back a meaningful share of the float each year and/or compounding the dividend — yet the",
        "stock trades at a high FCF yield because the story is 'boring' or growth is modest. Each buyback at a depressed price is",
        "accretive: shrinking the share count lifts per-share earnings and ownership even with flat net income. The return mechanism",
        "is FCF yield plus the mechanical EPS accretion of the shrink, with optional re-rating if the market re-discovers the cash machine.",
        "",
        "Example: a steady cash generator at a low-double-digit FCF yield retiring ~5%+ of shares a year while growing its dividend."
      ].join("\n"),
      example: "A steady cash generator at a low-double-digit FCF yield retiring ~5%+ of its float annually while compounding the dividend.",
      valuationLevers: ["FCF yield", "Buyback-adjusted EPS accretion", "Shareholder yield (buyback + dividend)"],
      promptTemplate: [
        "Narrative: Underappreciated Capital Return.",
        "Quantify free-cash-flow yield, net buyback pace (share-count change), and dividend growth to derive total shareholder yield.",
        "Show the per-share accretion from continued buybacks at the current price and the downside protection the cash return provides.",
        "Flag any risk that the capital return is debt-funded or unsustainable versus FCF."
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
        "Loss-to-profit EPS crossover where the market is forced to re-rate from a revenue multiple onto an earnings multiple.",
      story: [
        "⚡ Narrative — EPS Crossover: Loss to Profit Turnaround",
        "(Assessment Type: Catalyst-Based)",
        "",
        "The story: A loss-making company with growing revenue and narrowing EPS losses approaches zero and crosses into profitability.",
        "The market, which had been pricing it on a compressed revenue multiple, is forced to re-classify and re-rate it onto an earnings multiple.",
        "The crossover moment — especially when it beats a negative consensus — triggers disproportionate price reaction.",
        "",
        "Three stages:",
        "- Pre-Crossover — losses narrowing, not yet profitable (e.g. TYGO)",
        "- At Crossover — first positive EPS print, consensus beat (e.g. TBLA Q1 2026)",
        "- Post-Crossover — sustained profitability, multiple expansion continues",
        "",
        "Example: TBLA — EPS went -$0.08 → -$0.03 → +$0.20, stock surged 37% in one session."
      ].join("\n"),
      example: "TBLA — EPS went -$0.08 → -$0.03 → +$0.20, stock surged 37% in one session.",
      stages: [
        { id: "pre", name: "Pre-Crossover", example: "TYGO — losses narrowing, not yet profitable" },
        { id: "at", name: "At Crossover", example: "TBLA Q1 2026 — first positive EPS print, consensus beat" },
        { id: "post", name: "Post-Crossover", example: "Sustained profitability, multiple expansion continues" }
      ],
      valuationLevers: ["EV/Sales → forward P/E bridge", "Operating leverage model", "Crossover quarter estimate"],
      promptTemplate: [
        "Narrative: EPS Crossover — Loss to Profit Turnaround.",
        "Place the stock in one of: Pre-Crossover, At Crossover, Post-Crossover.",
        "Estimate quarters-to-crossover, the multiple re-rating path from revenue-multiple to earnings-multiple, and risk to thesis."
      ].join(" ")
    },
    {
      id: "margin-inflection",
      name: "Margin Inflection — Operating Leverage Unlock",
      icon: "📈",
      description:
        "An already-profitable, revenue-growing business hitting the scale point where a heavy fixed-cost base converts incremental revenue into disproportionate margin and EPS expansion ahead of consensus; upward estimate revisions are the return mechanism.",
      story: [
        "📈 Narrative — Margin Inflection: Operating Leverage Unlock",
        "(Assessment Type: Catalyst-Based)",
        "",
        "The story: A company has spent years building a fixed-cost base — platform, R&D, salesforce, infrastructure — and is now",
        "growing revenue on top of it. Past the scale point, incremental revenue drops to the operating line at a high rate, so",
        "margins expand far faster than revenue and EPS compounds non-linearly. Consensus typically straight-lines historical",
        "margins and misses the inflection. The crossover here is not loss-to-profit but a step-change in incremental margins;",
        "the return mechanism is upward estimate revisions as reported margins outrun the model.",
        "",
        "Three stages:",
        "- Pre-Inflection — revenue growing, margins flattish, fixed costs still being absorbed",
        "- At Inflection — incremental margins jump, first quarters of clear operating leverage, estimate revisions start",
        "- Post-Inflection — operating leverage sustained, multiple expands as the market extrapolates the new margin trajectory",
        "",
        "Example: a scaled software or platform business whose incremental operating margin steps from the teens toward 40%+ as opex growth lags revenue."
      ].join("\n"),
      example: "A scaled platform whose incremental operating margin steps from the teens toward 40%+ as opex growth lags revenue growth.",
      stages: [
        { id: "pre", name: "Pre-Inflection", example: "Revenue growing, margins flat, fixed costs still absorbed" },
        { id: "at", name: "At Inflection", example: "Incremental margins jump, estimate revisions begin" },
        { id: "post", name: "Post-Inflection", example: "Operating leverage sustained, multiple expansion" }
      ],
      valuationLevers: ["Incremental operating margin", "Opex growth vs revenue growth", "Forward EPS on normalized margins"],
      promptTemplate: [
        "Narrative: Margin Inflection — Operating Leverage Unlock.",
        "Place the stock in Pre-Inflection, At Inflection, or Post-Inflection and confirm revenue growth is outpacing opex growth.",
        "Estimate the incremental operating margin and the forward EPS it implies versus consensus, and the re-rating from rising estimates.",
        "Flag the risk that management re-invests the leverage away or that growth decelerates before the fixed base is absorbed."
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

type EarningsAnalysis = {
  grossMargin?: number;
  operatingMargin?: number;
  netMargin?: number;
  freeCashFlow?: number;
  fcfMargin?: number;
  revenueGrowth?: number;
  epsGrowth?: number;
  operatingMarginDelta?: number;
  grossMarginDelta?: number;
};

type EarningsRow = {
  symbol: string;
  period: string;
  reportDate?: string;
  fiscalPeriod?: string;
  revenue?: number;
  eps?: number;
  epsDiluted?: number;
  analysis?: EarningsAnalysis;
};

type PreconditionStatus = "met" | "unmet" | "unknown";

type PreconditionResult = {
  code: string;
  description: string;
  status: PreconditionStatus;
  evidence: string;
};

type DepthReport = {
  quartersAvailable: number;
  quartersRequired: number;
  sufficient: boolean;
};

type Eligibility = {
  eligible: boolean;
  depth: DepthReport;
  preconditionsMet: number;
  preconditionsTotal: number;
  passRatio: number;
  reasons: string[];
  suggestedAlternative?: { strategy: string; narrative: string; reason: string };
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

  const quarters = await fetchQuarterlyEarnings(stock.symbol, QUARTER_FETCH_LIMIT);
  const preconditionResults = evaluatePreconditions(strategy, stock, quarters);
  const eligibility = computeEligibility(strategy, narrative, stock, quarters, preconditionResults);
  const renderedPrompt = renderPrompt(strategy, narrative, stock, quarters, preconditionResults, eligibility);

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
    preconditions: preconditionResults,
    eligibility,
    prompt: renderedPrompt,
    status: eligibility.eligible ? "prepared" : "ineligible",
    note: eligibility.eligible
      ? "LLM execution not wired; this response returns the rendered prompt and stock context ready for inference."
      : "Stock did not meet the strategy's preconditions or lacks the fundamental depth required. See `eligibility.suggestedAlternative`."
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

function renderPrompt(
  strategy: AssessmentStrategy,
  narrative: AssessmentNarrative,
  stock: StockRow,
  quarters: EarningsRow[],
  preconditionResults: PreconditionResult[],
  eligibility: Eligibility
): string {
  const preconditionLines = preconditionResults
    .map((entry) => `- [${entry.code}] (${entry.status.toUpperCase()}) ${entry.description} — ${entry.evidence}`)
    .join("\n");
  const epsSeries = quarters
    .slice(0, MIN_QUARTERS_FOR_DEPTH * 2)
    .map((row) => `${row.reportDate ?? row.period}: EPS ${formatNumber(row.eps)}, Rev ${formatNumber(row.revenue)}, RevGrowth ${formatPct(row.analysis?.revenueGrowth)}`)
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
    "## Narrative",
    narrative.story,
    "",
    "## Task",
    narrative.promptTemplate,
    "",
    "## Eligibility",
    `Depth: ${eligibility.depth.quartersAvailable}/${eligibility.depth.quartersRequired} quarters available (${eligibility.depth.sufficient ? "sufficient" : "insufficient"}).`,
    `Preconditions met: ${eligibility.preconditionsMet}/${eligibility.preconditionsTotal} (pass ratio ${eligibility.passRatio.toFixed(2)}).`,
    eligibility.eligible ? "Stock is eligible — proceed with the assessment." : `Stock is NOT eligible for this narrative: ${eligibility.reasons.join("; ")}.`,
    eligibility.suggestedAlternative
      ? `Suggested alternative: ${eligibility.suggestedAlternative.strategy}/${eligibility.suggestedAlternative.narrative} (${eligibility.suggestedAlternative.reason}).`
      : "",
    "",
    "## Preconditions (evaluated)",
    preconditionLines,
    "",
    `## Valuation levers: ${narrative.valuationLevers.join(", ")}`,
    "",
    "## Quarterly history (most recent first)",
    epsSeries || "(no quarterly history available)",
    "",
    "## Stock context",
    stockContext
  ].filter(Boolean).join("\n");
}

async function fetchQuarterlyEarnings(symbol: string, limit: number): Promise<EarningsRow[]> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.Earnings.name,
      KeyConditionExpression: "symbol = :symbol AND begins_with(#period, :prefix)",
      ExpressionAttributeNames: { "#period": "period" },
      ExpressionAttributeValues: { ":symbol": symbol, ":prefix": "QUARTER#" },
      ScanIndexForward: false,
      Limit: limit
    })
  );
  return (response.Items ?? []) as EarningsRow[];
}

function evaluatePreconditions(
  strategy: AssessmentStrategy,
  stock: StockRow,
  quarters: EarningsRow[]
): PreconditionResult[] {
  return strategy.preconditions.map((entry) => {
    const check = PRECONDITION_CHECKS[entry.code];
    if (!check) {
      return { code: entry.code, description: entry.description, status: "unknown", evidence: "no automated check; LLM must evaluate qualitatively" };
    }
    const verdict = check(stock, quarters);
    return { code: entry.code, description: entry.description, ...verdict };
  });
}

type CheckResult = { status: PreconditionStatus; evidence: string };
type CheckFn = (stock: StockRow, quarters: EarningsRow[]) => CheckResult;

const PRECONDITION_CHECKS: Record<string, CheckFn> = {
  PROFITABLE: (stock, quarters) => {
    const eps = numberFrom(stock.fundamentals?.epsTtm) ?? numberFrom(stock.fundamentals?.eps) ?? latestEps(quarters);
    if (eps === undefined) return { status: "unknown", evidence: "no EPS data" };
    return eps > 0
      ? { status: "met", evidence: `EPS ${eps.toFixed(2)} > 0` }
      : { status: "unmet", evidence: `EPS ${eps.toFixed(2)} ≤ 0` };
  },
  PRICE_DECLINE: (stock) => {
    const y1 = numberFrom(stock.returns?.y1);
    const m6 = numberFrom(stock.returns?.m6);
    const worst = [y1, m6].filter((value): value is number => typeof value === "number").sort((a, b) => a - b)[0];
    if (worst === undefined) return { status: "unknown", evidence: "no return windows available" };
    return worst <= -20
      ? { status: "met", evidence: `drawdown ${worst.toFixed(1)}% over the worst tracked window (y1/m6)` }
      : { status: "unmet", evidence: `worst window return ${worst.toFixed(1)}% — does not clear -20% threshold` };
  },
  SENTIMENT_DRIVEN: () => ({ status: "unknown", evidence: "qualitative — defer to LLM judgment on news/pulse context" }),
  CASH_FLOW_STABLE: (_stock, quarters) => {
    const fcfs = quarters.map((row) => row.analysis?.freeCashFlow).filter((value): value is number => typeof value === "number");
    if (fcfs.length < 2) return { status: "unknown", evidence: "fewer than 2 quarters of FCF data" };
    const positive = fcfs.filter((value) => value > 0).length;
    return positive >= Math.ceil(fcfs.length * 0.75)
      ? { status: "met", evidence: `${positive}/${fcfs.length} recent quarters show positive FCF` }
      : { status: "unmet", evidence: `only ${positive}/${fcfs.length} recent quarters show positive FCF` };
  },
  NO_STRUCTURAL_THREAT: () => ({ status: "unknown", evidence: "qualitative — defer to LLM judgment on business model" }),

  REVENUE_GROWING: (_stock, quarters) => {
    const growth = quarters.map((row) => row.analysis?.revenueGrowth).filter((value): value is number => typeof value === "number");
    if (growth.length < 2) return { status: "unknown", evidence: "fewer than 2 quarters with revenue-growth data" };
    const positive = growth.slice(0, 4).filter((value) => value > 0).length;
    const sample = Math.min(4, growth.length);
    return positive >= Math.ceil(sample * 0.75)
      ? { status: "met", evidence: `revenue growth positive in ${positive}/${sample} of the last quarters` }
      : { status: "unmet", evidence: `revenue growth positive in only ${positive}/${sample} of the last quarters` };
  },
  EPS_NARROWING: (_stock, quarters) => {
    const series = quarters.slice(0, MIN_QUARTERS_FOR_DEPTH).map((row) => row.eps).filter((value): value is number => typeof value === "number");
    if (series.length < 2) return { status: "unknown", evidence: "fewer than 2 quarters with EPS data" };
    const recent = series[0];
    const older = series[series.length - 1];
    if (recent > 0 && older < 0) return { status: "met", evidence: `EPS crossed zero (${older.toFixed(2)} → ${recent.toFixed(2)})` };
    if (recent < 0 && Math.abs(recent) < Math.abs(older)) {
      return { status: "met", evidence: `loss narrowing (${older.toFixed(2)} → ${recent.toFixed(2)})` };
    }
    if (recent > 0 && older > 0) return { status: "unmet", evidence: `already profitable across the window (${older.toFixed(2)} → ${recent.toFixed(2)}) — not a loss-narrowing setup` };
    return { status: "unmet", evidence: `EPS not narrowing (${older.toFixed(2)} → ${recent.toFixed(2)})` };
  },
  GROSS_MARGIN_STABLE: (_stock, quarters) => {
    const series = quarters.map((row) => row.analysis?.grossMargin).filter((value): value is number => typeof value === "number");
    if (series.length < 2) return { status: "unknown", evidence: "fewer than 2 quarters of gross-margin data" };
    const recent = series[0];
    const older = series[series.length - 1];
    return recent + 0.5 >= older
      ? { status: "met", evidence: `gross margin stable/expanding (${older.toFixed(1)}% → ${recent.toFixed(1)}%)` }
      : { status: "unmet", evidence: `gross margin compressing (${older.toFixed(1)}% → ${recent.toFixed(1)}%)` };
  },
  OPERATING_LEVERAGE: (_stock, quarters) => {
    const deltas = quarters.map((row) => row.analysis?.operatingMarginDelta).filter((value): value is number => typeof value === "number");
    if (deltas.length === 0) return { status: "unknown", evidence: "no operating-margin-delta data" };
    const positive = deltas.filter((value) => value > 0).length;
    return positive >= Math.ceil(deltas.length / 2)
      ? { status: "met", evidence: `operating margin expanding in ${positive}/${deltas.length} of the last quarters` }
      : { status: "unmet", evidence: `operating margin expanding in only ${positive}/${deltas.length} of the last quarters` };
  },
  NO_ONE_TIME_ITEMS: () => ({ status: "unknown", evidence: "qualitative — defer to LLM judgment on filings" }),
  BALANCE_SHEET_SURVIVES: () => ({ status: "unknown", evidence: "qualitative — requires balance-sheet data not in stock row" })
};

function computeEligibility(
  strategy: AssessmentStrategy,
  narrative: AssessmentNarrative,
  stock: StockRow,
  quarters: EarningsRow[],
  results: PreconditionResult[]
): Eligibility {
  const depth: DepthReport = {
    quartersAvailable: quarters.length,
    quartersRequired: MIN_QUARTERS_FOR_DEPTH,
    sufficient: quarters.length >= MIN_QUARTERS_FOR_DEPTH
  };
  const met = results.filter((result) => result.status === "met").length;
  const unmet = results.filter((result) => result.status === "unmet").length;
  const total = results.length;
  const evaluable = met + unmet;
  const passRatio = evaluable === 0 ? 0 : met / evaluable;

  const reasons: string[] = [];
  let eligible = true;

  if (strategy.id === "catalyst") {
    if (!depth.sufficient) {
      eligible = false;
      reasons.push(`requires ≥${depth.quartersRequired} quarters of earnings history (have ${depth.quartersAvailable})`);
    }
    const revGrowing = results.find((result) => result.code === "REVENUE_GROWING");
    if (revGrowing?.status === "unmet") {
      eligible = false;
      reasons.push(`REVENUE_GROWING unmet — ${revGrowing.evidence}`);
    }
    if (narrative.id === "eps-crossover") {
      const epsNarrowing = results.find((result) => result.code === "EPS_NARROWING");
      if (epsNarrowing?.status === "unmet") {
        eligible = false;
        reasons.push(`EPS_NARROWING unmet — ${epsNarrowing.evidence}`);
      }
    } else if (narrative.id === "margin-inflection") {
      const opLeverage = results.find((result) => result.code === "OPERATING_LEVERAGE");
      if (opLeverage?.status === "unmet") {
        eligible = false;
        reasons.push(`OPERATING_LEVERAGE unmet — ${opLeverage.evidence}`);
      }
    }
  } else if (strategy.id === "value") {
    const priceDecline = results.find((result) => result.code === "PRICE_DECLINE");
    if (priceDecline?.status === "unmet") {
      eligible = false;
      reasons.push(`PRICE_DECLINE unmet — ${priceDecline.evidence}`);
    }
    // Cyclical-trough names are often at/near a loss at the bottom of the cycle,
    // so current profitability is not a gate for that narrative.
    if (narrative.id !== "cyclical-trough") {
      const profitable = results.find((result) => result.code === "PROFITABLE");
      if (profitable?.status === "unmet") {
        eligible = false;
        reasons.push(`PROFITABLE unmet — ${profitable.evidence}`);
      }
    }
  }

  const eligibility: Eligibility = {
    eligible,
    depth,
    preconditionsMet: met,
    preconditionsTotal: total,
    passRatio: Number(passRatio.toFixed(2)),
    reasons
  };

  if (!eligible) {
    eligibility.suggestedAlternative = suggestAlternative(strategy, narrative, stock);
  }

  return eligibility;
}

function suggestAlternative(
  strategy: AssessmentStrategy,
  narrative: AssessmentNarrative,
  stock: StockRow
): Eligibility["suggestedAlternative"] {
  if (strategy.id === "catalyst" && narrative.id === "eps-crossover") {
    const epsValue = numberFrom(stock.fundamentals?.epsTtm) ?? numberFrom(stock.fundamentals?.eps);
    if (typeof epsValue === "number" && epsValue > 0) {
      return {
        strategy: "value",
        narrative: "sentiment-overcorrection",
        reason: "stock is already profitable — evaluate the value/sentiment-overcorrection narrative instead"
      };
    }
    return undefined;
  }
  if (strategy.id === "value" && narrative.id !== "cyclical-trough") {
    return {
      strategy: "catalyst",
      narrative: "eps-crossover",
      reason: "stock is not yet profitable — evaluate the catalyst/eps-crossover narrative if losses are narrowing"
    };
  }
  return undefined;
}

function latestEps(quarters: EarningsRow[]): number | undefined {
  for (const row of quarters) {
    if (typeof row.eps === "number") return row.eps;
  }
  return undefined;
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function formatNumber(value: number | undefined): string {
  return typeof value === "number" ? value.toFixed(2) : "n/a";
}

function formatPct(value: number | undefined): string {
  return typeof value === "number" ? `${value.toFixed(1)}%` : "n/a";
}
