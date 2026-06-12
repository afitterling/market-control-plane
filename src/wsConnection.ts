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

// GSI on WsConnections keyed by channel; lets broadcasts Query the subscribers
// on a single channel instead of scanning the whole table. Keep in sync with
// the ByChannel global index in sst.config.ts.
export const WS_CHANNEL_INDEX = "ByChannel";

type SubscriptionFilters = { symbols?: string[]; regions?: string[]; kinds?: string[] };

// One row per (connectionId, channel) subscription.
type SubscriptionRow = {
  connectionId: string;
  channel: Channel;
  filters?: SubscriptionFilters;
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
  await reconcileSubscriptions(connectionId, channels, {});
  return { statusCode: 200, body: "Connected" };
}

export async function disconnect(event: ConnectEvent): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;
  if (!connectionId) return { statusCode: 400, body: "Missing connectionId" };
  await deleteAllSubscriptions(connectionId);
  return { statusCode: 200, body: "Disconnected" };
}

export async function defaultRoute(event: ConnectEvent): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;
  if (!connectionId) return { statusCode: 400, body: "Missing connectionId" };
  let payload: { action?: string; channels?: string[]; filters?: SubscriptionFilters } = {};
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
  const channels = payload.action === "subscribe" ? requested : [];
  await reconcileSubscriptions(connectionId, channels, filters);
  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  await sendTo(endpoint, connectionId, {
    type: "ack",
    action: payload.action,
    channels,
    filters
  });
  return { statusCode: 200, body: "OK" };
}

// Reconcile a connection's subscriptions to exactly `channels`: write a row for
// each desired channel and delete the rest. One write per valid channel, so the
// "set my subscription to exactly these" semantics are preserved idempotently.
async function reconcileSubscriptions(
  connectionId: string,
  channels: Channel[],
  filters: SubscriptionFilters
): Promise<void> {
  const desired = new Set<Channel>(channels);
  const connectedAt = new Date().toISOString();
  await Promise.all(
    VALID_CHANNELS.map((channel) =>
      desired.has(channel)
        ? documentClient.send(
            new PutCommand({
              TableName: Resource.WsConnections.name,
              Item: {
                connectionId,
                channel,
                filters,
                authenticated: true,
                connectedAt
              } satisfies SubscriptionRow
            })
          )
        : documentClient.send(
            new DeleteCommand({
              TableName: Resource.WsConnections.name,
              Key: { connectionId, channel }
            })
          )
    )
  );
}

async function deleteAllSubscriptions(connectionId: string): Promise<void> {
  await Promise.all(
    VALID_CHANNELS.map((channel) =>
      documentClient.send(
        new DeleteCommand({
          TableName: Resource.WsConnections.name,
          Key: { connectionId, channel }
        })
      )
    )
  );
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
      await deleteAllSubscriptions(connectionId);
      return;
    }
    console.error("wsConnection.sendTo failed", { connectionId, cause });
  }
}
