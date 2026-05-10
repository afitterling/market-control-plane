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

    const earnings = new sst.aws.Dynamo("Earnings", {
      fields: {
        symbol: "string",
        period: "string"
      },
      primaryIndex: {
        hashKey: "symbol",
        rangeKey: "period"
      }
    });

    const signalAlerts = new sst.aws.Dynamo("SignalAlerts", {
      fields: {
        alertId: "string"
      },
      primaryIndex: {
        hashKey: "alertId"
      }
    });

    const processStock = new sst.aws.Function("ProcessStock", {
      handler: "src/processor.processStock",
      link: [stocks, earnings, events],
      timeout: "5 minutes",
      environment: {
        FMP_API_KEY: process.env.FMP_API_KEY ?? ""
      }
    });

    new sst.aws.Cron("PullPrices", {
      schedule: "rate(1 minute)",
      function: {
        handler: "src/prices.pullPrices",
        link: [stocks],
        timeout: "90 seconds",
        environment: {
          FMP_API_KEY: process.env.FMP_API_KEY ?? ""
        }
      }
    });

    new sst.aws.Cron("PullMacd", {
      schedule: "rate(15 minutes)",
      function: {
        handler: "src/macd.processAllMacd",
        link: [stocks],
        timeout: "10 minutes",
        memory: "512 MB",
        environment: {
          FMP_API_KEY: process.env.FMP_API_KEY ?? ""
        }
      }
    });

    new sst.aws.Cron("EvaluateAlerts", {
      schedule: "rate(30 minutes)",
      function: {
        handler: "src/alertsEvaluator.evaluateAlerts",
        link: [stocks, signalAlerts, events],
        timeout: "2 minutes"
      }
    });

    const api = new sst.aws.ApiGatewayV2("Api", {
      link: [stocks, positions, events, earnings, signalAlerts, processStock],
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

    api.route("GET /earnings/{symbol}", "src/earnings.list");

    api.route("GET /alerts", "src/alerts.list");
    api.route("GET /alerts/{alertId}", "src/alerts.get");
    api.route("POST /alerts", "src/alerts.create");
    api.route("DELETE /alerts/{alertId}", "src/alerts.remove");

    api.route("GET /positions", "src/positions.list");
    api.route("GET /positions/{accountId}/{symbol}", "src/positions.get");
    api.route("POST /positions", "src/positions.create");

    return {
      api: api.url,
      stocksTable: stocks.name,
      positionsTable: positions.name,
      eventsTable: events.name,
      earningsTable: earnings.name,
      signalAlertsTable: signalAlerts.name,
      processStockFunction: processStock.name
    };
  }
});
