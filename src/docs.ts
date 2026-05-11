import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { openApiSpec } from "./specs/openapi";

const SWAGGER_VERSION = "5.17.14";

export async function spec(_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300"
    },
    body: JSON.stringify(openApiSpec)
  };
}

export async function ui(_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Market Control Plane — API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui.css" />
    <style>
      body { margin: 0; background: #fafafa; }
      .topbar { display: none; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-bundle.js" crossorigin></script>
    <script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-standalone-preset.js" crossorigin></script>
    <script>
      window.addEventListener("load", () => {
        window.ui = SwaggerUIBundle({
          url: "./openapi.json",
          dom_id: "#swagger-ui",
          deepLinking: true,
          persistAuthorization: true,
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset.slice(1)],
          layout: "BaseLayout"
        });
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
