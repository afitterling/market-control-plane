import "sst";

declare module "sst" {
  export interface Resource {
    API_BEARER_TOKEN: {
      value: string;
      type: "sst.sst.Secret";
    };
    FMP_API_KEY: {
      value: string;
      type: "sst.sst.Secret";
    };
    PULSE_REFRESH_TOKEN: {
      value: string;
      type: "sst.sst.Secret";
    };
    Stocks: {
      name: string;
      type: "sst.aws.Dynamo";
    };
    Industries: {
      name: string;
      type: "sst.aws.Dynamo";
    };
    WsConnections: {
      name: string;
      type: "sst.aws.Dynamo";
    };
    Ticks: {
      name: string;
      type: "sst.aws.KinesisStream";
    };
    Signals: {
      name: string;
      type: "sst.aws.KinesisStream";
    };
    PulseEvents: {
      name: string;
      type: "sst.aws.KinesisStream";
    };
    RealtimeApi: {
      url: string;
      managementEndpoint: string;
      type: "sst.aws.ApiGatewayWebSocket";
    };
    Positions: {
      name: string;
      type: "sst.aws.Dynamo";
    };
    Events: {
      name: string;
      type: "sst.aws.Dynamo";
    };
    Earnings: {
      name: string;
      type: "sst.aws.Dynamo";
    };
    SignalAlerts: {
      name: string;
      type: "sst.aws.Dynamo";
    };
    MarketPulse: {
      name: string;
      type: "sst.aws.Dynamo";
    };
    MarketPulseSnapshot: {
      name: string;
      type: "sst.aws.Dynamo";
    };
    MarketRegime: {
      name: string;
      type: "sst.aws.Dynamo";
    };
    MarketAlignment: {
      name: string;
      type: "sst.aws.Dynamo";
    };
    ProcessStock: {
      name: string;
      type: "sst.aws.Function";
    };
  }
}
