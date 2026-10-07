import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildCompanionHelloContent,
    makeCompanionHelloRunner,
    makePairingController,
    normalizePairingPhoneNumber,
    PAIRING_CODE_MAX_AGE_SECONDS,
    PairingStage,
    pairingNonceValue,
    parseCompanionHelloResult
} from '../lib/Utils/pairing-state.js';
import { aesDecryptCTR, aesEncryptCTR, Curve, derivePairingCodeKey, hkdf } from '../lib/Utils/index.js';

const silent = { info() { }, warn() { }, debug() { }, error() { }, trace() { } };
const node = (tag, attrs, content) => ({ tag, attrs: attrs || {}, content });
const helloResult = (ref, stage = 'companion_hello') => node('iq', { type: 'result' }, [
    node('link_code_companion_reg', { stage }, ref === undefined ? [] : [node('link_code_pairing_ref', {}, Buffer.from(ref))])
]);
const findChild = (parent, tag) => parent.content.find(c => c.tag === tag);

function harness(overrides = {}) {
    const controller = makePairingController(overrides.controllerOpts);
    const calls = { queries: [], creds: [], tags: 0 };
    const runner = makeCompanionHelloRunner({
        controller,
        logger: silent,
        serverJid: '@s.whatsapp.net',
        query: overrides.query || (async (iq) => { calls.queries.push(iq); return helloResult('REF1'); }),
        generateMessageTag: () => `tag${++calls.tags}`,
        newPairingCode: overrides.newPairingCode || (() => 'ABCD2345'),
        newEphemeralKeyPair: overrides.newEphemeralKeyPair || (() => ({ public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) })),
        newAdvSecret: () => 'adv-secret',
        wrapEphemeralPub: async () => Buffer.from('wrapped-ephemeral-pub'),
        meJid: (p) => `${p}@s.whatsapp.net`,
        noiseKeyPublic: () => Buffer.from('noise'),
        companionPlatformId: () => Buffer.from('pid'),
        companionPlatformDisplay: () => 'Chrome (Linux)',
        applyAttemptCreds: (a) => calls.creds.push(a)
    });
    return { controller, runner, calls };
}

// ---------------------------------------------------------------- Test 1: nonce

test('nonce is a single 0x00 byte, not ASCII "0"', () => {
    const nonce = pairingNonceValue();
    assert.equal(nonce.length, 1);
    assert.equal(nonce[0], 0);
    const content = buildCompanionHelloContent({ wrappedEphemeralPub: Buffer.from('x'), noiseKeyPublic: Buffer.from('n'), companionPlatformId: Buffer.from('p'), companionPlatformDisplay: 'd' });
    const nonceNode = content.find(c => c.tag === 'link_code_pairing_nonce');
    assert.equal(nonceNode.content.length, 1);
    assert.equal(nonceNode.content[0], 0);
    assert.notEqual(nonceNode.content[0], '0'.charCodeAt(0));
});

// ---------------------------------------------------------------- Test 2: awaits IQ

test('requestPairingCode waits for the IQ result before returning the code', async () => {
    let resolveQuery;
    const { runner } = harness({ query: () => new Promise(r => { resolveQuery = r; }) });
    const promise = runner({ phoneNumber: '4915112345678' });
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(r => setImmediate(r));
    assert.equal(settled, false, 'must stay pending while the IQ is pending');
    resolveQuery(helloResult('REF1'));
    assert.equal(await promise, 'ABCD2345');
});

// ---------------------------------------------------------------- Test 3: IQ error

test('an IQ error rejects and yields no pairing code; state is reset', async () => {
    const { controller, runner } = harness({ query: async () => { const e = new Error('bad-request'); e.output = { statusCode: 400 }; throw e; } });
    await assert.rejects(runner({ phoneNumber: '4915112345678' }), /bad-request/);
    assert.equal(controller.state.ref, undefined);
    assert.equal(controller.state.stage, PairingStage.NotStarted);
});

// ---------------------------------------------------------------- Test 4: ref stored

test('companion hello ref is stored and stage advances', async () => {
    const { controller, runner } = harness({ query: async () => helloResult('ABC') });
    const code = await runner({ phoneNumber: '4915112345678' });
    assert.equal(code, 'ABCD2345');
    assert.equal(controller.state.ref.toString(), 'ABC');
    assert.equal(controller.state.stage, PairingStage.AfterSendCompanionHello);
});

// ---------------------------------------------------------------- Test 5/6: bad result

test('a missing ref rejects the request', async () => {
    const { runner } = harness({ query: async () => helloResult(undefined) });
    await assert.rejects(runner({ phoneNumber: '4915112345678' }), /Missing pairing ref/);
});

test('a wrong stage rejects the request', async () => {
    const { runner } = harness({ query: async () => helloResult('ABC', 'something_else') });
    await assert.rejects(runner({ phoneNumber: '4915112345678' }), /Invalid companion hello response/);
});

test('parseCompanionHelloResult returns the ref bytes for a valid response', () => {
    assert.equal(parseCompanionHelloResult(helloResult('REF')).toString(), 'REF');
    assert.throws(() => parseCompanionHelloResult(helloResult(undefined)), /Missing pairing ref/);
    assert.throws(() => parseCompanionHelloResult(helloResult('x', 'nope')), /Invalid companion hello response/);
});

