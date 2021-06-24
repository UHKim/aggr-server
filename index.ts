import fs from 'fs';
import pmx from 'pmx';
const probe = pmx.probe();

console.log('PID: ', process.pid);

import config from './src/config';
import Server from './src/server';

/* Load available exchanges
 */

if (!config.exchanges || !config.exchanges.length) {
  config.exchanges = [];

  fs.readdirSync('./src/exchanges/').forEach((file) => {
    /\.(j|t)s$/.test(file) && config.exchanges.push(file.replace(/\.(j|t)s$/, ''));
  });
}

const exchanges: string[] = [];

for (let name of config.exchanges) {
  const exchange = new (require('./src/exchanges/' + name))(config);

  config.exchanges[config.exchanges.indexOf(name)] = exchange.id;

  exchanges.push(exchange);
}

/* Start server
 */

const server = new Server(config, exchanges);

/* Metrics
 */

if (process.env.pmx) {
  const currently_online = probe.metric({
    name: 'Online',
  });

  const unique_visitors = probe.metric({
    name: 'Unique',
  });

  const stored_quotas = probe.metric({
    name: 'Quotas',
  });

  server.on('connections', (n) => {
    currently_online.set(n);
  });

  server.on('unique', (n) => {
    unique_visitors.set(n);
  });

  server.on('quotas', (n) => {
    stored_quotas.set(n);
  });
}

/* Backup server on SIGINT
 */

process.on('SIGINT', function () {
  console.log('SIGINT');

  Promise.all([server.backupTrades(true)])
    .then((data) => {
      console.log('[server/exit] Goodbye');

      process.exit();
    })
    .catch((err) => {
      console.log(
        `[server/exit] Something went wrong when executing SIGINT script${
          err && err.message ? '\n\t' + err.message : ''
        }`,
      );

      process.exit();
    });
});
