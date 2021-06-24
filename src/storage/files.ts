import fs from 'fs';
import { Trade } from 'src/types/trade';
import { groupTrades, ensureDirectoryExists } from '../helper';

class FilesStorage {
  name: string;
  options: any;
  format: string;
  writableStreams: {};

  constructor(options: any) {
    this.name = this.constructor.name;
    this.options = options;
    this.format = 'trade';

    /** @type {{[timestamp: string]: {stream: fs.WriteStream, updatedAt: number}}} */
    this.writableStreams = {};

    if (!this.options.filesInterval) {
      this.options.filesInterval = 3600000; // 1h file default
    }

    if (!fs.existsSync(this.options.filesLocation)) {
      fs.mkdirSync(this.options.filesLocation);
    }

    console.log(`[storage/${this.name}] destination folder: ${this.options.filesLocation}`);
  }

  /**
   * Construit le nom du fichier a partir d'une date
   * BTCUSD_2018-12-01-22
   *
   * @param {Date} identifier ex bitmex:XBTUSD, kraken:XBT/USD etc
   * @param {Date} date
   * @returns {string}
   * @memberof FilesStorage
   */
  getBackupFilename(identifier: { match: (arg0: RegExp) => [any, any, any] }, date: Date) {
    let [, exchange, pair] = identifier.match(/([^:]*):(.*)/);

    pair = pair.replace(/[/:]/g, '-');

    const folderPart = `${this.options.filesLocation}/${exchange}/${pair}`;
    const datePart = `${date.getFullYear()}-${('0' + (date.getMonth() + 1)).slice(-2)}-${(
      '0' + date.getDate()
    ).slice(-2)}`;

    let file = `${folderPart}/${datePart}`;

    if (this.options.filesInterval < 1000 * 60 * 60 * 24) {
      file += `-${('0' + date.getHours()).slice(-2)}`;
    }

    if (this.options.filesInterval < 1000 * 60 * 60) {
      file += `-${('0' + date.getMinutes()).slice(-2)}`;
    }

    if (this.options.filesInterval < 1000 * 60) {
      file += `-${('0' + date.getSeconds()).slice(-2)}`;
    }

    return file.replace(/\s+/g, '');
  }

  async addWritableStream(identifier, ts: string) {
    const date = new Date(+ts);
    const path = this.getBackupFilename(identifier, date);

    try {
      await ensureDirectoryExists(path);
    } catch (error) {
      console.error(`[storage/${this.name}] failed to create target directory ${path}`, error);
    }

    this.writableStreams[identifier + ts] = {
      updatedAt: null,
      stream: fs.createWriteStream(path, { flags: 'a' }),
    };

    console.log(`[storage/${this.name}] created writable stream ${date.toUTCString()} => ${path}`);
  }

  reviewStreams() {
    const now = +new Date();

    for (let id in this.writableStreams) {
      if (now - this.writableStreams[id].updatedAt > 1000 * 60 * 10) {
        this.writableStreams[id].stream.end();
        delete this.writableStreams[id];
      }
    }
  }

  async save(trades: Trade[]) {
    const now = +new Date();

    const groups = groupTrades(trades, false, true);

    const output = Object.keys(groups).reduce((obj, pair) => {
      obj[pair] = {};
      return obj;
    }, {});

    return new Promise<boolean>((resolve, reject) => {
      if (!trades.length) {
        return resolve(true);
      }

      for (let identifier in groups) {
        for (let i = 0; i < groups[identifier].length; i++) {
          const trade = groups[identifier][i];

          const ts = Math.floor(trade[0] / this.options.filesInterval) * this.options.filesInterval;

          if (!output[identifier][ts]) {
            output[identifier][ts] = '';
          }

          output[identifier][ts] += trade.join(' ') + '\n';
        }
      }

      const promises: Promise<void>[] = [];

      for (let identifier in output) {
        for (let ts in output[identifier]) {
          promises.push(
            new Promise((resolve) => {
              let promiseOfWritableStram = Promise.resolve();

              if (!this.writableStreams[identifier + ts]) {
                promiseOfWritableStram = this.addWritableStream(identifier, ts);
              }

              promiseOfWritableStram.then(() => {
                this.writableStreams[identifier + ts].stream.write(
                  output[identifier][ts],
                  (err: any) => {
                    if (err) {
                      console.log(
                        `[storage/${this.name}] stream.write encountered an error\n\t${err}`,
                      );
                    } else {
                      this.writableStreams[identifier + ts].updatedAt = now;
                    }

                    resolve();
                  },
                );
              });
            }),
          );
        }
      }

      Promise.all(promises).then(() => resolve(true));
    }).then((success) => {
      this.reviewStreams();

      return success;
    });
  }

  fetch() {
    // unsupported
    return Promise.resolve([]);
  }
}

export default FilesStorage;
