import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand
} from "@aws-sdk/client-apigatewaymanagementapi";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { tokenMatches } from "./http";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const VALID_CHANNELS = ["ticks", "signals", "pulse-events"] as const;
export type Channel = (typeof VALID_CHANNELS)[number];

type ConnectionRow = {
  connectionId: string;
  channels: string[];
  filters?: { symbols?: string[]; regions?: string[]; kinds?: string[] };
  authenticated: boolean;
  connectedAt: string;
};

type ConnectEvent = APIGatewayProxyEventV2 & {
  requestContext: APIGatewayProxyEventV2["requestContext"] & {
    connectionId?: string;
    eventType?: "CONNECT" | "DISCONNECT" | "MESSAGE";
    routeKey?: string;
    domainName?: string;
    stage?: string;
  };
};

export async function connect(event: ConnectEvent): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;
  if (!connectionId) {
    return { statusCode: 400, body: "Missing connectionId" };
  }
  const token = String(
    event.queryStringParameters?.token ?? event.queryStringParameters?.access_token ?? ""
  );
  const authenticated = tokenMatches(token, Resource.API_BEARER_TOKEN.value);
  if (!authenticated) {
    return { statusCode: 401, body: "Unauthorized" };
  }
  const channelParam = String(event.queryStringParameters?.channels ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is Channel => (VALID_CHANNELS as readonly string[]).includes(value));
  const channels = channelParam.length > 0 ? channelParam : [...VALID_CHANNELS];
  const row: ConnectionRow = {
    connectionId,
    channels,
    authenticated: true,
    connectedAt: new Date().toISOString()
  };
  await documentClient.send(
    new PutCommand({
      TableName: Resource.WsConnections.name,
      Item: row
    })
  );
  return { statusCode: 200, body: "Connected" };
}

export async function disconnect(event: ConnectEvent): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;
  if (!connectionId) return { statusCode: 400, body: "Missing connectionId" };
  await documentClient.send(
    new DeleteCommand({
      TableName: Resource.WsConnections.name,
      Key: { connectionId }
    })
  );
  return { statusCode: 200, body: "Disconnected" };
}

export async function defaultRoute(event: ConnectEvent): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;
  if (!connectionId) return { statusCode: 400, body: "Missing connectionId" };
  let payload: { action?: string; channels?: string[]; filters?: ConnectionRow["filters"] } = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: "Body must be JSON" };
  }
  if (payload.action !== "subscribe" && payload.action !== "unsubscribe") {
    return { statusCode: 400, body: "Unknown action" };
  }
  const requested = (payload.channels ?? [])
    .map((value) => String(value).trim())
    .filter((value): value is Channel => (VALID_CHANNELS as readonly string[]).includes(value));
  const filters = payload.filters ?? {};
  const next: ConnectionRow = {
    connectionId,
    channels: payload.action === "subscribe" ? requested : [],
    filters,
    authenticated: true,
    connectedAt: new Date().toISOString()
  };
  await documentClient.send(
    new PutCommand({
      TableName: Resource.WsConnections.name,
      Item: next
    })
  );
  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  await sendTo(endpoint, connectionId, {
    type: "ack",
    action: payload.action,
    channels: next.channels,
    filters: next.filters ?? {}
  });
  return { statusCode: 200, body: "OK" };
}

export async function sendTo(endpoint: string, connectionId: string, payload: unknown): Promise<void> {
  const client = new ApiGatewayManagementApiClient({ endpoint });
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(payload))
      })
    );
  } catch (cause) {
    const status = (cause as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 410) {
      await documentClient.send(
        new DeleteCommand({
          TableName: Resource.WsConnections.name,
          Key: { connectionId }
        })
      );
      return;
    }
    console.error("wsConnection.sendTo failed", { connectionId, cause });
  }
}
