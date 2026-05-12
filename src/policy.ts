import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { json, nowIso, requireBearerToken } from "./http";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PULSE_SCOPE = "global";
const ALIGNMENT_SCOPE = "global";

const TILE_REGIONS = ["United States", "Iran", "China", "Europe", "India", "Asia"];
const REGION_LABEL: Record<string, string> = {
  "United States": "USA",
  "European Union": "Europe",
  Europe: "Europe",
  Iran: "Iran",
  China: "China",
  India: "India",
  Asia: "Asia",
  "Asia Pacific": "Asia"
};

const HEADLINES_PER_REGION = 5;
const MARKET_IMPACT_HEADLINE_LIMIT = 10;
const THEME_LIMIT = 5;
const SECTORS_TO_WATCH_LIMIT = 6;

type PulseStatus = "calm" | "watch" | "elevated" | "critical";
type RiskState = "risk-on" | "risk-off" | "neutral";
type CompositeRiskLevel = "low" | "medium" | "high" | "extreme";

type RegionStatus = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type RegionTrend = "escalating" | "stable" | "easing";
type ThemeSignal = "negative" | "neutral" | "positive";
type ImpactMagnitude = "MINOR" | "MODERATE" | "SIGNIFICANT" | "EXTREME";
type ImpactStance = "RISK-ON" | "RISK-OFF" | "NEUTRAL";
type GlobalRiskLevel = "CALM" | "WATCH" | "ELEVATED" | "CRITICAL";

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
  articleCount?: number;
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
  };
};

type AlignmentRow = {
  scope: string;
  alignedAt: string;
  composite: {
    riskLevel: CompositeRiskLevel;
    bias: string;
    biasScore: number;
    pulseRiskScore: number;
    hotRegions: string[];
    summary: string;
  };
};

type RegionCard = {
  name: string;
  rawRegion: string;
  status: RegionStatus;
  trend: RegionTrend;
  criticality: number;
  severity: number;
  articleCount: number;
  topThemes: string[];
  title: string;
  narrative: string;
  prediction: string;
  sourceHeadlines: Array<{
    title: string;
    url: string;
    site?: string;
    publishedAt?: string;
    sentiment?: number;
    themes: string[];
  }>;
};

type MarketImpactTheme = {
  title: string;
  signal: ThemeSignal;
  narrative: string;
  sectors: string[];
};

type PolicyPrediction = {
  generatedAt: string;
  updatedAt: string | null;
  cadence: string;
  source: string;
  topics: string[];
  globalRisk: {
    level: GlobalRiskLevel;
    score: number;
    narrative: string;
    summary: string | null;
    regions: Array<{ name: string; status: RegionStatus; trend: RegionTrend }>;
  };
  regions: RegionCard[];
  marketImpact: {
    magnitude: ImpactMagnitude;
    stance: ImpactStance;
    title: string;
    narrative: string;
    themes: MarketImpactTheme[];
    sectorsToWatch: string[];
    sourceHeadlines: Array<{
      title: string;
      url: string;
      site?: string;
      publishedAt?: string;
      region: string;
      themes: string[];
    }>;
  };
};

export async function prediction(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) return unauthorized;

  const [latestSnapshot, previousSnapshot, latestAlignment] = await Promise.all([
    fetchLatestPulseSnapshot(),
    fetchPreviousPulseSnapshot(),
    fetchLatestAlignment()
  ]);

  if (!latestSnapshot) {
    return json({
      prediction: emptyPrediction()
    });
  }

  const regionCards = buildRegionCards(latestSnapshot, previousSnapshot);
  const marketImpact = buildMarketImpact(latestSnapshot, latestAlignment);

  const globalRiskLevel = mapGlobalRiskLevel(latestSnapshot.overall?.status, regionCards);
  const globalNarrative = buildGlobalNarrative(latestSnapshot, regionCards);

  const payload: PolicyPrediction = {
    generatedAt: nowIso(),
    updatedAt: latestSnapshot.snapshotAt,
    cadence: "Hourly refresh from market pulse",
    source: "FMP Global News",
    topics: regionCards.map((card) => card.name),
    globalRisk: {
      level: globalRiskLevel,
      score: latestSnapshot.overall?.score ?? 0,
      narrative: globalNarrative,
      summary: latestSnapshot.overall?.summary ?? null,
      regions: regionCards.map((card) => ({ name: card.name, status: card.status, trend: card.trend }))
    },
    regions: regionCards,
    marketImpact
  };

  return json({ prediction: payload });
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

