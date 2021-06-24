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

  market?: string;

  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
};

export type TimeRange = {
  from: number;
  to: number;

  pairs: Pair[];
  exchanges: string[];
};

export type TradeAggregations = { [aggrIdentifier: string]: Trade };
