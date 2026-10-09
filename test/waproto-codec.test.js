import assert from 'node:assert/strict';
import test from 'node:test';
import { proto } from '../WAProto/compiler.js';

const hex = u => Buffer.from(u).toString('hex');
const enc = (T, o) => Buffer.from(T.encode(o).finish());
const roundtrip = (T, o) => T.decode(T.encode(o).finish());

test('plain text preserves utf8, emoji and newline', () => {
    const text = 'Hi\n😀 café €';
    const out = roundtrip(proto.Message, { conversation: text });
    assert.equal(out.conversation, text);
});

test('nested message with contextInfo round-trips', () => {
    const fx = { extendedTextMessage: { text: 'hello', contextInfo: { stanzaId: 'abc', expiration: 86400 } } };
    const out = roundtrip(proto.Message, fx);
    assert.equal(out.extendedTextMessage.text, 'hello');
    assert.equal(out.extendedTextMessage.contextInfo.stanzaId, 'abc');
    assert.equal(out.extendedTextMessage.contextInfo.expiration, 86400);
});

test('groupStatusMessageV2 (FutureProofMessage) round-trips', () => {
    const out = roundtrip(proto.Message, { groupStatusMessageV2: { message: { conversation: 'status!' } } });
    assert.equal(out.groupStatusMessageV2.message.conversation, 'status!');
});

test('nativeFlowMessage.buttons encodes an array of NativeFlowButton', () => {
    const fx = {
        buttons: [
            { name: 'quick_reply', buttonParamsJson: '{"display_text":"A"}' },
            { name: 'cta_url', buttonParamsJson: '{"url":"https://x"}' }
        ],
        messageVersion: 1
    };
    const out = roundtrip(proto.Message.InteractiveMessage.NativeFlowMessage, fx);
    assert.equal(out.buttons.length, 2);
    assert.equal(out.buttons[0].name, 'quick_reply');
    assert.equal(out.buttons[1].buttonParamsJson, '{"url":"https://x"}');
    assert.equal(out.messageVersion, 1);
});

test('stickerPackMessage with Sticker objects, bytes and uint64', () => {
    const fx = {
        stickerPackId: 'pack1', name: 'Pack',
        stickers: [
            { fileName: 's1.webp', isAnimated: false, emojis: ['😀', '🎉'] },
            { fileName: 's2.webp', isAnimated: true, emojis: ['🔥'] }
        ],
        fileLength: 123456789,
        fileSha256: Buffer.from('00112233', 'hex')
    };
    const out = roundtrip(proto.Message.StickerPackMessage, fx);
    assert.equal(out.stickers.length, 2);
    assert.deepEqual(out.stickers[0].emojis, ['😀', '🎉']);
    assert.equal(out.stickers[1].isAnimated, true);
    assert.equal(out.fileLength.toString(), '123456789');
    assert.equal(hex(out.fileSha256), '00112233');
});

test('empty repeated fields emit no bytes (packed and non-packed)', () => {
    // packed numeric (scanLengths) and message (stickers) both omitted when empty
    assert.equal(enc(proto.Message.ImageMessage, { scanLengths: [] }).length, 0);
    assert.equal(hex(enc(proto.Message.ImageMessage, { url: 'x', scanLengths: [] })),
        hex(enc(proto.Message.ImageMessage, { url: 'x' })));
    assert.equal(enc(proto.Message.StickerPackMessage, { stickers: [] }).length, 0);
    const out = roundtrip(proto.Message.ImageMessage, { url: 'x', scanLengths: [] });
    assert.equal('scanLengths' in out, false);
});

test('packed repeated uint32 round-trips', () => {
    const out = roundtrip(proto.DeviceListMetadata, { senderKeyIndexes: [1, 2, 300, 70000] });
    assert.deepEqual(out.senderKeyIndexes, [1, 2, 300, 70000]);
});

test('enum accepts number and string identically', () => {
    const byNumber = enc(proto.Message.ExtendedTextMessage, { text: 't', previewType: 1 });
    const byString = enc(proto.Message.ExtendedTextMessage, { text: 't', previewType: 'VIDEO' });
    assert.equal(hex(byNumber), hex(byString));
    assert.equal(roundtrip(proto.Message.ExtendedTextMessage, { text: 't', previewType: 'VIDEO' }).previewType, 1);
});

test('bytes accept Buffer and base64 string identically', () => {
    const fromBuffer = enc(proto.Message.ImageMessage, { mediaKey: Buffer.from('deadbeef', 'hex') });
    const fromBase64 = enc(proto.Message.ImageMessage, { mediaKey: '3q2+7w==' });
    assert.equal(hex(fromBuffer), hex(fromBase64));
    assert.equal(hex(roundtrip(proto.Message.ImageMessage, { mediaKey: '3q2+7w==' }).mediaKey), 'deadbeef');
});

test('64-bit integer from string keeps full precision (> 2^53)', () => {
    const out = roundtrip(proto.Message.ImageMessage, { fileLength: '9007199254740993' });
    assert.equal(out.fileLength.toString(), '9007199254740993');
});

test('negative 64-bit integer from string round-trips', () => {
    const out = roundtrip(proto.Message.ImageMessage, { mediaKeyTimestamp: '-5000000000' });
    assert.equal(out.mediaKeyTimestamp.toString(), '-5000000000');
});

test('map<string,string> round-trips', () => {
    const out = roundtrip(proto.SyncActionValue.MusicUserIdAction, { musicUserId: 'u', musicUserIdMap: { a: '1', b: '2' } });
    assert.equal(out.musicUserId, 'u');
    assert.deepEqual(out.musicUserIdMap, { a: '1', b: '2' });
});

test('map<uint32, Field> (message values) round-trips', () => {
    const fx = { version: 7, field: { 1: { minVersion: 2, maxVersion: 5 }, 42: { isMessage: true } } };
    const out = roundtrip(proto.Config, fx);
    assert.equal(out.version, 7);
    assert.equal(out.field['1'].minVersion, 2);
    assert.equal(out.field['1'].maxVersion, 5);
    assert.equal(out.field['42'].isMessage, true);
});

test('rejects a string where a repeated message array is required', () => {
    assert.throws(() => proto.Message.InteractiveMessage.NativeFlowMessage.encode({ buttons: 'nope' }).finish(),
        /repeated message field expects an array/);
});

test('rejects a primitive where a message is required', () => {
    assert.throws(() => proto.Message.encode({ extendedTextMessage: 'nope' }).finish(),
        /expected message object/);
});