async function fetchPreviousPulseSnapshot(): Promise<PulseSnapshot | undefined> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.MarketPulseSnapshot.name,
      KeyConditionExpression: "#scope = :scope",
      ExpressionAttributeNames: { "#scope": "scope" },
      ExpressionAttributeValues: { ":scope": PULSE_SCOPE },
      ScanIndexForward: false,
      Limit: 2
    })
  );
  const rows = (response.Items ?? []) as PulseSnapshot[];
  return rows[1];
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

function buildRegionCards(latest: PulseSnapshot, previous: PulseSnapshot | undefined): RegionCard[] {
  const previousByRegion = new Map<string, PulseRegionRow>();
  for (const region of previous?.regions ?? []) {
    previousByRegion.set(region.region, region);
  }

  const targetCards: RegionCard[] = [];
  const seen = new Set<string>();
  const latestByRegion = new Map<string, PulseRegionRow>();
  for (const region of latest.regions ?? []) {
    latestByRegion.set(region.region, region);
  }

  for (const targetName of TILE_REGIONS) {
    const candidates = findRegionCandidates(targetName, latest.regions ?? []);
    for (const candidate of candidates) {
      if (seen.has(candidate.region)) continue;
      seen.add(candidate.region);
      targetCards.push(toRegionCard(targetName, candidate, previousByRegion.get(candidate.region)));
      break;
    }
    if (!seen.has(targetName) && !candidates.length) {
      targetCards.push(emptyRegionCard(targetName));
    }
  }

  return targetCards;
}

function findRegionCandidates(target: string, regions: PulseRegionRow[]): PulseRegionRow[] {
  if (target === "Asia") {
    const order = ["Asia Pacific", "Japan", "South Korea", "Hong Kong", "Taiwan"];
    return order
      .map((name) => regions.find((row) => row.region === name))
      .filter((row): row is PulseRegionRow => Boolean(row));
  }
  if (target === "Europe") {
    const order = ["European Union", "Germany", "France", "Italy", "Spain", "United Kingdom"];
    return order
      .map((name) => regions.find((row) => row.region === name))
      .filter((row): row is PulseRegionRow => Boolean(row));
  }
  const direct = regions.find((row) => row.region === target);
  return direct ? [direct] : [];
}

function toRegionCard(
  label: string,
  region: PulseRegionRow,
  previous: PulseRegionRow | undefined
): RegionCard {
  const topLink = (region.links ?? [])
    .filter((link) => link.title && link.url)
    .sort((first, second) => parseDate(second.publishedAt) - parseDate(first.publishedAt))[0];

  const status = mapRegionStatus(region.status, Math.max(region.criticality, region.severity));
  const trend = computeTrend(region, previous);

  return {
    name: REGION_LABEL[label] ?? label,
    rawRegion: region.region,
    status,
    trend,
    criticality: region.criticality,
    severity: region.severity,
    articleCount: region.articleCount ?? region.links?.length ?? 0,
    topThemes: region.topThemes ?? [],
    title: topLink?.title?.trim() ?? `${region.region} ${status.toLowerCase()} risk`,
    narrative: region.summary ?? `${region.region} status ${region.status}.`,
    prediction: buildRegionPrediction(region, trend),
    sourceHeadlines: (region.links ?? [])
      .filter((link) => link.title && link.url)
      .slice(0, HEADLINES_PER_REGION)
      .map((link) => ({
        title: String(link.title),
        url: String(link.url),
        site: link.site,
        publishedAt: link.publishedAt,
        sentiment: link.sentiment,
        themes: link.themes ?? []
      }))
  };
}

function emptyRegionCard(name: string): RegionCard {
  return {
    name: REGION_LABEL[name] ?? name,
    rawRegion: name,
    status: "LOW",
    trend: "stable",
    criticality: 0,
    severity: 0,
    articleCount: 0,
    topThemes: [],
    title: `${REGION_LABEL[name] ?? name} — no fresh signal`,
    narrative: `${REGION_LABEL[name] ?? name} has no fresh pulse coverage in the current window.`,
    prediction: "Insufficient data for a directional read.",
    sourceHeadlines: []
  };
}

function mapRegionStatus(status: PulseStatus, score: number): RegionStatus {
  if (status === "critical" || score >= 80) return "CRITICAL";
  if (status === "elevated" || score >= 55) return "HIGH";
  if (status === "watch" || score >= 25) return "MEDIUM";
  return "LOW";
}

