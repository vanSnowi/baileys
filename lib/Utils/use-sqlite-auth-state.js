import { mkdir, readdir, readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { proto } from '../../WAProto/index.js';
import { initAuthCreds } from './auth-utils.js';
export const useSqliteAuthState = async (pathOrFolder, options = {}) => {
  const {
    fileName = 'auth.db',
    migrateFromFolder,
    logger
  } = options;
  const dbPath = /\.(db|sqlite|sqlite3)$/i.test(pathOrFolder) ? pathOrFolder : join(pathOrFolder, fileName);
  const bufReplacer = (_, value) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
      return {
        type: 'Buffer',
        data: Buffer.from(value?.data || value).toString('base64')
      };
    }
    return value;
  };
  const bufReviver = (_, value) => {
    if (value && typeof value === 'object' && value.type === 'Buffer' && typeof value.data === 'string') {
      return Buffer.from(value.data, 'base64');
    }
    return value;
  };
  const encode = value => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return Buffer.concat([Buffer.from([1]), Buffer.from(value)]);
    }
    return Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(value, bufReplacer), 'utf8')]);
  };
  const decode = blob => {
    if (!blob || blob.length === 0) return null;
    if (blob[0] === 1) return Buffer.from(blob.subarray(1));
    return JSON.parse(blob.subarray(1).toString('utf8'), bufReviver);
  };
  const fixName = s => s?.replace(/\//g, '__')?.replace(/:/g, '-');
  const keyOf = (category, id) => fixName(`${category}-${id}`);
  let Database;
  try {
    ({
      default: Database
    } = await import('better-sqlite3'));
  } catch (err) {
    throw new Error("useSqliteAuthState needs 'better-sqlite3' (a dependency). If it's missing, reinstall: npm i better-sqlite3");
  }
  await mkdir(dirname(dbPath), {
    recursive: true
  }).catch(() => {});
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS auth_state (k TEXT PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID');
  const qGet = db.prepare('SELECT v FROM auth_state WHERE k = ?');
  const qUpsert = db.prepare('INSERT INTO auth_state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
  const qDelete = db.prepare('DELETE FROM auth_state WHERE k = ?');
  const readRaw = k => {
    const row = qGet.get(k);
    if (!row) return null;
    try {
      return decode(row.v);
    } catch (err) {
      logger?.warn?.({
        k,
        err: err?.message
      }, 'sqlite-auth: failed to decode row, treating as missing');
      return null;
    }
  };
  const runMigration = async folder => {
    let files;
    try {
      files = await readdir(folder);
    } catch {
      return 0;
    }
    const rows = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      let value;
      try {
        value = JSON.parse(await readFile(join(folder, file), 'utf8'), bufReviver);
      } catch {
        continue;
      }
      if (value === null || value === undefined) continue;
      rows.push([file.slice(0, -'.json'.length), encode(value)]);
    }
    const tx = db.transaction(items => {
      for (const [k, v] of items) qUpsert.run(k, v);
    });
    tx(rows);
    return rows.length;
  };
  const hasCreds = () => !!qGet.get('creds');
  if (migrateFromFolder && !hasCreds()) {
    const n = await runMigration(migrateFromFolder);
    if (n > 0) logger?.info?.({
      count: n,
      from: migrateFromFolder
    }, 'sqlite-auth: migrated legacy auth state');
  }
  let creds = readRaw('creds');
  if (!creds) {
    creds = initAuthCreds();
    qUpsert.run('creds', encode(creds));
  }
  const keys = {
    get: async (type, ids) => {
      const data = {};
      for (const id of ids) {
        let value = readRaw(keyOf(type, id));
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        if (value !== null && value !== undefined) {
          data[id] = value;
        }
      }
      return data;
    },
    set: async data => {
      const ops = [];
      for (const category in data) {
        for (const id in data[category]) {
          ops.push([keyOf(category, id), data[category][id]]);
        }
      }
      const tx = db.transaction(items => {
        for (const [k, value] of items) {
          if (value === null || value === undefined) qDelete.run(k);else qUpsert.run(k, encode(value));
        }
      });
      tx(ops);
    },
    clear: async () => {
      db.prepare("DELETE FROM auth_state WHERE k <> 'creds'").run();
    }
  };
  return {
    state: {
      creds,
      keys
    },
    saveCreds: async () => {
      qUpsert.run('creds', encode(creds));
    },
    db,
    close: () => db.close()
  };
};
