import { mkdir, readdir, readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { proto } from '../../WAProto/index.js';
import { initAuthCreds } from './auth-utils.js';
/**
 * SQLite-backed auth state — a crash-safe, single-file replacement for
 * useMultiFileAuthState. Stores creds, signal sessions, pre-keys, sender-keys,
 * app-state-sync keys, lid-mappings AND tctokens in one WAL'd .db file with
 * atomic (transactional) batched writes.
 *
 * Why: the multi-file JSON store writes each key with a non-atomic writeFile —
 * a crash mid-write corrupts a session file, which is then silently read back as
 * null (lost key -> decryption breaks -> retries -> restriction risk). SQLite in
 * WAL mode commits atomically, so a key is either fully written or not at all.
 *
 * Uses `better-sqlite3` (prebuilt binaries ship for common platforms).
 *
 * @param {string} pathOrFolder  either a `.db`/`.sqlite` file path, OR a folder (like
 *   useMultiFileAuthState) in which the db is created as `<folder>/<fileName>`.
 * @param {object} [options]
 * @param {string} [options.fileName='auth.db']  db filename when a folder is given
 * @param {string} [options.migrateFromFolder]  legacy useMultiFileAuthState folder to import once (on a fresh db)
 * @param {{ warn?: Function, info?: Function }} [options.logger]
 * @returns {Promise<{ state: { creds: any, keys: any }, saveCreds: () => Promise<void>, db: any, close: () => void }>}
 */
export const useSqliteAuthState = async (pathOrFolder, options = {}) => {
    const { fileName = 'auth.db', migrateFromFolder, logger } = options;
    // Accept a .db/.sqlite file path directly, or a folder (then db = <folder>/<fileName>).
    const dbPath = /\.(db|sqlite|sqlite3)$/i.test(pathOrFolder)
        ? pathOrFolder
        : join(pathOrFolder, fileName);
    // --- value codec: tag 1 => raw Buffer blob (no base64), tag 0 => BufferJSON-JSON ---
    // Kept identical to the codebase's BufferJSON so Buffers round-trip exactly.
    const bufReplacer = (_, value) => {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
            return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') };
        }
        return value;
    };
    const bufReviver = (_, value) => {
        if (value && typeof value === 'object' && value.type === 'Buffer' && typeof value.data === 'string') {
            return Buffer.from(value.data, 'base64');
        }
        return value;
    };
    const encode = (value) => {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
            return Buffer.concat([Buffer.from([1]), Buffer.from(value)]);
        }
        return Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(value, bufReplacer), 'utf8')]);
    };
    const decode = (blob) => {
        if (!blob || blob.length === 0)
            return null;
        if (blob[0] === 1)
            return Buffer.from(blob.subarray(1));
        return JSON.parse(blob.subarray(1).toString('utf8'), bufReviver);
    };
    // Same key mangling the multi-file store applied to filenames, so migration is a
    // lossless 1:1 copy (legacy filename stem === this key) and lookups stay consistent.
    const fixName = (s) => s?.replace(/\//g, '__')?.replace(/:/g, '-');
    const keyOf = (category, id) => fixName(`${category}-${id}`);
    // --- open db (lazy-load the optional native dep) ---
    let Database;
    try {
        ({ default: Database } = await import('better-sqlite3'));
    }
    catch (err) {
        throw new Error("useSqliteAuthState needs 'better-sqlite3' (a dependency). If it's missing, reinstall: npm i better-sqlite3");
    }
    await mkdir(dirname(dbPath), { recursive: true }).catch(() => { });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.exec('CREATE TABLE IF NOT EXISTS auth_state (k TEXT PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID');
    const qGet = db.prepare('SELECT v FROM auth_state WHERE k = ?');
    const qUpsert = db.prepare('INSERT INTO auth_state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
    const qDelete = db.prepare('DELETE FROM auth_state WHERE k = ?');
    const readRaw = (k) => {
        const row = qGet.get(k);
        if (!row)
            return null;
        try {
            return decode(row.v);
        }
        catch (err) {
            // Defensive: a single unreadable row is treated as missing (the key re-establishes),
            // never throws out of a get() — matches the multi-file store's read-error behaviour.
            logger?.warn?.({ k, err: err?.message }, 'sqlite-auth: failed to decode row, treating as missing');
            return null;
        }
    };
    // --- one-time migration from a legacy multi-file folder (only if db is fresh) ---
    const runMigration = async (folder) => {
        let files;
        try {
            files = await readdir(folder);
        }
        catch {
            return 0;
        }
        const rows = [];
        for (const file of files) {
            if (!file.endsWith('.json'))
                continue;
            let value;
            try {
                value = JSON.parse(await readFile(join(folder, file), 'utf8'), bufReviver);
            }
            catch {
                continue;
            }
            if (value === null || value === undefined)
                continue;
            // Legacy filename stem === keyOf(category, id), so store it verbatim.
            rows.push([file.slice(0, -'.json'.length), encode(value)]);
        }
        const tx = db.transaction((items) => {
            for (const [k, v] of items)
                qUpsert.run(k, v);
        });
        tx(rows);
        return rows.length;
    };
    const hasCreds = () => !!qGet.get('creds');
    if (migrateFromFolder && !hasCreds()) {
        const n = await runMigration(migrateFromFolder);
        if (n > 0)
            logger?.info?.({ count: n, from: migrateFromFolder }, 'sqlite-auth: migrated legacy auth state');
    }
    // --- creds ---
    let creds = readRaw('creds');
    if (!creds) {
        creds = initAuthCreds();
        qUpsert.run('creds', encode(creds));
    }
    // --- SignalKeyStore interface (async wrappers over synchronous sqlite) ---
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
        set: async (data) => {
            const ops = [];
            for (const category in data) {
                for (const id in data[category]) {
                    ops.push([keyOf(category, id), data[category][id]]);
                }
            }
            const tx = db.transaction((items) => {
                for (const [k, value] of items) {
                    if (value === null || value === undefined)
                        qDelete.run(k);
                    else
                        qUpsert.run(k, encode(value));
                }
            });
            tx(ops);
        },
        clear: async () => {
            // Wipe signal keys but keep creds (identity). Full reset = delete the db file.
            db.prepare("DELETE FROM auth_state WHERE k <> 'creds'").run();
        }
    };
    return {
        state: { creds, keys },
        saveCreds: async () => {
            qUpsert.run('creds', encode(creds));
        },
        db,
        close: () => db.close()
    };
};