function computeTrend(current: PulseRegionRow, previous: PulseRegionRow | undefined): RegionTrend {
  if (!previous) return "stable";
  const currentScore = Math.max(current.criticality, current.severity);
  const previousScore = Math.max(previous.criticality, previous.severity);
  const statusRank = { calm: 0, watch: 1, elevated: 2, critical: 3 } as const;
  const delta = currentScore - previousScore;
  const statusDelta = statusRank[current.status] - statusRank[previous.status];
  if (statusDelta > 0 || delta >= 8) return "escalating";
  if (statusDelta < 0 || delta <= -8) return "easing";
  return "stable";
}

function buildRegionPrediction(region: PulseRegionRow, trend: RegionTrend): string {
  const themes = (region.topThemes ?? []).slice(0, 2);
  if (themes.length === 0) {
    return "No dominant theme; expect status to hold absent fresh catalysts.";
  }
  const themesPhrase = themes.join(" and ").replace(/_/g, " ");
  if (trend === "escalating") {
    return `With ${themesPhrase} escalating, expect risk to remain ${region.status} or rise further near-term.`;
  }
  if (trend === "easing") {
    return `${themesPhrase} are easing — risk likely drifts lower if news flow stays soft.`;
  }
  return `${themesPhrase} hold the tape steady; status likely remains ${region.status} until catalysts shift.`;
}

function mapGlobalRiskLevel(overall: PulseStatus | undefined, regions: RegionCard[]): GlobalRiskLevel {
  const critical = regions.some((card) => card.status === "CRITICAL");
  if (overall === "critical" || critical) return "CRITICAL";
  if (overall === "elevated") return "ELEVATED";
  if (overall === "watch") return "WATCH";
  return "CALM";
}

function buildGlobalNarrative(latest: PulseSnapshot, regions: RegionCard[]): string {
  const hot = regions
    .filter((card) => card.status === "HIGH" || card.status === "CRITICAL")
    .map((card) => `${card.name} ${card.status}`)
    .join(", ");
  const themes = aggregateTopThemes(regions).slice(0, 3).join(", ");
  const overall = latest.overall?.summary ?? `Global pulse ${latest.overall?.status ?? "calm"}.`;
  const hotPart = hot ? ` Hot: ${hot}.` : "";
  const themePart = themes ? ` Themes: ${themes}.` : "";
  return `${overall}${hotPart}${themePart}`.trim();
}

function buildMarketImpact(latest: PulseSnapshot, alignment: AlignmentRow | undefined): PolicyPrediction["marketImpact"] {
  const themes = aggregateThemesWithWeights(latest.regions ?? []);
  const topThemes = themes.slice(0, THEME_LIMIT);
  const allSectors = new Set<string>();
  const themeBlocks: MarketImpactTheme[] = topThemes.map((entry) => {
    const sectors = THEME_SECTORS[entry.theme] ?? [];
    for (const sector of sectors) allSectors.add(sector);
    return {
      title: THEME_TITLE[entry.theme] ?? humanizeTheme(entry.theme),
      signal: themeSignal(entry.theme),
      narrative: buildThemeNarrative(entry.theme, latest.regions ?? []),
      sectors
    };
  });

  const stance = mapStance(latest.riskState);
  const magnitude = mapMagnitude(alignment?.composite.riskLevel, latest.overall?.score ?? 0);
  const title = buildMarketImpactTitle(topThemes, latest, alignment);
  const narrative = buildMarketImpactNarrative(latest, alignment, topThemes);

  const sourceHeadlines = (latest.regions ?? [])
    .flatMap((region) =>
      (region.links ?? [])
        .filter((link) => link.title && link.url)
        .map((link) => ({
          title: String(link.title),
          url: String(link.url),
          site: link.site,
          publishedAt: link.publishedAt,
          region: region.region,
          themes: link.themes ?? []
        }))
    )
    .sort((first, second) => parseDate(second.publishedAt) - parseDate(first.publishedAt))
    .slice(0, MARKET_IMPACT_HEADLINE_LIMIT);

  const sectorsToWatch = [...allSectors].slice(0, SECTORS_TO_WATCH_LIMIT);

  return {
    magnitude,
    stance,
    title,
    narrative,
    themes: themeBlocks,
    sectorsToWatch,
    sourceHeadlines
  };
}

