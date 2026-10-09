import assert from 'node:assert/strict';
import test from 'node:test';
import { proto } from '../WAProto/compiler.js';

const NativeFlow = proto.Message.InteractiveMessage.NativeFlowMessage;

const varint = n => {
    const out = [];
    while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    out.push(n);
    return out;
};

test('decode rejects a repeated message field flooded past the cap', () => {
    // field 1 (buttons) as an empty length-delimited message, repeated past the limit
    const entry = Buffer.from([0x0a, 0x00]);
    const flood = Buffer.concat(Array.from({ length: 100001 }, () => entry));
    assert.throws(() => NativeFlow.decode(flood), /too many values/);
});

test('decode accepts a repeated message field below the cap', () => {
    const entry = Buffer.from([0x0a, 0x00]);
    const ok = Buffer.concat(Array.from({ length: 100 }, () => entry));
    const out = NativeFlow.decode(ok);
    assert.equal(out.buttons.length, 100);
});

test('decode rejects a packed numeric field flooded past the cap', () => {
    // ImageMessage.scanLengths (field 22, packed uint32): 100001 zero varints
    const count = 100001;
    const tag = [0xb2, 0x01]; // field 22, wire 2
    const buf = Buffer.concat([Buffer.from(tag), Buffer.from(varint(count)), Buffer.alloc(count)]);
    assert.throws(() => proto.Message.ImageMessage.decode(buf), /too many values/);
});

test('decode rejects excessively nested messages', () => {
    let inner = { conversation: 'x' };
    for (let i = 0; i < 130; i++) inner = { groupStatusMessageV2: { message: inner } };
    const buf = proto.Message.encode(inner).finish();
    assert.throws(() => proto.Message.decode(buf), /nesting too deep/);
});

test('decode accepts shallow nesting', () => {
    let inner = { conversation: 'x' };
    for (let i = 0; i < 10; i++) inner = { groupStatusMessageV2: { message: inner } };
    const buf = proto.Message.encode(inner).finish();
    assert.doesNotThrow(() => proto.Message.decode(buf));
});

test('encode refuses to emit a string where a repeated Sticker array is required', () => {
    assert.throws(() => proto.Message.StickerPackMessage.encode({ stickers: '\u0000'.repeat(1000) }).finish(),
        /repeated message field expects an array/);
});

test('encode refuses to emit a string where a repeated NativeFlowButton array is required', () => {
    assert.throws(() => NativeFlow.encode({ buttons: '\u0000'.repeat(1000) }).finish(),
        /repeated message field expects an array/);
});
