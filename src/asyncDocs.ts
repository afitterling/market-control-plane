import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { asyncApiSpec } from "./specs/asyncapi";

const HTML_TEMPLATE_VERSION = "2.4.5";

export async function spec(_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300"
    },
    body: JSON.stringify(asyncApiSpec)
  };
}

export async function ui(_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Market Control Plane — Streams & Realtime</title>
    <link rel="stylesheet" href="https://unpkg.com/@asyncapi/react-component@${HTML_TEMPLATE_VERSION}/styles/default.min.css" />
    <style>
      html, body { margin: 0; background: #fafafa; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    </style>
  </head>
  <body>
    <div id="asyncapi"></div>
    <script src="https://unpkg.com/@asyncapi/react-component@${HTML_TEMPLATE_VERSION}/browser/standalone/index.js"></script>
    <script>
      window.addEventListener("load", async () => {
        const response = await fetch("./asyncapi.json");
        const schema = await response.json();
        AsyncApiStandalone.render(
          { schema, config: { show: { sidebar: true, info: true, servers: true, operations: true, messages: true, schemas: true } } },
          document.getElementById("asyncapi")
        );
      });
    </script>
  </body>
</html>`;

  return {
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300"
    },
    body: html
  };
}
