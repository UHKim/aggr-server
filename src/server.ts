import EventEmitter from 'events';
import WSServer from 'ws';
import fs from 'fs';
import { getIp, getHms, parsePairsFromWsRequest, groupTrades, ago } from './helper';
import express from 'express';
import path from 'path';
import rateLimit from 'express-rate-limit';
import axios from 'axios';

import { Trade, TradeAggregations } from './types/trade';
import { Pairs, WSConnectionList } from './types/server';

interface WebSocketServer extends WSServer.Server {
  clients: Set<WSServer & { pairs: Pairs }>;
}

class Server extends EventEmitter {
  options: any;
  exchanges: any[] = [];
  indexedProducts: {};
  storages: any;
  /**
   * Raw trades ready to be persisted into storage next save
   */
  chunk: Trade[];

  /**
   * Keep track of all active connections (exchange + symbol)
   */
  connections: WSConnectionList;

  /**
   * delayedForBroadcast trades ready to be broadcasted next interval (see _broadcastDelayedTradesInterval)
   */
  delayedForBroadcast: Trade[];

  /**
   * active trades aggregations
   */
  aggregating: TradeAggregations;

  /**
   * already aggregated trades ready to be broadcasted (see _broadcastAggregatedTradesInterval)
   */
  aggregated: Trade[];
  BANNED_IPS: string[];

  backupTimeout: NodeJS.Timeout | undefined;
  wss: WebSocketServer | undefined;
  server: import('http').Server | import('https').Server | undefined;
  app: Function | undefined;

  _activityMonitoringInterval: NodeJS.Timeout | undefined;
  _broadcastAggregatedTradesInterval: NodeJS.Timeout | undefined;
  _dumpConnectionsTimeout: any;
  _broadcastDelayedTradesInterval: NodeJS.Timeout | undefined;

  symbols: any;

  constructor(options: any, exchanges: any[]) {
    super();

    this.options = options;
    this.exchanges = exchanges;
    this.indexedProducts = {};
    this.storages = null;

    this.chunk = [];
    this.connections = {};
    this.delayedForBroadcast = [];
    this.aggregating = {};
    this.aggregated = [];
    this.BANNED_IPS = [];

    this.initStorages().then(() => {
      if (this.options.collect) {
        console.log(
          `\n[server] collect is enabled`,
          this.options.broadcast && this.options.broadcastAggr
            ? '\n\twill aggregate every trades that came on same ms (impact only broadcast)'
            : '',
          this.options.broadcast && this.options.broadcastDebounce
            ? `\n\twill broadcast trades every ${this.options.broadcastDebounce}ms`
            : this.options.broadcast
            ? `will broadcast trades instantly`
            : '',
        );
        console.log(`\tconnect to -> ${this.exchanges.map((a: { id: any }) => a.id).join(', ')}`);

        this.handleExchangesEvents();
        this.connectExchanges();

        // profile exchanges connections (keep alive)
        this._activityMonitoringInterval = setInterval(
          this.monitorExchangesActivity.bind(this, +new Date()),
          1000 * 60,
        );

        if (this.storages) {
          const delay = this.scheduleNextBackup();

          console.log(
            `[server] scheduling first save to ${this.storages.map(
              (storage: { constructor: { name: any } }) => storage.constructor.name,
            )} in ${getHms(delay || new Date().getTime())}...`,
          );
        }
      }

      if (this.options.api || this.options.broadcast) {
        this.createHTTPServer();
      }

      if (this.options.broadcast) {
        this.createWSServer();

        if (this.options.broadcastAggr) {
          this._broadcastAggregatedTradesInterval = setInterval(
            this.broadcastAggregatedTrades.bind(this),
            50,
          );
        }
      }

      // update banned ip
      this.listenBannedIps();
    });
  }

  initStorages() {
    if (!this.options.storage) {
      return Promise.resolve();
    }

    this.storages = [];

    const promises: Promise<any>[] = [];

    for (let name of this.options.storage) {
      console.log(`[storage] Using "${name}" storage solution`);

      if (
        this.options.api &&
        this.options.storage.length > 1 &&
        !this.options.storage.indexOf(name)
      ) {
        console.log(`[storage] Set "${name}" as primary storage for API`);
      }

      let storage = new (require(`./storage/${name}`))(this.options);

      if (typeof storage.connect === 'function') {
        promises.push(storage.connect());
      } else {
        promises.push(Promise.resolve());
      }

      this.storages.push(storage);
    }

    return Promise.all(promises);
  }

