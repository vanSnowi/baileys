// Manual pairing-code debug harness. NOT run by the test suite.
//
//   WA_PHONE_NUMBER=49123456789 node examples/pairing-code-debug.js
//
// Prints the pairing stage transitions and the (user-facing) pairing code only.
// No secrets are printed. Uses fresh in-memory auth creds each run.
import makeWASocket, { Browsers, DisconnectReason, initAuthCreds } from '../lib/index.js';
import P from 'pino';

const phoneNumber = (process.env.WA_PHONE_NUMBER || '').replace(/[^0-9]/g, '');
if (!phoneNumber) {
    console.error('Set WA_PHONE_NUMBER (digits only), e.g. WA_PHONE_NUMBER=49123456789');
    process.exit(1);
}

const store = new Map();
const keys = {
    get: async (type, ids) => Object.fromEntries(ids.map(id => [id, store.get(`${type}:${id}`)])),
    set: async (data) => {
        for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
                if (value === null || value === undefined) store.delete(`${type}:${id}`);
                else store.set(`${type}:${id}`, value);
            }
        }
    }
};

// pino at debug so the structured pairing stage logs are visible (they never log secrets)
const logger = P({ level: process.env.WA_LOG_LEVEL || 'info' });
const mask = phoneNumber.length > 4 ? `***${phoneNumber.slice(-4)}` : '***';

async function main() {
    const sock = makeWASocket({
        auth: { creds: initAuthCreds(), keys },
        logger,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', () => { /* persist in a real app */ });
    sock.ev.on('pairing-code.update', ({ code, reason }) => {
        console.log(`[pairing] refreshed code (${reason}): ${code}`);
    });
    sock.ev.on('connection.update', (u) => {
        if (u.connection) console.log(`[pairing] connection: ${u.connection}`);
        if (u.isNewLogin) console.log('[pairing] pair success received, pairing completed');
        if (u.connection === 'close') {
            const code = u.lastDisconnect?.error?.output?.statusCode;
            console.log(`[pairing] closed (status ${code ?? '?'})`);
            if (code === DisconnectReason.loggedOut) process.exit(1);
        }
    });

    // give the socket a moment to open, then request a code
    setTimeout(async () => {
        try {
            console.log(`[pairing] requesting code for ${mask} ...`);
            const code = await sock.requestPairingCode(phoneNumber);
            console.log(`[pairing] enter this code on the phone: ${code}`);
            console.log('[pairing] waiting for primary_hello / companion_finish / pair-success ...');
        } catch (err) {
            console.error(`[pairing] failed at companion_hello: ${err?.message} (status ${err?.output?.statusCode ?? '?'})`);
            process.exit(1);
        }
    }, 3000);
}

main().catch(err => { console.error('fatal:', err?.message); process.exit(1); });
