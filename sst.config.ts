/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "market-control-plane",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws"
    };
  },
  async run() {
    const stocks = new sst.aws.Dynamo("Stocks", {
      fields: {
        symbol: "string"
      },
      primaryIndex: {
        hashKey: "symbol"
      }
    });

    const positions = new sst.aws.Dynamo("Positions", {
      fields: {
        accountId: "string",
        symbol: "string"
      },
      primaryIndex: {
        hashKey: "accountId",
        rangeKey: "symbol"
      }
    });

    const events = new sst.aws.Dynamo("Events", {
      fields: {
        streamId: "string",
        eventId: "string"
      },
      primaryIndex: {
        hashKey: "streamId",
        rangeKey: "eventId"
      }
    });

    const api = new sst.aws.ApiGatewayV2("Api", {
      link: [stocks, positions, events],
      transform: {
        route: {
          handler: {
            runtime: "nodejs22.x",
            environment: {
              API_BEARER_TOKEN: process.env.API_BEARER_TOKEN ?? ""
            }
          }
        }
      }
    });

    api.route("GET /", "src/api.health");
    api.route("GET /events", "src/events.list");

    api.route("GET /stocks", "src/stocks.list");
    api.route("GET /stocks/{symbol}", "src/stocks.get");
    api.route("POST /stocks", "src/stocks.create");
    api.route("POST /stocks/batch", "src/stocks.batchCreate");

    api.route("GET /positions", "src/positions.list");
    api.route("GET /positions/{accountId}/{symbol}", "src/positions.get");
    api.route("POST /positions", "src/positions.create");

    return {
      api: api.url,
      stocksTable: stocks.name,
      positionsTable: positions.name,
      eventsTable: events.name
    };
  }
});