  async backupTrades(exitBackup: any) {
    if (!this.storages || !this.chunk.length) {
      this.scheduleNextBackup();
      return Promise.resolve();
    }

    const chunk = this.chunk.splice(0, this.chunk.length);

    try {
      await Promise.all(
        this.storages.map(
          (storage: {
            save: (arg0_1: any[]) => Promise<any>;
            constructor: { name: any };
            name: any;
          }) =>
            storage
              .save(chunk)
              .then(() => {
                if (exitBackup) {
                  console.log(
                    `[server/exit] performed backup of ${chunk.length} trades into ${storage.constructor.name}`,
                  );
                }
              })
              .catch((err: any) => {
                console.error(`[storage/${storage.name}] saving failure`, err);
              }),
        ),
      );
      if (!exitBackup) {
        this.scheduleNextBackup();
      }
    } catch (err_1) {
      console.error(`[server] something went wrong while backuping trades...`, err_1);
    }
  }

  scheduleNextBackup() {
    if (!this.storages) {
      return;
    }

    const now = new Date().getTime();
    let delay =
      Math.ceil(now / this.options.backupInterval) * this.options.backupInterval - now - 20;

    if (delay < 1000) {
      delay += this.options.backupInterval;
    }

    this.backupTimeout = setTimeout(this.backupTrades.bind(this), delay);

    return delay;
  }

  handleExchangesEvents() {
    this.exchanges.forEach(
      (exchange: {
        on: (
          arg0: string,
          arg1:
            | ((event: { message: string } | any) => void)
            | ((pair: string, apiId: string) => void),
        ) => void;
        id: string;
      }) => {
        if (this.options.broadcast && this.options.broadcastAggr) {
          exchange.on('trades', this.dispatchAggregateTrade.bind(this, exchange.id));
        } else {
          exchange.on('trades', this.dispatchRawTrades.bind(this, exchange.id));
        }

        exchange.on('liquidations', this.dispatchRawTrades.bind(this, exchange.id));

        exchange.on('index', (pairs: any) => {
          for (let pair of pairs) {
            if (this.indexedProducts[pair]) {
              this.indexedProducts[pair].count++;

              if (this.indexedProducts[pair].exchanges.indexOf(exchange.id) === -1) {
                this.indexedProducts[pair].exchanges.push(exchange.id);
              }
            } else {
              this.indexedProducts[pair] = {
                value: pair,
                count: 1,
                exchanges: [exchange.id],
              };
            }
          }

          this.dumpSymbolsByExchanges();
        });

        exchange.on('open', (event: any) => {
          this.broadcastJson({
            type: 'exchange_connected',
            id: exchange.id,
          });
        });

        exchange.on('disconnected', (pair: string) => {
          const id = exchange.id + ':' + pair;

          if (!this.connections[id]) {
            console.error(
              `[server] couldn't delete connection ${id} because the connections[${id}] does not exists`,
            );
            return;
          }

          console.log(`[server] deleted connection ${id}`);

          delete this.connections[id];

          this.dumpConnections();
        });

        exchange.on('connected', (pair: string, apiId: string) => {
          const id = exchange.id + ':' + pair;

          if (this.connections[id]) {
            console.error(
              `[server] couldn't register connection ${id} because the connections[${id}] does not exists`,
            );
            return;
          }

          console.log(`[server] registered connection ${id}`);

          this.connections[id] = {
            apiId,
            exchange: exchange.id,
            pair: pair,
            hit: 0,
            timestamp: new Date().getTime(),
          };

          this.dumpConnections();
        });

        exchange.on('err', (event) => {
          this.broadcastJson({
            type: 'exchange_error',
            id: exchange.id,
            message: event.message,
          });
        });

        exchange.on('close', (event: any) => {
          this.broadcastJson({
            type: 'exchange_disconnected',
            id: exchange.id,
          });
        });
      },
    );
  }