// ---------------------------------------------------------------- Test 7: fresh key

test('each request uses a fresh ephemeral key (byte-level)', async () => {
    const { runner, calls } = harness({ newEphemeralKeyPair: () => Curve.generateKeyPair() });
    await runner({ phoneNumber: '4915112345678' });
    await runner({ phoneNumber: '4915112345678' });
    const [a, b] = calls.creds;
    assert.equal(Buffer.from(a.ephemeralKeyPair.public).equals(Buffer.from(b.ephemeralKeyPair.public)), false);
    assert.equal(Buffer.from(a.ephemeralKeyPair.private).equals(Buffer.from(b.ephemeralKeyPair.private)), false);
});

test('custom pairing code must be 8 chars', async () => {
    const { runner } = harness();
    await assert.rejects(runner({ phoneNumber: '4915112345678', customPairingCode: 'SHORT' }), /exactly 8 chars/);
    assert.equal(await runner({ phoneNumber: '4915112345678', customPairingCode: 'CUSTOM12' }), 'CUSTOM12');
});

// ---------------------------------------------------------------- Test 8/9: primary hello ref + TTL

test('primary hello with a mismatching ref is rejected before any finish', () => {
    const c = makePairingController();
    c.begin({ phone: '49', pairingCode: 'X', ephemeralKeyPair: {} });
    c.commitCompanionHello(Buffer.from('A'));
    assert.throws(() => c.validatePrimaryHello(Buffer.from('B')), /Unexpected pairing ref/);
    assert.doesNotThrow(() => c.validatePrimaryHello(Buffer.from('A')));
});

test('a pairing code older than 180s is rejected; exactly 180s is still allowed', () => {
    let t = 1_000_000;
    const c = makePairingController({ now: () => t * 1000 });
    c.begin({ phone: '49', pairingCode: 'X', ephemeralKeyPair: {} });
    c.commitCompanionHello(Buffer.from('A'));
    t += PAIRING_CODE_MAX_AGE_SECONDS; // exactly 180s
    assert.doesNotThrow(() => c.validatePrimaryHello(Buffer.from('A')));
    t += 1; // 181s
    assert.throws(() => c.validatePrimaryHello(Buffer.from('A')), /Pairing code expired/);
});

// ---------------------------------------------------------------- Test 15: max attempts

test('at most 3 repeated primary hello attempts after companion_finish', () => {
    const c = makePairingController();
    c.begin({ phone: '49', pairingCode: 'X', ephemeralKeyPair: {} });
    c.commitCompanionHello(Buffer.from('A'));
    c.markCompanionFinishSent();
    assert.equal(c.registerPrimaryHelloAttempt().needsAdvReinit, true); // 1
    c.markCompanionFinishSent();
    assert.equal(c.registerPrimaryHelloAttempt().needsAdvReinit, true); // 2
    c.markCompanionFinishSent();
    assert.equal(c.registerPrimaryHelloAttempt().needsAdvReinit, true); // 3
    c.markCompanionFinishSent();
    assert.throws(() => c.registerPrimaryHelloAttempt(), /Too many primary hello attempts/); // 4
});

test('a second begin() supersedes the first (generation guard)', () => {
    const c = makePairingController();
    const g1 = c.begin({ phone: '49', pairingCode: 'A', ephemeralKeyPair: {} });
    const g2 = c.begin({ phone: '49', pairingCode: 'B', ephemeralKeyPair: {} });
    assert.notEqual(g1, g2);
    assert.throws(() => c.commitCompanionHello(Buffer.from('ref'), g1), /superseded/);
    assert.doesNotThrow(() => c.commitCompanionHello(Buffer.from('ref'), g2));
});

test('normalizePairingPhoneNumber strips non-digits consistently', () => {
    for (const p of ['+49 123-456', '49 123 456', '49123456', '49-123-456']) {
        assert.equal(normalizePairingPhoneNumber(p), '49123456');
    }
});

// ---------------------------------------------------------------- Test 20: crypto regression

test('pairing crypto primitives have stable, correct behaviour', async () => {
    const salt = Buffer.alloc(32, 7);
    const key = await derivePairingCodeKey('ABCD2345', salt);
    assert.equal(key.length, 32);
    const key2 = await derivePairingCodeKey('ABCD2345', salt);
    assert.equal(Buffer.from(key).equals(Buffer.from(key2)), true, 'derivePairingCodeKey is deterministic');

    const iv = Buffer.alloc(16, 3);
    const plain = Buffer.from('a 32-byte-ish ephemeral pubkey!!');
    const ct = aesEncryptCTR(plain, Buffer.from(key), iv);
    const pt = aesDecryptCTR(ct, Buffer.from(key), iv);
    assert.equal(Buffer.from(pt).equals(plain), true, 'AES-CTR wrap/unwrap roundtrips');

    const out = hkdf(Buffer.alloc(32, 9), 32, { info: 'adv_secret' });
    assert.equal(Buffer.from(out).length, 32);

    const a = Curve.generateKeyPair();
    const b = Curve.generateKeyPair();
    const shared = Curve.sharedKey(a.private, b.public);
    assert.equal(Buffer.from(shared).length, 32);
});
