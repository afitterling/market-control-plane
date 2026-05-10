import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { error, json, nowIso, requireBearerToken } from "./http";

type EventItem = {
  streamId: string;
  eventId: string;
  type: string;
  payload: unknown;
  createdAt: string;
};

type PublicEvent = Omit<EventItem, "streamId">;

const STREAM_ID = "market-control-plane";
const MAX_LIMIT = 100;
const MAX_WAIT_SECONDS = 25;
const POLL_INTERVAL_MS = 1000;
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const limit = parseLimit(event.queryStringParameters?.limit);
  const waitSeconds = parseWaitSeconds(event.queryStringParameters?.waitSeconds);
  const after = String(event.queryStringParameters?.after ?? "").trim();
  const from = String(event.queryStringParameters?.from ?? "").trim();

  if (after && !isValidEventId(after)) {
    return error("Event cursor must be an eventId returned by this endpoint.");
  }
  if (from && !isValidEventId(from)) {
    return error("Event cursor must be an eventId returned by this endpoint.");
  }
  if (after && from) {
    return error("Provide either 'after' (exclusive) or 'from' (inclusive), not both.");
  }

  const cursor = from ? { kind: "inclusive" as const, value: from } : { kind: "exclusive" as const, value: after };

  const deadline = Date.now() + waitSeconds * 1000;
  let events = await readEvents(cursor, limit);

  while (events.length === 0 && waitSeconds > 0 && Date.now() < deadline) {
    await sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
    events = await readEvents(cursor, limit);
  }

  return json({
    count: events.length,
    events,
    nextCursor: events.at(-1)?.eventId ?? after ?? from,
    polling: {
      waitSeconds,
      limit
    }
  });
}

export async function publishEvent(type: string, payload: unknown): Promise<PublicEvent> {
  const createdAt = nowIso();
  const event: EventItem = {
    streamId: STREAM_ID,
    eventId: `${createdAt}#${randomUUID()}`,
    type,
    payload,
    createdAt
  };

  await documentClient.send(
    new PutCommand({
      TableName: Resource.Events.name,
      Item: event
    })
  );

  return toPublicEvent(event);
}

type Cursor = { kind: "inclusive" | "exclusive"; value: string };

async function readEvents(cursor: Cursor, limit: number): Promise<PublicEvent[]> {
  const hasCursor = cursor.value !== "";
  const operator = cursor.kind === "inclusive" ? ">=" : ">";
  const response = await documentClient.send(
    new QueryCommand({
      TableName: Resource.Events.name,
      KeyConditionExpression: hasCursor
        ? `streamId = :streamId AND eventId ${operator} :cursor`
        : "streamId = :streamId",
      ExpressionAttributeValues: {
        ":streamId": STREAM_ID,
        ...(hasCursor ? { ":cursor": cursor.value } : {})
      },
      Limit: limit,
      ScanIndexForward: true
    })
  );

  return ((response.Items ?? []) as EventItem[]).map(toPublicEvent);
}

function toPublicEvent(event: EventItem): PublicEvent {
  return {
    eventId: event.eventId,
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt
  };
}

function parseLimit(value: string | undefined): number {
  const limit = Number(value ?? MAX_LIMIT);
  if (!Number.isFinite(limit)) {
    return MAX_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function parseWaitSeconds(value: string | undefined): number {
  const waitSeconds = Number(value ?? 0);
  if (!Number.isFinite(waitSeconds)) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(waitSeconds), 0), MAX_WAIT_SECONDS);
}

function isValidEventId(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[0-9a-f-]{36}$/.test(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
