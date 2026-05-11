export const asyncApiSpec = {
  asyncapi: "3.0.0",
  info: {
    title: "Market Control Plane — Streams & Realtime",
    version: "0.1.0",
    description:
      "Event-driven surface of the market-control-plane. Three Kinesis Data Streams (Ticks, Signals, PulseEvents) carry high-volume events; a WebSocket API (RealtimeApi) fans them out to subscribed clients with optional per-symbol / per-region / per-kind filters.",
    contact: { name: "Market Control Plane" },
    license: { name: "AGPL-3.0-or-later" }
  },

  servers: {
    realtime: {
      host: "{realtimeHost}",
      protocol: "wss",
      description:
        "ApiGatewayWebSocket fan-out. URL is the SST stack output `realtime`. Authenticate at $connect with `?token=<API_BEARER_TOKEN>`; optional `?channels=ticks,signals,pulse-events` pre-selects subscriptions.",
      variables: {
        realtimeHost: {
          default: "<RealtimeApi-id>.execute-api.<region>.amazonaws.com",
          description: "RealtimeApi host (no scheme, no trailing slash)."
        }
      },
      security: [{ $ref: "#/components/securitySchemes/bearerQuery" }]
    },
    kinesis: {
      host: "kinesis.<region>.amazonaws.com",
      protocol: "kinesis",
      description:
        "AWS Kinesis Data Streams. Direct consumer access via SDK / KCL / AWS CLI requires IAM with kinesis:GetRecords on the target stream."
    }
  } as Record<string, unknown>,

  channels: {
    "ticks-stream": {
      address: "Ticks",
      title: "Ticks (Kinesis stream)",
      description:
        "Per-symbol quote stream produced after every PullPrices batch. Partition key = symbol; ordering is guaranteed per symbol within a shard.",
      messages: { tickRecord: { $ref: "#/components/messages/TickRecord" } },
      bindings: {
        kinesis: {
          streamName: "Ticks"
        }
      }
    },
    "signals-stream": {
      address: "Signals",
      title: "Signals (Kinesis stream)",
      description:
        "Regime / alignment / alert state-change emissions. Partition key = kind.",
      messages: { signalRecord: { $ref: "#/components/messages/SignalRecord" } },
      bindings: {
        kinesis: {
          streamName: "Signals"
        }
      }
    },
    "pulse-events-stream": {
      address: "PulseEvents",
      title: "PulseEvents (Kinesis stream)",
      description:
        "Pulse snapshots and region updates. Partition key = region (or type when region is absent).",
      messages: { pulseEventRecord: { $ref: "#/components/messages/PulseEventRecord" } },
      bindings: {
        kinesis: {
          streamName: "PulseEvents"
        }
      }
    },

    "ws-connect": {
      address: "$connect",
      title: "WebSocket $connect",
      description:
        "Initial WebSocket handshake. Pass `token` (required) and optional `channels` CSV in the query string. Server validates the token via timing-safe compare against API_BEARER_TOKEN.",
      servers: [{ $ref: "#/servers/realtime" }]
    },
    "ws-control": {
      address: "$default",
      title: "WebSocket control channel",
      description: "Client → server frames to manage subscriptions on an open connection.",
      servers: [{ $ref: "#/servers/realtime" }],
      messages: {
        subscribe: { $ref: "#/components/messages/SubscribeFrame" },
        unsubscribe: { $ref: "#/components/messages/UnsubscribeFrame" }
      }
    },
    "ws-data": {
      address: "$default",
      title: "WebSocket data channel",
      description: "Server → client frames carrying acks and decoded stream records.",
      servers: [{ $ref: "#/servers/realtime" }],
      messages: {
        ack: { $ref: "#/components/messages/AckFrame" },
        event: { $ref: "#/components/messages/EventFrame" }
      }
    }
  },

  operations: {
    receiveTicks: {
      action: "receive",
      channel: { $ref: "#/channels/ticks-stream" },
      summary: "Consume per-symbol quote ticks",
      description:
        "Open a shard iterator (LATEST or TRIM_HORIZON) and call GetRecords, or attach a Lambda subscriber via sst.aws.KinesisStream.subscribe."
    },
    receiveSignals: {
      action: "receive",
      channel: { $ref: "#/channels/signals-stream" },
      summary: "Consume regime / alignment / alert signals"
    },
    receivePulseEvents: {
      action: "receive",
      channel: { $ref: "#/channels/pulse-events-stream" },
      summary: "Consume pulse snapshots and region updates"
    },

    sendSubscribe: {
      action: "send",
      channel: { $ref: "#/channels/ws-control" },
      summary: "Subscribe to channels with optional filters",
      messages: [{ $ref: "#/components/messages/SubscribeFrame" }]
    },
    sendUnsubscribe: {
      action: "send",
      channel: { $ref: "#/channels/ws-control" },
      summary: "Unsubscribe from all channels",
      messages: [{ $ref: "#/components/messages/UnsubscribeFrame" }]
    },
    receiveAck: {
      action: "receive",
      channel: { $ref: "#/channels/ws-data" },
      summary: "Acknowledgement of a subscribe/unsubscribe request",
      messages: [{ $ref: "#/components/messages/AckFrame" }]
    },
    receiveEvent: {
      action: "receive",
      channel: { $ref: "#/channels/ws-data" },
      summary: "Decoded Kinesis record fanned out to subscribed connections",
      messages: [{ $ref: "#/components/messages/EventFrame" }]
    }
  },

  components: {
    securitySchemes: {
      bearerQuery: {
        type: "apiKey",
        in: "query",
        name: "token",
        description:
          "Value of the API_BEARER_TOKEN SST secret. Use a short-lived per-user token in production rather than embedding the static secret in the browser."
      }
    },

    messages: {
      TickRecord: {
        name: "TickRecord",
        title: "Tick",
        summary: "One real-time quote published to the Ticks stream.",
        contentType: "application/json",
        payload: { $ref: "#/components/schemas/TickRecord" }
      },
      SignalRecord: {
        name: "SignalRecord",
        title: "Signal",
        summary: "Regime / alignment / alert state change published to the Signals stream.",
        contentType: "application/json",
        payload: { $ref: "#/components/schemas/SignalRecord" }
      },
      PulseEventRecord: {
        name: "PulseEventRecord",
        title: "Pulse event",
        summary: "Pulse snapshot or region update published to the PulseEvents stream.",
        contentType: "application/json",
        payload: { $ref: "#/components/schemas/PulseEventRecord" }
      },
      SubscribeFrame: {
        name: "SubscribeFrame",
        title: "subscribe",
        summary: "Open-socket subscribe request",
        contentType: "application/json",
        payload: { $ref: "#/components/schemas/SubscribeFrame" }
      },
      UnsubscribeFrame: {
        name: "UnsubscribeFrame",
        title: "unsubscribe",
        summary: "Open-socket unsubscribe request",
        contentType: "application/json",
        payload: { $ref: "#/components/schemas/UnsubscribeFrame" }
      },
      AckFrame: {
        name: "AckFrame",
        title: "ack",
        summary: "Server acknowledgement of a subscribe/unsubscribe action",
        contentType: "application/json",
        payload: { $ref: "#/components/schemas/AckFrame" }
      },
      EventFrame: {
        name: "EventFrame",
        title: "event",
        summary: "Server-pushed decoded Kinesis record",
        contentType: "application/json",
        payload: { $ref: "#/components/schemas/EventFrame" }
      }
    },

    schemas: {
      TickRecord: {
        type: "object",
        required: ["symbol", "price", "at"],
        properties: {
          symbol: { type: "string", example: "AAPL" },
          price: { type: "number", example: 187.42 },
          changePercent: { type: "number", example: 0.34 },
          source: { type: "string", example: "pullPrices" },
          at: { type: "string", format: "date-time" }
        }
      },
      SignalRecord: {
        type: "object",
        required: ["kind", "at"],
        properties: {
          kind: { type: "string", enum: ["regime", "alignment", "alert"] },
          status: { type: "string" },
          bias: { type: "string", example: "defensive" },
          riskLevel: { type: "string", example: "elevated" },
          alertId: { type: "string" },
          payload: { type: "object", additionalProperties: true },
          at: { type: "string", format: "date-time" }
        }
      },
      PulseEventRecord: {
        type: "object",
        required: ["type", "at"],
        properties: {
          type: { type: "string", example: "PULSE_SNAPSHOT_TAKEN" },
          region: { type: "string", example: "United States" },
          status: { type: "string", enum: ["calm", "watch", "elevated", "critical"] },
          score: { type: "number", example: 62 },
          payload: { type: "object", additionalProperties: true },
          at: { type: "string", format: "date-time" }
        }
      },
      Filters: {
        type: "object",
        description: "Server-side per-connection filter applied before fan-out.",
        properties: {
          symbols: { type: "array", items: { type: "string" } },
          regions: { type: "array", items: { type: "string" } },
          kinds: { type: "array", items: { type: "string" } }
        },
        additionalProperties: false
      },
      SubscribeFrame: {
        type: "object",
        required: ["action", "channels"],
        properties: {
          action: { type: "string", const: "subscribe" },
          channels: {
            type: "array",
            items: { type: "string", enum: ["ticks", "signals", "pulse-events"] }
          },
          filters: { $ref: "#/components/schemas/Filters" }
        }
      },
      UnsubscribeFrame: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", const: "unsubscribe" },
          channels: { type: "array", items: { type: "string" } }
        }
      },
      AckFrame: {
        type: "object",
        required: ["type", "action", "channels"],
        properties: {
          type: { type: "string", const: "ack" },
          action: { type: "string", enum: ["subscribe", "unsubscribe"] },
          channels: { type: "array", items: { type: "string" } },
          filters: { $ref: "#/components/schemas/Filters" }
        }
      },
      EventFrame: {
        type: "object",
        required: ["type", "channel", "data"],
        properties: {
          type: { type: "string", const: "event" },
          channel: { type: "string", enum: ["ticks", "signals", "pulse-events"] },
          data: {
            oneOf: [
              { $ref: "#/components/schemas/TickRecord" },
              { $ref: "#/components/schemas/SignalRecord" },
              { $ref: "#/components/schemas/PulseEventRecord" }
            ]
          }
        }
      }
    }
  }
} as const;