  createWSServer() {
    if (!this.options.broadcast) {
      return;
    }

    this.wss = new WSServer.Server({
      server: this.server,
    }) as WebSocketServer;

    this.wss.on('listening', () => {
      console.log(`[server] websocket server listening at localhost:${this.options.port}`);
    });

    this.wss.on('connection', (ws: WSServer & { pairs: string[] }, req) => {
      const ip = getIp(req);
      const pairs = parsePairsFromWsRequest(req);

      if (pairs && pairs.length) {
        ws.pairs = pairs;
      }

      ws.pairs = pairs;

      const data = {
        type: 'welcome',
        supportedPairs: Object.values(this.connection).map((a) => a.exchange + ':' + a.pair),
        timestamp: +new Date(),
        exchanges: this.exchanges.map((exchange: { id: any; apis: any[] }) => {
          return {
            id: exchange.id,
            connected: exchange.apis.reduce((pairs: string | any[], api: { _connected: any }) => {
              pairs.concat(api._connected);
              return pairs;
            }),
          };
        }),
      };

      console.log(
        `[${ip}/ws/${ws.pairs.join('+')}] joined ${req.url} from ${req.headers['origin']}`,
      );

      this.emit('connections', this.wss?.clients.size);

      ws.send(JSON.stringify(data));

      ws.on('message', (event) => {
        const message = event.toString().trim();

        const pairs = message.length
          ? message
              .split('+')
              .map((a: string) => a.trim())
              .filter((a: string | any[]) => a.length)
          : [];

        console.log(`[${ip}/ws] subscribe to ${pairs.join(' + ')}`);

        ws.pairs = pairs;
      });

      ws.on('close', (event) => {
        let errorMessage: string | null = null;

        switch (event) {
          case 1002:
            errorMessage = 'Protocol Error';
            break;
          case 1003:
            errorMessage = 'Unsupported Data';
            break;
          case 1007:
            errorMessage = 'Invalid frame payload data';
            break;
          case 1008:
            errorMessage = 'Policy Violation';
            break;
          case 1009:
            errorMessage = 'Message too big';
            break;
          case 1010:
            errorMessage = 'Missing Extension';
            break;
          case 1011:
            errorMessage = 'Internal Error';
            break;
          case 1012:
            errorMessage = 'Service Restart';
            break;
          case 1013:
            errorMessage = 'Try Again Later';
            break;
          case 1014:
            errorMessage = 'Bad Gateway';
            break;
          case 1015:
            errorMessage = 'TLS Handshake';
            break;
        }

        if (errorMessage) {
          console.log(`[${ip}] unusual close "${errorMessage}"`);
        }

        setTimeout(() => this.emit('connections', this.wss?.clients.size), 100);
      });
    });
  }
  connection(connection: any) {
    throw new Error('Method not implemented.');
  }

  createHTTPServer() {
    const app = express();

    if (this.options.enableRateLimit) {
      const limiter = rateLimit({
        windowMs: this.options.rateLimitTimeWindow,
        max: this.options.rateLimitMax,
        handler: function (
          req: any,
          res: {
            status: (arg0: number) => {
              (): any;
              new (): any;
              json: { (arg0: { error: string }): any; new (): any };
            };
          },
        ) {
          return res.status(429).json({
            error: 'too many requests :v',
          });
        },
      });

      // otherwise ip are all the same
      app.set('trust proxy', 1);

      // apply to all requests
      app.use(limiter);
    }

    app.all('/*', (req, res, next) => {
      var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

      if (req.headers['origin'] && !new RegExp(this.options.origin).test(req.headers['origin'])) {
        console.error(`[${ip}/BLOCKED] socket origin mismatch "${req.headers['origin']}"`);
        setTimeout(() => {
          return res.status(500).json({
            error: 'ignored',
          });
        }, 5000 + Math.random() * 5000);
      } else if (this.BANNED_IPS.indexOf(ip) !== -1) {
        console.error(`[${ip}/BANNED] at "${req.url}" from "${req.headers['origin']}"`);

        setTimeout(() => {
          return res.status(500).json({
            error: 'ignored',
          });
        }, 5000 + Math.random() * 5000);
      } else {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Headers', 'X-Requested-With');
        next();
      }
    });

    app.get('/', function (req, res) {
      res.json({
        message: 'hi',
      });
    });

    app.get('/:pair/volume', (req, res) => {
      let pair = req.params.pair;

      if (!/[a-zA-Z]+/.test(pair)) {
        return res.status(400).json({
          error: `invalid pair`,
        });
      }

      this.getRatio(pair)
        .then((ratio: any) => {
          res.status(500).json({
            pair,
            ratio,
          });
        })
        .catch((error: { message: any }) => {
          return res.status(500).json({
            error: `no info (${error.message})`,
          });
        });
    });

    app.get('/historical/:from/:to/:timeframe?/:markets([^/]*)?', (req, res) => {
      const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      let { from, to, timeframe } = req.params;
      let markets = req.params.markets || [];

      if (typeof markets === 'string') {
        markets = markets
          .split('+')
          .map((a) => a.trim())
          .filter((a) => a.length);
      }

      if (!this.options.api || !this.storages) {
        return res.status(501).json({
          error: 'no storage',
        });
      }

      const storage = this.storages[0];

      if (isNaN(from) || isNaN(to)) {
        return res.status(400).json({
          error: 'missing interval',
        });
      }

      if (storage.format === 'point') {
        timeframe = parseInt(timeframe) || 1000 * 60; // default to 1m

        from = Math.floor(from / timeframe) * timeframe;
        to = Math.ceil(to / timeframe) * timeframe;

        const length = (to - from) / timeframe;

        if (length > this.options.maxFetchLength) {
          return res.status(400).json({
            error: 'too many bars',
          });
        }
      } else {
        from = parseInt(from);
        to = parseInt(to);
      }

      if (from > to) {
        let _from = parseInt(from);
        from = parseInt(to);
        to = _from;
      }

      const fetchStartAt = +new Date();

      (storage
        ? storage.fetch({
            from,
            to,
            timeframe,
            markets,
          })
        : Promise.resolve([])
      )
        .then((output: any[]) => {
          if (to - from > 1000 * 60) {
            console.log(
              `[${ip}] requesting ${getHms(to - from)} (${output.length} ${
                storage.format
              }s, took ${getHms(+new Date() - fetchStartAt)})`,
            );
          }

          if (storage.format === 'trade') {
            for (let i = 0; i < this.chunk.length; i++) {
              if (this.chunk[i][1] <= from || this.chunk[i][1] >= to) {
                continue;
              }

              output.push(this.chunk[i]);
            }
          }

          return res.status(200).json({
            format: storage.format,
            results: output,
          });
        })
        .catch((error: { message: any }) => {
          return res.status(500).json({
            error: error.message,
          });
        });
    });

    this.server = app.listen(this.options.port, () => {
      console.log(
        `[server] http server listening at localhost:${this.options.port}`,
        !this.options.api ? '(historical api is disabled)' : '',
      );
    });

    this.app = app;
  }

