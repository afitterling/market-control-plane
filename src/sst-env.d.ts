import "sst";

declare module "sst" {
  export interface Resource {
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
    ProcessStock: {
      name: string;
      type: "sst.aws.Function";
    };
  }
}
