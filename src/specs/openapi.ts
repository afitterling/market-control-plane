export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Market Control Plane API",
    version: "0.1.0",
    description:
      "Stocks, fundamentals, prices, signal alerts, market pulse, regime classification, and unified market state.",
    license: {
      name: "AGPL-3.0-or-later"
    }
  },
  servers: [{ url: "/", description: "Current deployment" }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: "Health" },
    { name: "Events" },
    { name: "Stocks" },
    { name: "Earnings" },
    { name: "Alerts" },
    { name: "Pulse" },
    { name: "Regime" },
    { name: "Alignment" },
    { name: "Positions" },
    { name: "Docs" }
  ],
  paths: {
    "/": {
      get: {
        tags: ["Health"],
        summary: "Service health probe",
        responses: {
          "200": {
            description: "Service is up",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Health" }
              }
            }
          },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/events": {
      get: {
        tags: ["Events"],
        summary: "List domain events (long-poll capable)",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } },
          { name: "after", in: "query", description: "Exclusive cursor", schema: { type: "string" } },
          { name: "from", in: "query", description: "Inclusive cursor", schema: { type: "string" } },
          { name: "waitSeconds", in: "query", schema: { type: "integer", maximum: 25 } }
        ],
        responses: {
          "200": {
            description: "Events page",
            content: { "application/json": { schema: { $ref: "#/components/schemas/EventsPage" } } }
          },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/stocks": {
      get: {
        tags: ["Stocks"],
        summary: "List tracked stocks",
        responses: {
          "200": { description: "Stocks list" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      },
      post: {
        tags: ["Stocks"],
        summary: "Create or upsert a stock",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/StockCreate" } } }
        },
        responses: {
          "201": { description: "Created" },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/stocks/batch": {
      post: {
        tags: ["Stocks"],
        summary: "Batch upsert stocks",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  stocks: {
                    type: "array",
                    items: { $ref: "#/components/schemas/StockCreate" }
                  }
                }
              }
            }
          }
        },
        responses: {
          "201": { description: "Batch created" },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/stocks/{symbol}": {
      get: {
        tags: ["Stocks"],
        summary: "Get a stock by symbol",
        parameters: [{ name: "symbol", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Stock" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" }
        }
      }
    },
    "/earnings/{symbol}": {
      get: {
        tags: ["Earnings"],
        summary: "Fundamentals by symbol",
        parameters: [{ name: "symbol", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Earnings/fundamentals" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/alerts": {
      get: {
        tags: ["Alerts"],
        summary: "List signal alerts",
        responses: {
          "200": { description: "Alerts" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      },
      post: {
        tags: ["Alerts"],
        summary: "Create a signal alert",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/AlertCreate" } } }
        },
        responses: {
          "201": { description: "Created" },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/alerts/{alertId}": {
      get: {
        tags: ["Alerts"],
        summary: "Get an alert by id",
        parameters: [{ name: "alertId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Alert" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" }
        }
      },
      delete: {
        tags: ["Alerts"],
        summary: "Delete an alert",
        parameters: [{ name: "alertId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Deleted" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/pulse": {
      get: {
        tags: ["Pulse"],
        summary: "List market pulse regions",
        responses: {
          "200": { description: "Pulse regions" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/pulse/{region}": {
      get: {
        tags: ["Pulse"],
        summary: "Get a single pulse region",
        parameters: [{ name: "region", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Pulse region" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" }
        }
      }
    },
    "/pulse/snapshot": {
      get: {
        tags: ["Pulse"],
        summary: "Latest unified pulse snapshot (overall + regions + market data)",
        responses: {
          "200": { description: "Snapshot" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/pulse/history": {
      get: {
        tags: ["Pulse"],
        summary: "Recent snapshots (max 100 retained)",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", maximum: 100 } }],
        responses: {
          "200": { description: "Snapshot history" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/pulse/refresh": {
      post: {
        tags: ["Pulse"],
        summary: "Force a pulse run (news + regions + market data + snapshot)",
        description:
          "Requires the PULSE_REFRESH_TOKEN via the X-Refresh-Token header; the regular Bearer token does not authorize this endpoint.",
        security: [{ refreshToken: [] }],
        responses: {
          "201": { description: "Run result with snapshot" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "500": { description: "Pulse refresh failed" }
        }
      }
    },
    "/regime": {
      get: {
        tags: ["Regime"],
        summary: "Latest regime per scale",
        responses: {
          "200": { description: "Regime overview" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/regime/{scale}": {
      get: {
        tags: ["Regime"],
        summary: "List items and computed regimes for a scale",
        parameters: [
          { name: "scale", in: "path", required: true, schema: { $ref: "#/components/schemas/RegimeScale" } },
          { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "kind", in: "query", schema: { type: "string", enum: ["item", "regime"] } },
          { name: "limit", in: "query", schema: { type: "integer", maximum: 200 } }
        ],
        responses: {
          "200": { description: "Items + regimes" },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/regime/items": {
      post: {
        tags: ["Regime"],
        summary: "Add a sentiment item; response includes latest regime and pulse",
        parameters: [
          {
            name: "recompute",
            in: "query",
            description: "If 'true', recompute regime synchronously",
            schema: { type: "string", enum: ["true", "false"] }
          }
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/RegimeItemCreate" } } }
        },
        responses: {
          "201": {
            description: "Item stored with latest regime + pulse",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/RegimeItemCreateResponse" } }
            }
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/regime/{scale}/process": {
      post: {
        tags: ["Regime"],
        summary: "Compute and persist regime for the given scale",
        parameters: [
          { name: "scale", in: "path", required: true, schema: { $ref: "#/components/schemas/RegimeScale" } }
        ],
        responses: {
          "200": { description: "Computed regime" },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/alignment": {
      get: {
        tags: ["Alignment"],
        summary: "Current unified market state (regime + pulse composite)",
        responses: {
          "200": {
            description: "Latest alignment",
            content: { "application/json": { schema: { $ref: "#/components/schemas/AlignmentEnvelope" } } }
          },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/alignment/history": {
      get: {
        tags: ["Alignment"],
        summary: "Recent alignment snapshots",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", maximum: 100 } }],
        responses: {
          "200": { description: "History" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/alignment/align": {
      post: {
        tags: ["Alignment"],
        summary: "Force an alignment run (otherwise cron-driven every 15m)",
        responses: {
          "201": { description: "New alignment" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "500": { description: "Alignment failed" }
        }
      }
    },
    "/positions": {
      get: {
        tags: ["Positions"],
        summary: "List positions",
        responses: {
          "200": { description: "Positions" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      },
      post: {
        tags: ["Positions"],
        summary: "Create or upsert a position",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: {
          "201": { description: "Created" },
          "401": { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/positions/{accountId}/{symbol}": {
      get: {
        tags: ["Positions"],
        summary: "Get a position",
        parameters: [
          { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          { name: "symbol", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": { description: "Position" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" }
        }
      }
    },
    "/docs": {
      get: {
        tags: ["Docs"],
        summary: "Swagger UI",
        security: [],
        responses: { "200": { description: "HTML UI" } }
      }
    },
    "/openapi.json": {
      get: {
        tags: ["Docs"],
        summary: "OpenAPI spec",
        security: [],
        responses: { "200": { description: "OpenAPI 3 document" } }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "API_BEARER_TOKEN configured on the deployment"
      },
      refreshToken: {
        type: "apiKey",
        in: "header",
        name: "X-Refresh-Token",
        description: "PULSE_REFRESH_TOKEN configured on the deployment; only authorizes /pulse/refresh"
      }
    },
    responses: {
      Unauthorized: {
        description: "Missing or invalid bearer token",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
      },
      BadRequest: {
        description: "Invalid input",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
      },
      NotFound: {
        description: "Resource not found",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
      }
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string" },
          details: {}
        }
      },
      Health: {
        type: "object",
        properties: {
          service: { type: "string" },
          status: { type: "string" },
          path: { type: "string" },
          time: { type: "string", format: "date-time" }
        }
      },
      EventsPage: {
        type: "object",
        properties: {
          count: { type: "integer" },
          events: { type: "array", items: { type: "object" } },
          nextCursor: { type: "string" }
        }
      },
      StockCreate: {
        type: "object",
        required: ["symbol"],
        properties: {
          symbol: { type: "string" },
          name: { type: "string" },
          exchange: { type: "string" },
          sector: { type: "string" }
        }
      },
      AlertCreate: {
        type: "object",
        required: ["name", "sessions"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          enabled: { type: "boolean" },
          sessions: {
            type: "array",
            items: { type: "string", enum: ["premarket", "regular", "afterhours"] }
          },
          scope: {
            type: "object",
            properties: { symbols: { type: "array", items: { type: "string" } } }
          },
          condition: {}
        }
      },
      RegimeScale: {
        type: "string",
        enum: ["intraday", "daily", "weekly", "monthly", "quarterly"]
      },
      RegimeClassification: {
        type: "string",
        enum: ["risk_off", "bearish", "neutral", "bullish", "risk_on"]
      },
      PulseStatus: {
        type: "string",
        enum: ["calm", "watch", "elevated", "critical"]
      },
      RegimeItemCreate: {
        type: "object",
        required: ["scale", "source", "sentiment"],
        properties: {
          scale: { $ref: "#/components/schemas/RegimeScale" },
          source: { type: "string" },
          sentiment: { type: "number", minimum: -100, maximum: 100 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          weight: { type: "number", minimum: 0 },
          themes: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          observedAt: { type: "string", format: "date-time" }
        }
      },
      RegimeItem: {
        type: "object",
        properties: {
          scale: { $ref: "#/components/schemas/RegimeScale" },
          itemId: { type: "string" },
          source: { type: "string" },
          sentiment: { type: "number" },
          confidence: { type: "number" },
          weight: { type: "number" },
          themes: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          observedAt: { type: "string", format: "date-time" },
          createdAt: { type: "string", format: "date-time" }
        }
      },
      Regime: {
        type: "object",
        properties: {
          scale: { $ref: "#/components/schemas/RegimeScale" },
          classification: { $ref: "#/components/schemas/RegimeClassification" },
          score: { type: "number" },
          itemCount: { type: "integer" },
          windowStart: { type: "string", format: "date-time" },
          windowEnd: { type: "string", format: "date-time" },
          topThemes: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          computedAt: { type: "string", format: "date-time" }
        }
      },
      PulseRegion: {
        type: "object",
        properties: {
          region: { type: "string" },
          status: { $ref: "#/components/schemas/PulseStatus" },
          criticality: { type: "number" },
          severity: { type: "number" },
          articleCount: { type: "integer" },
          topThemes: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          stale: { type: "boolean" },
          updatedAt: { type: "string", format: "date-time" }
        }
      },
      RegimeItemCreateResponse: {
        type: "object",
        properties: {
          item: { $ref: "#/components/schemas/RegimeItem" },
          regime: { $ref: "#/components/schemas/Regime", nullable: true },
          pulse: {
            type: "object",
            properties: {
              count: { type: "integer" },
              regions: { type: "array", items: { $ref: "#/components/schemas/PulseRegion" } }
            }
          }
        }
      },
      AlignmentEnvelope: {
        type: "object",
        properties: {
          alignment: {
            type: "object",
            nullable: true,
            properties: {
              scope: { type: "string" },
              alignedAt: { type: "string", format: "date-time" },
              regimes: { type: "array", items: { $ref: "#/components/schemas/Regime" } },
              pulse: { type: "array", items: { $ref: "#/components/schemas/PulseRegion" } },
              composite: {
                type: "object",
                properties: {
                  riskLevel: { type: "string", enum: ["low", "medium", "high", "extreme"] },
                  bias: { $ref: "#/components/schemas/RegimeClassification" },
                  biasScore: { type: "number" },
                  pulseRiskScore: { type: "number" },
                  hotRegions: { type: "array", items: { type: "string" } },
                  summary: { type: "string" }
                }
              }
            }
          }
        }
      }
    }
  }
} as const;
