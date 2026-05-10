import { timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

export type JsonObject = Record<string, unknown>;

export function json(body: unknown, statusCode = 200): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

export function error(message: string, statusCode = 400, details?: unknown): APIGatewayProxyResultV2 {
  return json(
    {
      error: message,
      ...(details === undefined ? {} : { details })
    },
    statusCode
  );
}

export function requireBearerToken(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 | undefined {
  const expectedToken = process.env.API_BEARER_TOKEN;
  const authorization = event.headers.authorization ?? event.headers.Authorization ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";

  if (!expectedToken || !isSameToken(token, expectedToken)) {
    return json(
      {
        error: "Unauthorized."
      },
      401
    );
  }

  return undefined;
}

export function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) {
    return {};
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return JSON.parse(rawBody);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function cleanSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function isSameToken(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
