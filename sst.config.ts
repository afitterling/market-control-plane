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
    const apiBearerToken = new sst.Secret("API_BEARER_TOKEN");
    const fmpApiKey = new sst.Secret("FMP_API_KEY");
    const pulseRefreshToken = new sst.Secret("PULSE_REFRESH_TOKEN");
    // Claude API key powering the AI endpoints (assessments, narrative, movement,
    // policy). Loaded from .env.local via `npm run secrets:load`.
    const anthropicApiKey = new sst.Secret("ANTHROPIC_API_KEY");

    const stocks = new sst.aws.Dynamo("Stocks", {
      fields: {
        symbol: "string",
        // Constant value ("STOCK") on every row so the whole symbol list can be
        // read with a Query instead of a Scan. See src/stocksTable.ts.
        gsiSymbols: "string"
      },
      primaryIndex: {
        hashKey: "symbol"
      },
      globalIndexes: {
        BySymbolList: {
          hashKey: "gsiSymbols",
          rangeKey: "symbol",
          projection: "keys-only"
        }
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

    const marketPulse = new sst.aws.Dynamo("MarketPulse", {
      fields: {
        region: "string"
      },
      primaryIndex: {
        hashKey: "region"
      }
    });

    const marketPulseSnapshot = new sst.aws.Dynamo("MarketPulseSnapshot", {
      fields: {
        scope: "string",
        snapshotAt: "string"
      },
      primaryIndex: {
        hashKey: "scope",
        rangeKey: "snapshotAt"
      }
    });

    const financialPolicyCache = new sst.aws.Dynamo("FinancialPolicyCache", {
      fields: {
        scope: "string",
        generatedAt: "string"
      },
      primaryIndex: {
        hashKey: "scope",
        rangeKey: "generatedAt"
      }
    });

    const marketRegime = new sst.aws.Dynamo("MarketRegime", {
      fields: {
        scale: "string",
        date: "string"
      },
      primaryIndex: {
        hashKey: "scale",
        rangeKey: "date"
      }
    });

    const marketAlignment = new sst.aws.Dynamo("MarketAlignment", {
      fields: {
        scope: "string",
        alignedAt: "string"
      },
      primaryIndex: {
        hashKey: "scope",
        rangeKey: "alignedAt"
      }
    });

    const industries = new sst.aws.Dynamo("Industries", {
      fields: {
        industry: "string"
      },
      primaryIndex: {
        hashKey: "industry"
      }
    });

    const wsConnections = new sst.aws.Dynamo("WsConnections", {
      fields: {
        connectionId: "string",
        // One item per (connectionId, channel) subscription so broadcasts can
        // Query the ByChannel index for exactly the subscribers on a channel
        // instead of scanning the whole connection table on every event.
        channel: "string"
      },
      primaryIndex: {
        hashKey: "connectionId",
        rangeKey: "channel"
      },
      globalIndexes: {
        ByChannel: {
          hashKey: "channel",
          rangeKey: "connectionId"
        }
      }
    });

    const ticksStream = new sst.aws.KinesisStream("Ticks");
    const signalsStream = new sst.aws.KinesisStream("Signals");
    const pulseEventsStream = new sst.aws.KinesisStream("PulseEvents");

    const processStock = new sst.aws.Function("ProcessStock", {
      handler: "src/processor.processStock",
      link: [stocks, earnings, events, fmpApiKey, signalsStream],
      timeout: "5 minutes"
    });

    new sst.aws.Cron("PullPrices", {
      schedule: "rate(1 minute)",
      function: {
        handler: "src/prices.pullPrices",
        link: [stocks, fmpApiKey, ticksStream],
        timeout: "90 seconds"
      }
    });

    new sst.aws.Cron("PullMacd", {
      schedule: "rate(15 minutes)",
      function: {
        handler: "src/macd.processAllMacd",
        link: [stocks, fmpApiKey],
        timeout: "10 minutes",
        memory: "512 MB"
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

    new sst.aws.Cron("PullPulse", {
      schedule: $dev ? "rate(5 minutes)" : "rate(15 minutes)",
      function: {
        handler: "src/pulse.pullPulse",
        link: [marketPulse, marketPulseSnapshot, events, fmpApiKey, pulseEventsStream],
        timeout: "2 minutes",
        memory: "512 MB"
      }
    });

    new sst.aws.Cron("AlignMarketState", {
      schedule: "rate(15 minutes)",
      function: {
        handler: "src/alignment.alignMarketState",
        link: [marketPulse, marketRegime, marketAlignment, events, signalsStream],
        timeout: "2 minutes"
      }
    });

    new sst.aws.Cron("GenerateFinancialPolicy", {
      schedule: $dev ? "rate(15 minutes)" : "rate(1 hour)",
      function: {
        handler: "src/financialPolicy.generate",
        link: [marketPulseSnapshot, financialPolicyCache, anthropicApiKey],
        timeout: "5 minutes"
      }
    });

    new sst.aws.Cron("RefreshStockHistoricals", {
      schedule: "rate(1 day)",
      function: {
        handler: "src/stockEnrich.refreshHistoricals",
        link: [stocks, fmpApiKey],
        timeout: "15 minutes",
        memory: "1024 MB"
      }
    });

    new sst.aws.Cron("RefreshStockReturns", {
      schedule: "rate(5 minutes)",
      function: {
        handler: "src/stockEnrich.refreshReturns",
        link: [stocks, fmpApiKey],
        timeout: "5 minutes",
        memory: "1024 MB"
      }
    });

    new sst.aws.Cron("EnrichStockFundamentals", {
      schedule: "rate(2 hours)",
      function: {
        handler: "src/stockEnrich.enrichFundamentals",
        link: [stocks, fmpApiKey],
        timeout: "15 minutes",
        memory: "1024 MB"
      }
    });

    const api = new sst.aws.ApiGatewayV2("Api", {
      link: [
        stocks,
        positions,
        events,
        earnings,
        signalAlerts,
        marketPulse,
        marketPulseSnapshot,
        financialPolicyCache,
        marketRegime,
        marketAlignment,
        industries,
        processStock,
        apiBearerToken,
        fmpApiKey,
        pulseRefreshToken,
        anthropicApiKey,
        ticksStream,
        signalsStream,
        pulseEventsStream
      ],
      transform: {
        route: {
          handler: {
            runtime: "nodejs22.x"
          }
        }
      }
    });

    api.route("GET /", "src/api.health");
    api.route("GET /events", "src/events.list");

    if ($dev) {
      api.route("GET /docs", "src/docs.ui");
      api.route("GET /openapi.json", "src/docs.spec");
      api.route("GET /asyncapi", "src/asyncDocs.ui");
      api.route("GET /asyncapi.json", "src/asyncDocs.spec");
    }

    api.route("GET /stocks", "src/stocks.list");
    api.route("GET /stocks/{symbol}", "src/stocks.get");
    api.route("GET /stocks/{symbol}/narrative", "src/narrative.narrative");
    api.route("GET /stocks/{symbol}/narrative/{interval}", "src/movement.movement");
    api.route("GET /stocks/{symbol}/movement/{interval}", "src/movement.movement");
    api.route("GET /policy/prediction", "src/policy.prediction");

    api.route("GET /assessments", "src/assessments.list");
    api.route("GET /assessments/{strategy}", "src/assessments.get");
    api.route("POST /assessments/{strategy}/{narrative}", "src/assessments.assess");
    api.route("POST /stocks", "src/stocks.create");
    api.route("POST /stocks/batch", "src/stocks.batchCreate");
    api.route("POST /stocks/backfill", "src/stocks.backfillSymbolIndex");

    api.route("GET /earnings/{symbol}", "src/earnings.list");

    api.route("GET /alerts", "src/alerts.list");
    api.route("GET /alerts/{alertId}", "src/alerts.get");
    api.route("POST /alerts", "src/alerts.create");
    api.route("DELETE /alerts/{alertId}", "src/alerts.remove");

    api.route("GET /pulse", "src/pulse.list");
    api.route("GET /pulse/snapshot", "src/pulse.snapshot");
    api.route("GET /pulse/history", "src/pulse.history");
    api.route("GET /pulse/tile", "src/pulse.tile");
    api.route("GET /pulse/sectors", "src/pulse.sectors");
    api.route("POST /pulse/refresh", "src/pulse.refresh");
    api.route("GET /pulse/{region}", "src/pulse.get");

    api.route("POST /industries/backfill", "src/industries.backfill");
    api.route("GET /industries", "src/industries.list");
    api.route("GET /industries/performance", "src/industries.performance");
    api.route("GET /industries/{industry}", "src/industries.get");
    api.route("GET /industries/{industry}/performance", "src/industries.industryDetail");

    api.route("GET /regime", "src/regime.list");
    api.route("GET /regime/{scale}", "src/regime.getScale");
    api.route("POST /regime/items", "src/regime.createItem");
    api.route("POST /regime/{scale}/process", "src/regime.processScale");

    api.route("GET /alignment", "src/alignment.current");
    api.route("GET /alignment/history", "src/alignment.history");
    api.route("POST /alignment/align", "src/alignment.triggerAlign");

    api.route("GET /positions", "src/positions.list");
    api.route("GET /positions/{accountId}/{symbol}", "src/positions.get");
    api.route("POST /positions", "src/positions.create");

    const realtime = new sst.aws.ApiGatewayWebSocket("RealtimeApi");

    realtime.route("$connect", {
      handler: "src/wsConnection.connect",
      link: [wsConnections, apiBearerToken]
    });
    realtime.route("$disconnect", {
      handler: "src/wsConnection.disconnect",
      link: [wsConnections]
    });
    realtime.route("$default", {
      handler: "src/wsConnection.defaultRoute",
      link: [wsConnections]
    });

    const realtimeEndpoint = $interpolate`https://${realtime.url.apply((value: string) => value.replace(/^wss?:\/\//, "").replace(/\/$/, ""))}`;

    ticksStream.subscribe("BroadcastTicks", {
      handler: "src/streamConsumer.broadcastTicks",
      link: [wsConnections, realtime],
      environment: { WS_API_ENDPOINT: realtimeEndpoint },
      timeout: "1 minute"
    });
    signalsStream.subscribe("BroadcastSignals", {
      handler: "src/streamConsumer.broadcastSignals",
      link: [wsConnections, realtime],
      environment: { WS_API_ENDPOINT: realtimeEndpoint },
      timeout: "1 minute"
    });
    pulseEventsStream.subscribe("BroadcastPulseEvents", {
      handler: "src/streamConsumer.broadcastPulseEvents",
      link: [wsConnections, realtime],
      environment: { WS_API_ENDPOINT: realtimeEndpoint },
      timeout: "1 minute"
    });

    const apiBase = api.url.apply((value: string) => value.replace(/\/$/, ""));

    return {
      api: api.url,
      realtime: realtime.url,
      docs: $interpolate`${apiBase}/docs`,
      openapi: $interpolate`${apiBase}/openapi.json`,
      asyncDocs: $interpolate`${apiBase}/asyncapi`,
      asyncSpec: $interpolate`${apiBase}/asyncapi.json`,
      stocksTable: stocks.name,
      positionsTable: positions.name,
      eventsTable: events.name,
      earningsTable: earnings.name,
      signalAlertsTable: signalAlerts.name,
      marketPulseTable: marketPulse.name,
      marketPulseSnapshotTable: marketPulseSnapshot.name,
      marketRegimeTable: marketRegime.name,
      marketAlignmentTable: marketAlignment.name,
      processStockFunction: processStock.name
    };
  }
});
