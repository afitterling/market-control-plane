import { type MarketSession, scanAlerts, type SignalAlertRecord } from "./alerts";
import { publishEvent } from "./events";
import { nowIso } from "./http";

const SIGN_ALERT_RAISED = "SIGN_ALERT_RAISED";
const SIGN_ALERT_TICK_SKIPPED = "SIGN_ALERT_TICK_SKIPPED";

export async function evaluateAlerts(): Promise<{
  session: MarketSession | "closed";
  evaluated: number;
  raised: number;
}> {
  const session = currentMarketSession(new Date());

  if (session === "closed") {
    await publishEvent(SIGN_ALERT_TICK_SKIPPED, {
      action: SIGN_ALERT_TICK_SKIPPED,
      reason: "market_closed",
      at: nowIso()
    });
    return { session, evaluated: 0, raised: 0 };
  }

  const alerts = await scanAlerts();
  const candidates = alerts.filter((alert) => alert.enabled && alert.sessions.includes(session));

  let raised = 0;
  for (const alert of candidates) {
    const result = await evaluateAlert(alert, session);
    if (result.matched) {
      raised += 1;
      await publishEvent(SIGN_ALERT_RAISED, {
        action: SIGN_ALERT_RAISED,
        alertId: alert.alertId,
        name: alert.name,
        session,
        matchedSymbols: result.matchedSymbols,
        detail: result.detail,
        at: nowIso()
      });
    }
  }

  return { session, evaluated: candidates.length, raised };
}

type EvaluationResult = {
  matched: boolean;
  matchedSymbols?: string[];
  detail?: unknown;
};

async function evaluateAlert(alert: SignalAlertRecord, _session: MarketSession): Promise<EvaluationResult> {
  if (!alert.condition) {
    return { matched: false };
  }
  return { matched: false };
}

export function currentMarketSession(now: Date): MarketSession | "closed" {
  const parts = formatNyParts(now);
  if (parts.weekday === "Sat" || parts.weekday === "Sun") {
    return "closed";
  }
  const minutes = parts.hour * 60 + parts.minute;
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) {
    return "premarket";
  }
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) {
    return "regular";
  }
  if (minutes >= 16 * 60 && minutes < 20 * 60) {
    return "afterhours";
  }
  return "closed";
}

function formatNyParts(now: Date): { weekday: string; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  let weekday = "";
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "weekday") {
      weekday = part.value;
    } else if (part.type === "hour") {
      hour = Number(part.value) % 24;
    } else if (part.type === "minute") {
      minute = Number(part.value);
    }
  }
  return { weekday, hour, minute };
}
