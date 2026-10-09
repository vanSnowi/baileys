// Offline differential check for the compact WAProto codec.
//
// Encodes schema-valid fixtures with both the compact codec (WAProto/compiler.js)
// and the protobufjs reference loaded from WAProto/WAProto.proto, then compares the
// resulting bytes and cross-decodes each output with the other implementation.
// Runs a curated set of named fixtures plus a seeded fuzz over every message type.
// Exits non-zero if any schema-valid message does not round-trip byte-identically.
//
// Usage: node tools/proto-differential.mjs [iterationsPerType] [seed]
// Requires the `protobufjs` dependency (already a runtime dependency of this package).

import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const protobuf = require('protobufjs');
const { proto: compact } = await import(new URL('../WAProto/compiler.js', import.meta.url));

const root = await protobuf.load(ROOT + 'WAProto/WAProto.proto');
root.resolveAll();

const hex = u => Buffer.from(u).toString('hex');
const compactNode = full => full.replace(/^proto\./, '').split('.').reduce((o, k) => o && o[k], compact);
const refType = name => root.lookupType(name);

// Normalize decoded objects so byte-array representations compare equal regardless of
// whether a given path produced a Buffer or a Uint8Array.
function normalize(v) {
    if (v == null) return v;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return 'bytes:' + hex(v);
    if (Array.isArray(v)) return v.map(normalize);
    if (typeof v === 'object') {
        if (typeof v.toString === 'function' && (v.low !== undefined || v.unsigned !== undefined) && v.high !== undefined) {
            return 'long:' + v.toString();
        }
        const o = {};
        for (const k of Object.keys(v).sort()) o[k] = normalize(v[k]);
        return o;
    }
    return v;
}
const logical = (T, bytes) => JSON.stringify(normalize(T.toObject(T.decode(bytes), { longs: String, defaults: false, enums: Number })));

let pass = 0, fail = 0;
const failures = [];

function check(label, refName, fixture) {
    const node = compactNode(refName);
    if (!node) { fail++; failures.push(`${label}: no compact node for ${refName}`); return; }
    try {
        const T = refType(refName);
        const refBytes = T.encode(T.fromObject(fixture)).finish();
        const cBytes = node.encode(fixture).finish();
        if (hex(refBytes) !== hex(cBytes)) {
            // byte difference: report whether it is representational or a real data difference
            const same = logical(T, refBytes) === logical(T, cBytes);
            fail++;
            failures.push(`${label} (${refName}) BYTES DIFFER${same ? ' [logically equal]' : ' [REAL DATA DIFFERENCE]'}\n    ref    : ${hex(refBytes)}\n    compact: ${hex(cBytes)}`);
            return;
        }
        // cross-decode must not throw
        node.decode(refBytes);
        T.decode(cBytes);
        pass++;
    } catch (e) {
        fail++;
        failures.push(`${label} (${refName}) ERROR: ${e.message}`);
    }
}

// ---- Curated, named fixtures ----
check('plain text', 'proto.Message', { conversation: 'Hi\n😀 café €' });
check('extendedText + contextInfo', 'proto.Message', { extendedTextMessage: { text: 'hi', contextInfo: { stanzaId: 'a', expiration: 86400 } } });
check('groupStatusMessageV2', 'proto.Message', { groupStatusMessageV2: { message: { conversation: 'status' } } });
check('nativeFlow buttons[]', 'proto.Message.InteractiveMessage.NativeFlowMessage', {
    buttons: [{ name: 'quick_reply', buttonParamsJson: '{"a":1}' }, { name: 'cta_url', buttonParamsJson: '{"u":"x"}' }], messageVersion: 1
});
check('stickerPack', 'proto.Message.StickerPackMessage', {
    stickerPackId: 'p', stickers: [{ fileName: 's1', emojis: ['😀'] }, { fileName: 's2', isAnimated: true }], fileLength: 123456789, fileSha256: Buffer.from('00112233', 'hex')
});
check('empty repeated packed', 'proto.Message.ImageMessage', { url: 'x', scanLengths: [] });
check('empty repeated message', 'proto.Message.StickerPackMessage', { stickerPackId: 'p', stickers: [] });
check('packed uint32[]', 'proto.DeviceListMetadata', { senderKeyIndexes: [1, 2, 300, 70000], recipientKeyIndexes: [5, 6] });
check('enum number', 'proto.Message.ExtendedTextMessage', { text: 't', previewType: 1 });
check('enum string', 'proto.Message.ExtendedTextMessage', { text: 't', previewType: 'VIDEO' });
check('bytes', 'proto.Message.ImageMessage', { mediaKey: Buffer.from('deadbeef', 'hex'), fileLength: 42 });
check('int64 large string', 'proto.Message.ImageMessage', { fileLength: '9007199254740993' });
check('negative int64 string', 'proto.Message.ImageMessage', { mediaKeyTimestamp: '-5000000000' });
check('double fields', 'proto.Message.LocationMessage', { degreesLatitude: 37.7749, degreesLongitude: -122.4194 });
check('WebMessageInfo nested', 'proto.WebMessageInfo', { key: { remoteJid: 'x@s.whatsapp.net', fromMe: true, id: 'ABC' }, message: { conversation: 'hey' }, messageTimestamp: 1700000000 });
check('map<string,string>', 'proto.SyncActionValue.MusicUserIdAction', { musicUserId: 'u', musicUserIdMap: { a: '1', b: '2' } });
check('map<uint32,Field>', 'proto.Config', { version: 7, field: { 1: { minVersion: 2, maxVersion: 5 }, 42: { isMessage: true } } });