  dumpConnections(pingThreshold: number = 0) {
    if (typeof this._dumpConnectionsTimeout !== 'undefined') {
      clearTimeout(this._dumpConnectionsTimeout);
      delete this._dumpConnectionsTimeout;
    }

    const now = +new Date();

    this._dumpConnectionsTimeout = setTimeout(() => {
      const structPairs = {};

      for (let id in this.connections) {
        const connection = this.connections[id];

        if (pingThreshold && now - connection.timestamp < pingThreshold) {
          continue;
        }

        structPairs[connection.exchange + ':' + connection.pair] = {
          exchange: connection.exchange,
          pair: connection.pair,
          hit: connection.hit,
          ping: connection.hit ? ago(connection.timestamp) : 'never',
        };
      }

      console.table(structPairs);
    }, 5000);

    return Promise.resolve();
  }

  connectExchanges() {
    if (!this.exchanges.length || !this.options.pairs.length) {
      return;
    }

    this.chunk = [];

    const exchangesProductsResolver = Promise.all(
      this.exchanges.map((exchange: { id: string; getProductsAndConnect: (arg0: any) => any }) => {
        const exchangePairs = this.options.pairs.filter(
          (pair: string | string[]) =>
            pair.indexOf(':') === -1 || new RegExp('^' + exchange.id + ':').test(pair as string),
        );

        if (!exchangePairs.length) {
          return Promise.resolve();
        }

        return exchange.getProductsAndConnect(exchangePairs);
      }),
    );

    exchangesProductsResolver.then(() => {
      this.dumpConnections();
    });

    if (this.options.broadcast && this.options.broadcastDebounce && !this.options.broadcastAggr) {
      this._broadcastDelayedTradesInterval = setInterval(() => {
        if (!this.delayedForBroadcast.length) {
          return;
        }

        this.broadcastTrades(this.delayedForBroadcast);

        this.delayedForBroadcast = [];
      }, this.options.broadcastDebounce || 1000);
    }
  }

  /**
   * Trigger subscribe to pairs on all activated exchanges
   * @param {string[]} pairs
   * @returns {Promise<any>} promises of connections
   * @memberof Server
   */
  async connectPairs(pairs: any[]): Promise<any> {
    console.log(`[server] connect to ${pairs.join(',')}`);

    const promises: Promise<any>[] = [];

    for (let exchange of this.exchanges) {
      for (let pair of pairs) {
        promises.push(
          exchange.link(pair).catch((err: any) => {
            console.debug(`[server/connectPairs/${exchange.id}] ${err}`);

            if (err instanceof Error) {
              console.error(err);
            }
          }),
        );
      }
    }

    await Promise.all(promises);
  }

