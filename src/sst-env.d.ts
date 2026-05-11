import "sst";

declare module "sst" {
  export interface Resource {
    ApiBearerToken: {
      value: string;
      type: "sst.sst.Secret";
    };
    FmpApiKey: {
      value: string;
      type: "sst.sst.Secret";
    };
    PulseRefreshToken: {
      value: string;
      type: "sst.sst.Secret";
    };
    Stocks: {
      name: string;
      type: "sst.aws.Dynamo";
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