function aggregateThemesWithWeights(regions: PulseRegionRow[]): Array<{ theme: string; weight: number }> {
  const totals = new Map<string, number>();
  for (const region of regions) {
    const regionWeight = Math.max(1, Math.round((region.criticality + region.severity) / 20));
    for (const theme of region.topThemes ?? []) {
      totals.set(theme, (totals.get(theme) ?? 0) + regionWeight);
    }
  }
  return [...totals.entries()]
    .sort((first, second) => second[1] - first[1])
    .map(([theme, weight]) => ({ theme, weight }));
}

function aggregateTopThemes(regions: RegionCard[]): string[] {
  const counts = new Map<string, number>();
  for (const region of regions) {
    for (const theme of region.topThemes) {
      counts.set(theme, (counts.get(theme) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((first, second) => second[1] - first[1])
    .map(([theme]) => humanizeTheme(theme));
}

function buildThemeNarrative(theme: string, regions: PulseRegionRow[]): string {
  const carriers = regions
    .filter((row) => (row.topThemes ?? []).includes(theme))
    .map((row) => row.region)
    .slice(0, 3);
  const carrierPart = carriers.length ? ` Carried by ${carriers.join(", ")}.` : "";
  return `${THEME_NARRATIVE[theme] ?? `${humanizeTheme(theme)} is a recurring theme in current pulse coverage.`}${carrierPart}`;
}

function buildMarketImpactTitle(
  topThemes: Array<{ theme: string; weight: number }>,
  latest: PulseSnapshot,
  alignment: AlignmentRow | undefined
): string {
  const lead = topThemes[0];
  const headlineRegion = (latest.overall?.hotRegions ?? [])[0];
  if (lead) {
    const themePhrase = THEME_TITLE[lead.theme] ?? humanizeTheme(lead.theme);
    const regionPhrase = headlineRegion ? `${headlineRegion} ` : "";
    return `${regionPhrase}${themePhrase} ${alignment?.composite.bias === "risk_off" || latest.riskState === "risk-off" ? "Pressures Markets" : "Drives Cross-Asset Reaction"}`.trim();
  }
  return "Policy backdrop steady across major regions";
}

function buildMarketImpactNarrative(
  latest: PulseSnapshot,
  alignment: AlignmentRow | undefined,
  topThemes: Array<{ theme: string; weight: number }>
): string {
  const themePart = topThemes
    .slice(0, 3)
    .map((entry) => THEME_TITLE[entry.theme] ?? humanizeTheme(entry.theme))
    .join(", ");
  const stance = latest.riskState ?? "neutral";
  const biasPart = alignment ? `composite bias ${alignment.composite.bias} at ${alignment.composite.riskLevel} risk` : "no composite bias available";
  const vix = latest.marketData?.vix;
  const vixPart = vix && typeof vix.value === "number"
    ? `VIX at ${vix.value}${typeof vix.changePercent === "number" ? ` (${formatPct(vix.changePercent)})` : ""}.`
    : "";
  const themePhrase = themePart ? `Leading policy themes: ${themePart}.` : "";
  return `${themePhrase} Markets reading as ${stance}; ${biasPart}. ${vixPart}`.trim();
}

function mapStance(riskState: RiskState | undefined): ImpactStance {
  if (riskState === "risk-off") return "RISK-OFF";
  if (riskState === "risk-on") return "RISK-ON";
  return "NEUTRAL";
}

function mapMagnitude(level: CompositeRiskLevel | undefined, overallScore: number): ImpactMagnitude {
  if (level === "extreme" || overallScore >= 80) return "EXTREME";
  if (level === "high" || overallScore >= 60) return "SIGNIFICANT";
  if (level === "medium" || overallScore >= 30) return "MODERATE";
  return "MINOR";
}

function themeSignal(theme: string): ThemeSignal {
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

function humanizeTheme(theme: string): string {
  return theme
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function emptyPrediction(): PolicyPrediction {
  return {
    generatedAt: nowIso(),
    updatedAt: null,
    cadence: "Hourly refresh from market pulse",
    source: "FMP Global News",
    topics: [],
    globalRisk: {
      level: "CALM",
      score: 0,
      narrative: "No pulse snapshot available yet.",
      summary: null,
      regions: []
    },
    regions: [],
    marketImpact: {
      magnitude: "MINOR",
      stance: "NEUTRAL",
      title: "Markets quiet — no pulse data",
      narrative: "No pulse snapshot available to derive policy impact.",
      themes: [],
      sectorsToWatch: [],
      sourceHeadlines: []
    }
  };
}

function parseDate(value: string | undefined): number {
  if (!value) return 0;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ts = Date.parse(normalized);
  return Number.isFinite(ts) ? ts : 0;
}

function formatPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value}%`;
}

const THEME_TITLE: Record<string, string> = {
  war: "Geopolitical Conflict",
  invasion: "Invasion and Military Escalation",
  missile_strike: "Missile Strikes",
  conflict: "Regional Conflict",
  sanctions: "Sanctions Pressure",
  embargo: "Trade Embargoes",
  default: "Sovereign Default Risk",
  bankruptcy: "Corporate Bankruptcies",
  recession: "Recession Risk",
  inflation: "Inflation Surge and Monetary Policy",
  rate_hike: "Rate Hike Cycle",
  rate_cut: "Rate Cut Cycle",
  central_bank: "Central Bank Action",
  election: "Election Risk",
  coup: "Political Instability",
  protest: "Civil Unrest",
  trade_war: "Trade War Escalation",
  tariff: "Tariff Action",
  cyberattack: "Cyber Risk",
  energy_shock: "Energy Shock",
  natural_disaster: "Natural Disaster Impact"
};

const THEME_NARRATIVE: Record<string, string> = {
  war: "Active conflict is disrupting cross-border flows and lifting risk premia.",
  invasion: "Military escalation is reshaping risk pricing and commodity flows.",
  missile_strike: "Strike activity is fueling volatility in energy and defense exposures.",
  conflict: "Regional friction is keeping risk premia bid and weighing on cyclicals.",
  sanctions: "Sanctions are reshaping trade routes and squeezing affected sectors.",
  embargo: "Embargoes are constricting supply chains and elevating cost pressures.",
  default: "Sovereign credit stress is widening spreads in financials and EM exposures.",
  bankruptcy: "Corporate distress is raising credit concerns in cyclical sectors.",
  recession: "Growth fears are weighing on cyclicals and supporting defensives.",
  inflation: "Inflation pressure is lifting yields and pressuring rate-sensitive equities.",
  rate_hike: "Tighter policy expectations are weighing on duration and growth equities.",
  rate_cut: "Looser policy expectations are supporting risk assets and lengthening duration.",
  central_bank: "Central bank signaling is dominating cross-asset pricing.",
  election: "Election uncertainty is keeping risk premia elevated.",
  coup: "Political instability is undermining local assets and lifting safe havens.",
  protest: "Civil unrest is pressuring local equities and currencies.",
  trade_war: "Trade tensions are weighing on exporters and global cyclicals.",
  tariff: "New tariffs are reshaping margin outlooks for affected industries.",
  cyberattack: "Cyber incidents are raising operational risk across affected sectors.",
  energy_shock: "Energy supply stress is lifting commodity prices and inflation expectations.",
  natural_disaster: "Disaster impacts are disrupting supply chains and insurer earnings."
};

const THEME_SECTORS: Record<string, string[]> = {
  war: ["Energy", "Consumer Discretionary", "Industrials"],
  invasion: ["Energy", "Industrials", "Defense"],
  missile_strike: ["Energy", "Defense", "Industrials"],
  conflict: ["Energy", "Consumer Discretionary", "Industrials"],
  sanctions: ["Energy", "Financials", "Materials"],
  embargo: ["Energy", "Materials", "Industrials"],
  default: ["Financials", "Real Estate"],
  bankruptcy: ["Financials", "Real Estate", "Consumer Discretionary"],
  recession: ["Consumer Discretionary", "Industrials", "Financials"],
  inflation: ["Financials", "Technology", "Consumer Staples"],
  rate_hike: ["Technology", "Real Estate", "Financials"],
  rate_cut: ["Technology", "Real Estate", "Consumer Discretionary"],
  central_bank: ["Financials", "Real Estate", "Technology"],
  election: ["Financials", "Healthcare", "Energy"],
  coup: ["Energy", "Materials", "Financials"],
  protest: ["Consumer Discretionary", "Financials"],
  trade_war: ["Technology", "Industrials", "Consumer Discretionary"],
  tariff: ["Industrials", "Consumer Discretionary", "Materials"],
  cyberattack: ["Technology", "Communication Services", "Financials"],
  energy_shock: ["Energy", "Utilities", "Industrials"],
  natural_disaster: ["Insurance", "Utilities", "Materials"]
};