// ---- Seeded fuzz over every message type ----
const ITER = Number(process.argv[2]) || 8;
let seed = Number(process.argv[3]) || 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = a => a[Math.floor(rnd() * a.length)];
const SG = {
    int32: () => Math.floor(rnd() * 2e9) - 1e9, uint32: () => Math.floor(rnd() * 4e9), sint32: () => Math.floor(rnd() * 2e9) - 1e9,
    bool: () => rnd() > 0.5, int64: () => String(Math.floor(rnd() * 9e15) - 4e15), uint64: () => String(Math.floor(rnd() * 9e15)),
    sint64: () => String(Math.floor(rnd() * 9e15) - 4e15), fixed32: () => Math.floor(rnd() * 4e9), sfixed32: () => Math.floor(rnd() * 2e9) - 1e9,
    fixed64: () => String(Math.floor(rnd() * 9e15)), sfixed64: () => String(Math.floor(rnd() * 9e15) - 4e15), double: () => (rnd() - 0.5) * 1e6,
    float: () => Math.fround((rnd() - 0.5) * 1e3), string: () => pick(['', 'a', 'héllo 😀', 'x\n€']), bytes: () => Buffer.from([Math.floor(rnd() * 256), Math.floor(rnd() * 256)])
};
function genValue(f, d) {
    const rt = f.resolvedType;
    if (rt && rt.values) return pick(Object.values(rt.values));
    if (rt && rt.fieldsArray) return d > 4 ? undefined : genObject(rt, d + 1);
    const g = SG[f.type];
    return g ? g() : undefined;
}
function genObject(T, d = 0) {
    const o = {};
    for (const f of T.fieldsArray) {
        if (rnd() < 0.35 && d > 0) continue;
        if (f.map) {
            const n = Math.floor(rnd() * 3);
            const mo = {};
            for (let i = 0; i < n; i++) {
                const k = f.keyType === 'string' ? pick(['a', 'b', 'c']) : Math.floor(rnd() * 1000);
                const v = genValue(f, d);
                if (v !== undefined) mo[k] = v;
            }
            if (Object.keys(mo).length) o[f.name] = mo;
        } else if (f.repeated) {
            const n = Math.floor(rnd() * 3);
            const arr = [];
            for (let i = 0; i < n; i++) { const v = genValue(f, d); if (v !== undefined) arr.push(v); }
            if (arr.length || rnd() < 0.2) o[f.name] = arr;
        } else {
            const v = genValue(f, d);
            if (v !== undefined) o[f.name] = v;
        }
    }
    return o;
}

const types = [];
(function walk(ns) { for (const o of Object.values(ns.nested || {})) { if (o.fieldsArray) types.push(o); if (o.nested) walk(o); } })(root);

let fuzzTotal = 0;
for (const T of types) {
    const full = T.fullName.replace(/^\./, '');
    if (!compactNode(full)) continue;
    for (let it = 0; it < ITER; it++) {
        fuzzTotal++;
        check(`fuzz ${full}#${it}`, full, genObject(T, 0));
    }
}

console.log('================ WAProto differential ================');
console.log(`curated + fuzz checks: ${pass + fail}  (fuzz iterations: ${fuzzTotal} over ${types.length} types)`);
console.log(`byte-identical: ${pass}   failures: ${fail}`);
for (const f of failures.slice(0, 20)) console.log('\n' + f);
if (failures.length > 20) console.log(`\n... and ${failures.length - 20} more`);
console.log(fail === 0 ? '\nRESULT: OK' : '\nRESULT: FAILURES');
process.exit(fail === 0 ? 0 : 1);
