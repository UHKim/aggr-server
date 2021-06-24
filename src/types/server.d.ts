export type WSConnectionList = {
  [exchangeAndPair: string]: {
    exchange: string;
    pair: string;
    apiId: string;
    hit: number;

    timestamp: number;

    ping?: number;
    remote?: string;
  };
};

export type Pair = string;
export type Pairs = Pair[];
