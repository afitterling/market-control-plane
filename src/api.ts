import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { json, nowIso, requireBearerToken } from "./http";

export async function health(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  return json({
    service: "market-control-plane",
    status: "ok",
    path: event.rawPath,
    time: nowIso()
  });
}
