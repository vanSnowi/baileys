// Fast, compact, table-driven protobuf codec (no protobufjs at runtime).
// Optional { Long } makes 64-bit int fields decode to Long objects (protobufjs-compatible).
const MAXV = 0x1fffffffffffff;
const isLongIn = (v) => v && typeof v === 'object' && 'low' in v && 'high' in v;
// reconstruct from low/high (works for real Long AND plain {low,high,unsigned} objects)
const longToBig = (v) => (v.unsigned ? BigInt(v.high >>> 0) : BigInt(v.high | 0)) * 4294967296n + BigInt(v.low >>> 0);
const toBig = (v) => typeof v === 'bigint' ? v : isLongIn(v) ? longToBig(v) : BigInt(Math.trunc(Number(v)));
class Writer {
    constructor() { this.buf = new Uint8Array(128); this.len = 0; }
    _e(n) { if (this.len + n > this.buf.length) { let c = this.buf.length * 2; while (c < this.len + n) c *= 2; const nb = new Uint8Array(c); nb.set(this.buf.subarray(0, this.len)); this.buf = nb; } }
    byte(b) { this._e(1); this.buf[this.len++] = b; }
    raw(u) { this._e(u.length); this.buf.set(u, this.len); this.len += u.length; }
    varintNum(n) { this._e(10); while (n > 0x7f) { this.buf[this.len++] = (n & 0x7f) | 0x80; n = Math.floor(n / 128); } this.buf[this.len++] = n; }
    varintBig(v) { this._e(10); let n = BigInt.asUintN(64, v); while (n > 0x7fn) { this.buf[this.len++] = Number((n & 0x7fn) | 0x80n); n >>= 7n; } this.buf[this.len++] = Number(n); }
    tag(field, wire) { this.varintNum(field * 8 + wire); }
    vint(v) { if (typeof v === 'number' && v >= 0 && v <= MAXV && Number.isInteger(v)) this.varintNum(v); else this.varintBig(toBig(v)); }
    fixed32(v) { this._e(4); const n = Number(BigInt.asUintN(32, toBig(v))) >>> 0; this.buf[this.len++] = n & 255; this.buf[this.len++] = (n >>> 8) & 255; this.buf[this.len++] = (n >>> 16) & 255; this.buf[this.len++] = (n >>> 24) & 255; }
    fixed64(v) { this._e(8); const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, toBig(v))); this.raw(b); }
    float(v) { this._e(4); const b = Buffer.alloc(4); b.writeFloatLE(v); this.raw(b); }
    double(v) { this._e(8); const b = Buffer.alloc(8); b.writeDoubleLE(v); this.raw(b); }
    finish() { return this.buf.subarray(0, this.len); }
}
const zigzag = (v) => BigInt.asUintN(64, (toBig(v) << 1n) ^ (toBig(v) >> 63n));
const toBuf = (v) => Buffer.isBuffer(v) ? v : typeof v === 'string' ? Buffer.from(v, 'base64') : v?.type === 'Buffer' ? Buffer.from(v.data) : v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(v);
const wireOf = (f) => f.k === 'varint' ? 0 : f.k === 'i64' ? 1 : f.k === 'i32' ? 5 : 2;
class Reader {
    constructor(buf) { this.buf = buf; this.p = 0; this.len = buf.length; }
    varint() { const buf = this.buf; const start = this.p; let r = 0, mult = 1, b, n = 0; do { b = buf[this.p++]; r += (b & 0x7f) * mult; mult *= 128; n++; } while (b & 0x80); if (n > 7) { this.p = start; return this.varintBig(); } return r; }
    varintBig() { const buf = this.buf; let r = 0n, s = 0n, b; do { b = buf[this.p++]; r |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80); return r; }
    skipVarint() { const buf = this.buf; while (buf[this.p++] & 0x80) { } }
    u32() { const buf = this.buf, p = this.p; this.p += 4; return (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0; }
}
const numOrBig = (b) => (b <= 9007199254740991n && b >= -9007199254740991n) ? Number(b) : b;
const B64JSON = function () { return this.toString('base64'); };
export function makeCodec(TABLE, opts = {}) {
    const Long = opts.Long;
    // when opts.bytesJSON, decoded bytes stay real Buffers but JSON.stringify them as base64 (logging only)
    const tagBytes = opts.bytesJSON ? (b) => (Object.defineProperty(b, 'toJSON', { value: B64JSON, enumerable: false, configurable: true }), b) : (b) => b;
    const toLong = (big) => Long ? Long.fromString(BigInt.asIntN(64, big).toString()) : numOrBig(BigInt.asIntN(64, big));
    function writeScalar(w, f, v) {
        switch (f.k) {
            case 'varint':
                if (f.s === 'bool') w.byte(v ? 1 : 0);
                else if (f.s === 'zigzag' || f.s === 'zigzaglong') w.varintBig(zigzag(v));
                else w.vint(v);
                break;
            case 'i64': f.s === 'double' ? w.double(v) : w.fixed64(v); break;
            case 'i32': f.s === 'float' ? w.float(v) : w.fixed32(v); break;
            case 'string': { const b = Buffer.from(String(v), 'utf8'); w.varintNum(b.length); w.raw(b); break; }
            case 'bytes': { const b = toBuf(v); w.varintNum(b.length); w.raw(b); break; }
            case 'msg': { const s = new Writer(); encodeInto(s, TABLE[f.msg], v); const b = s.finish(); w.varintNum(b.length); w.raw(b); break; }
        }
    }
    function encodeInto(w, T, obj) {
        if (!T) throw new Error('unknown message in table');
        const order = T.order;
        for (let i = 0; i < order.length; i++) {
            const f = order[i]; let v = obj[f.name]; if (v == null) continue;
            if (f.k === 'varint' && f.s === 'enum') {
                const re = (x) => { if (typeof x !== 'string') return x; const n = (f.enumMap && x in f.enumMap) ? f.enumMap[x] : Number(x); return Number.isFinite(n) ? n : undefined; };
                if (f.rep) { v = (Array.isArray(v) ? v : [v]).map(re).filter(x => x !== undefined); if (!v.length) continue; }
                else { v = re(v); if (v === undefined) continue; }
            }
            if (f.rep) {
                if (!Array.isArray(v)) v = [v];
                if (f.packed && (f.k === 'varint' || f.k === 'i64' || f.k === 'i32')) { const s = new Writer(); for (let j = 0; j < v.length; j++) writeScalar(s, f, v[j]); const b = s.finish(); w.tag(f.id, 2); w.varintNum(b.length); w.raw(b); }
                else { const wt = wireOf(f); for (let j = 0; j < v.length; j++) { w.tag(f.id, wt); writeScalar(w, f, v[j]); } }
            } else { w.tag(f.id, wireOf(f)); writeScalar(w, f, v); }
        }
    }
    function encode(msgName, obj) { const w = new Writer(); encodeInto(w, TABLE[msgName], obj); return w.finish(); }
    function readScalar(r, f) {
        switch (f.k) {
            case 'varint': {
                if (f.s === 'bool') return !!r.varint();
                if (f.s === 'zigzag') { const u = r.varintBig(); return numOrBig((u >> 1n) ^ -(u & 1n)); }
                if (f.s === 'zigzaglong') { const u = r.varintBig(); return toLong((u >> 1n) ^ -(u & 1n)); }
                if (f.s === 'enum') { const v = r.varint(); return typeof v === 'bigint' ? Number(BigInt.asIntN(32, v)) : (v | 0); }
                if (f.s === 'long') { const v = r.varint(); return toLong(typeof v === 'bigint' ? v : BigInt(v)); }
                const v = r.varint(); return typeof v === 'bigint' ? numOrBig(BigInt.asIntN(64, v)) : v;
            }
            case 'i64': { const b = Buffer.from(r.buf.buffer, r.buf.byteOffset + r.p, 8); r.p += 8; return f.s === 'double' ? b.readDoubleLE(0) : toLong(b.readBigUInt64LE(0)); }
            case 'i32': { if (f.s === 'float') { const b = Buffer.from(r.buf.buffer, r.buf.byteOffset + r.p, 4); r.p += 4; return b.readFloatLE(0); } return r.u32(); }
            case 'string': { const len = r.varint(); const s = Buffer.from(r.buf.buffer, r.buf.byteOffset + r.p, len).toString('utf8'); r.p += len; return s; }
            case 'bytes': { const len = r.varint(); const b = tagBytes(Buffer.from(r.buf.subarray(r.p, r.p + len))); r.p += len; return b; }
            case 'msg': { const len = r.varint(); const sub = r.buf.subarray(r.p, r.p + len); r.p += len; return decode(f.msg, sub); }
        }
    }
    function decode(msgName, buf) {
        const T = TABLE[msgName]; if (!T) throw new Error('unknown message: ' + msgName);
        const byId = T.byId; const obj = {}; const r = new Reader(buf);
        while (r.p < r.len) {
            const tag = r.varint(); const id = tag >>> 3; const wire = tag & 7; const f = byId[id];
            if (!f) { skip(r, wire); continue; }
            if (f.rep && wire === 2 && (f.k === 'varint' || f.k === 'i64' || f.k === 'i32')) { const len = r.varint(); const end = r.p + len; const arr = obj[f.name] || (obj[f.name] = []); while (r.p < end) arr.push(readScalar(r, f)); }
            else { const val = readScalar(r, f); if (f.rep) (obj[f.name] || (obj[f.name] = [])).push(val); else obj[f.name] = val; }
        }
        return obj;
    }
    function skip(r, wire) { if (wire === 0) r.skipVarint(); else if (wire === 2) { const len = r.varint(); r.p += len; } else if (wire === 1) r.p += 8; else if (wire === 5) r.p += 4; }
    return { encode, decode };
}
