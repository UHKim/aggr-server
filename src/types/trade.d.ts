export type Trade = {
  exchange: string;
  pair: string;
  timestamp: number;
  price: number;
  size: number;
  side: number;
  liquidation?: boolean;

  timeout?: number;
};

export type Bar = {
  time: number;
  exchange: string;
  pair: string;
  cbuy: number;
  csell: number;
  vbuy: number;
  vsell: number;
  lbuy: number;
  lsell: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type TimeRange = {
  from: number;
  to: number;
};

export type TradeAggregations = { [aggrIdentifier: string]: Trade };