  /**
   * Trigger unsubscribe to pairs on all activated exchanges
   * @param {string[]} pairs
   * @returns {Promise<void>} promises of disconnection
   * @memberof Server
   */
  async disconnectPairs(pairs: any[]) {
    console.log(`[server] disconnect from ${pairs.join(',')}`);

    for (let exchange of this.exchanges) {
      for (let pair of pairs) {
        try {
          await exchange.unlink(pair);
        } catch (err) {
          console.debug(`[server/disconnectPairs/${exchange.id}] ${err}`);

          if (err instanceof Error) {
            console.error(err);
          }
        }
      }
    }
  }

  broadcastJson(data: { type: string; id: any; message?: any }) {
    if (!this.wss) {
      return;
    }

    this.wss.clients.forEach((client) => {
      if (client.readyState === WSServer.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  }

  broadcastTrades(trades: any[]) {
    if (!this.wss) {
      return;
    }

    const groups = groupTrades(trades, true, true);

    this.wss.clients.forEach((client) => {
      if (client.readyState === WSServer.OPEN) {
        for (let i = 0; i < client.pairs.length; i++) {
          if (groups[client.pairs[i]]) {
            client.send(JSON.stringify([client.pairs[i], groups[client.pairs[i]]]));
          }
        }
      }
    });
  }

  monitorExchangesActivity(startedAt: any) {
    const now = +new Date();

    let dumpThreshold = 0;

    const sources: string[] = [];
    const activity = {};
    const pairs = {};

    for (let id in this.connections) {
      const connection = this.connections[id];

      if (!activity[connection.apiId]) {
        activity[connection.apiId] = [];
        pairs[connection.apiId] = [];
      }

      activity[connection.apiId].push(now - connection.timestamp);

      pairs[connection.apiId].push(connection.remote);
    }

    for (let source in activity) {
      const max = activity[source].length ? Math.max.apply(null, activity[source]) : 0;

      if (max > this.options.reconnectionThreshold / 2) {
        dumpThreshold = max;
      }

      if (max > this.options.reconnectionThreshold) {
        // one of the feed did not received any data since 1m or more
        // => reconnect api (and all the feed binded to it)

        console.log(
          `[warning] api ${source} reached reconnection threshold ${getHms(max)} > ${getHms(
            this.options.reconnectionThreshold,
          )}\n\t-> reconnect ${pairs[source].join(', ')}`,
        );

        sources.push(source);
      }
    }

    for (let exchange of this.exchanges) {
      for (let api of exchange.apis) {
        if (sources.indexOf(api.id) !== -1) {
          exchange.reconnectApi(api);

          sources.splice(sources.indexOf(api.id), 1);
        }
      }
    }

    if (dumpThreshold) {
      this.dumpConnections(dumpThreshold);
    }
  }

  listenBannedIps() {
    const file = path.resolve(__dirname, '../banned.txt');

    const watch = () => {
      fs.watchFile(file, () => {
        this.updateBannedIps();
      });
    };

    try {
      fs.accessSync(file, fs.constants.F_OK);

      this.updateBannedIps().then((success) => {
        if (success) {
          watch();
        }
      });
    } catch (error) {
      const _checkForWatchInterval = setInterval(() => {
        fs.access(file, fs.constants.F_OK, (err) => {
          if (err) {
            return;
          }

          this.updateBannedIps().then((success) => {
            if (success) {
              clearInterval(_checkForWatchInterval);

              watch();
            }
          });
        });
      }, 1000 * 10);
    }
  }

  updateBannedIps() {
    const file = path.resolve(__dirname, '../banned.txt');

    return new Promise((resolve) => {
      fs.readFile(file, 'utf8', (err, data) => {
        if (err) {
          return;
        }

        this.BANNED_IPS = data
          .split('\n')
          .map((a) => a.trim())
          .filter((a) => a.length);

        resolve(true);
      });
    });
  }

  getInfo(pair: string) {
    const now = +new Date();

    let currencyLength = 3;
    if (['USDT', 'TUSD'].indexOf(pair) === pair.length - 4) {
      currencyLength = 4;
    }

    let fsym = pair.substr(-currencyLength, currencyLength);
    let tsym = pair.substr(0, pair.length - currencyLength);

    if (!/^(USD|BTC)/.test(tsym)) {
      tsym = 'USD';
    }

    pair = fsym + tsym;

    if (this.symbols[pair]) {
      if (Math.floor((now - this.symbols[pair].time) / (1000 * 60 * 60 * 24)) > 1) {
        delete this.symbols[pair];
      } else {
        return Promise.resolve(this.symbols[pair].volume);
      }
    }

    return axios
      .get(
        `https://min-api.cryptocompare.com/data/symbol/histoday?fsym=${fsym}&tsym=${tsym}&limit=1&api_key=f640d9ddbd98b4cade666346aab18687d73720d2ede630bf8bacea710e08df55`,
      )
      .then((response: { data: any }) => response.data)
      .then((data: { Data: { length: any; Data: any[] } }) => {
        if (!data || !data.Data || !data.Data.length) {
          throw new Error(`no data`);
        }

        data.Data.Data[0].time *= 1000;

        this.symbols[pair] = data.Data.Data[0];

        return {
          data: this.symbols[pair],
          base: fsym,
          quote: tsym,
        };
      });
  }

  getRatio(pair: any) {
    return this.getInfo(pair).then(async ({ data, base, quote }) => {
      const BTC = await this.getInfo('BTCUSD');

      if (quote === 'BTC') {
        return data.volumeTo / BTC.volumeFrom;
      } else {
        return data.volumeFrom / BTC.volumeTo;
      }
    });
  }

  dispatchRawTrades(exchange: string, { source, data }: any) {
    const now = +new Date();

    for (let i = 0; i < data.length; i++) {
      const trade = data[i];
      const identifier = exchange + ':' + trade.pair;

      if (!this.connections[identifier]) {
        console.warn(
          `[${exchange}/dispatchRawTrades] connection ${identifier} doesn't exists but tried to dispatch a trade for it`,
        );
        continue;
      }

      // ping connection
      this.connections[identifier].hit++;
      this.connections[identifier].timestamp = now;

      // save trade
      if (this.storages) {
        this.chunk.push(trade);
      }
    }

    if (this.options.broadcast) {
      if (this.options.broadcastAggr && !this.options.broadcastDebounce) {
        this.broadcastTrades(data);
      } else {
        Array.prototype.push.apply(this.delayedForBroadcast, data);
      }
    }
  }

  dispatchAggregateTrade(exchange: string, { source, data }: any) {
    const now = +new Date();
    const length = data.length;

    for (let i = 0; i < length; i++) {
      const trade = data[i];
      const identifier = exchange + ':' + trade.pair;

      // ping connection
      this.connections[identifier].hit++;
      this.connections[identifier].timestamp = now;

      // save trade
      if (this.storages) {
        this.chunk.push(trade);
      }

      if (!this.connections[identifier]) {
        console.error(`UNKNOWN TRADE SOURCE`, trade);
        console.info('This trade will be ignored.');
        continue;
      }

      if (this.aggregating[identifier]) {
        const queuedTrade = this.aggregating[identifier];

        if (queuedTrade.timestamp === trade.timestamp && queuedTrade.side === trade.side) {
          queuedTrade.size += trade.size;
          queuedTrade.price += trade.price * trade.size;
          continue;
        } else {
          queuedTrade.price /= queuedTrade.size;
          this.aggregated.push(queuedTrade);
        }
      }

      this.aggregating[identifier] = Object.assign({}, trade);
      this.aggregating[identifier].timeout = now + 50;
      this.aggregating[identifier].price *= this.aggregating[identifier].size;
    }
  }

  broadcastAggregatedTrades() {
    const now = +new Date();

    const onGoingAggregation = Object.keys(this.aggregating);

    for (let i = 0; i < onGoingAggregation.length; i++) {
      const trade = this.aggregating[onGoingAggregation[i]];
      if (trade.timeout && now > trade.timeout) {
        trade.price /= trade.size;
        this.aggregated.push(trade);

        delete this.aggregating[onGoingAggregation[i]];
      }
    }

    if (this.aggregated.length) {
      this.broadcastTrades(this.aggregated);

      this.aggregated.splice(0, this.aggregated.length);
    }
  }

  /**
   * For debug only
   */
  dumpSymbolsByExchanges() {
    const symbols = Object.keys(this.indexedProducts);

    fs.writeFileSync(
      './symbols',
      symbols.reduce((output, symbol) => {
        output += `${symbol} (${this.indexedProducts[symbol].exchanges.join(',')})\n`;

        return output;
      }, ''),
      { encoding: 'utf8', flag: 'w' },
    );
  }
}

export default Server;
