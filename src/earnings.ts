import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { cleanSymbol, error, json, requireBearerToken } from "./http";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const unauthorized = requireBearerToken(event);
  if (unauthorized) {
    return unauthorized;
  }

  const symbol = cleanSymbol(event.pathParameters?.symbol);
  if (!symbol) {
    return error("Missing stock symbol.");
  }

  const kind = String(event.queryStringParameters?.kind ?? "").trim().toUpperCase();
  const reports: unknown[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  const useKindFilter = kind === "ANNUAL" || kind === "QUARTER";
  const keyConditionExpression = useKindFilter
    ? "symbol = :symbol AND begins_with(#period, :prefix)"
    : "symbol = :symbol";
  const expressionAttributeValues: Record<string, unknown> = useKindFilter
    ? { ":symbol": symbol, ":prefix": `${kind}#` }
    : { ":symbol": symbol };
  const expressionAttributeNames = useKindFilter ? { "#period": "period" } : undefined;

  do {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: Resource.Earnings.name,
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ExpressionAttributeNames: expressionAttributeNames,
        ExclusiveStartKey: exclusiveStartKey,
        ScanIndexForward: false
      })
    );
    reports.push(...(response.Items ?? []));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return json({
    symbol,
    count: reports.length,
    reports
  });
}
