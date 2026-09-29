import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHistoryChunkQueue, HISTORY_CHUNK_STATE } from '../lib/Utils/history-chunk-queue.js';

// RECENT/FULL are the ordered types in the real proto; use stable stand-ins here.
const RECENT = 2;
const FULL = 5;
const BOOTSTRAP = 0;

const silentLogger = { info() { }, warn() { }, debug() { }, trace() { }, error() { } };

function makeHarness(overrides = {}) {
    const events = { applied: [], receipts: [], downloads: [], recentCompleted: [] };
    const q = makeHistoryChunkQueue({
        logger: silentLogger,
        orderedSyncTypes: [RECENT, FULL],
        maxRetries: 3,
        backoffBaseMs: 1,
        setTimer: (fn) => setImmediate(fn),
        clearTimer: () => { },
        now: () => 1,
        downloadAndDecode: async (n) => { events.downloads.push(n.id); return { decoded: n.id }; },
        applyChunk: async (decoded, meta) => { events.applied.push({ id: decoded.decoded, order: meta.chunkOrder, isLatest: meta.isLatest }); },
        sendCompletionReceipt: async (msgKey) => { events.receipts.push(msgKey.id); },
        onRecentCompleted: (meta) => { events.recentCompleted.push(meta.chunkOrder); },
        ...overrides
    });
    return { q, events };
}

const notif = (id, syncType, chunkOrder, progress) => ({ id, syncType, chunkOrder, progress });
const key = (id) => ({ remoteJid: 'x@g.us', id });

test('history: successful apply sends exactly one hist_sync receipt, after apply', async () => {
    const { q, events } = makeHarness();
    await q.enqueue(notif('n1', RECENT, 1, 50), key('n1'));
    await q.drain();
    assert.deepEqual(events.applied.map(a => a.id), ['n1']);
    assert.deepEqual(events.receipts, ['n1']);
    // receipt only after apply
    assert.equal(events.applied.length, 1);
    assert.equal(q.getRecord('n1').state, HISTORY_CHUNK_STATE.COMPLETION_RECEIPT_SENT);
});

test('history: download failure sends no receipt and ends failed after maxRetries', async () => {
    const { q, events } = makeHarness({
        downloadAndDecode: async () => { throw new Error('download failed'); }
    });
    await q.enqueue(notif('n1', RECENT, 1, 100), key('n1'));
    // drain repeatedly to let backoff retries (setImmediate) run
    for (let i = 0; i < 6; i++) { await q.drain(); await new Promise(r => setImmediate(r)); }
    assert.deepEqual(events.receipts, []);
    assert.equal(q.getRecord('n1').state, HISTORY_CHUNK_STATE.FAILED);
    assert.equal(q.getRecord('n1').attempts >= 3, true);
});

test('history: apply failure sends no receipt', async () => {
    const { q, events } = makeHarness({
        applyChunk: async () => { throw new Error('apply failed'); }
    });
    await q.enqueue(notif('n1', RECENT, 1, 100), key('n1'));
    for (let i = 0; i < 6; i++) { await q.drain(); await new Promise(r => setImmediate(r)); }
    assert.deepEqual(events.receipts, []);
    assert.equal(q.getRecord('n1').state, HISTORY_CHUNK_STATE.FAILED);
});

test('history: duplicate notification does not re-apply or re-send', async () => {
    const { q, events } = makeHarness();
    await q.enqueue(notif('n1', RECENT, 1, 100), key('n1'));
    await q.drain();
    await q.enqueue(notif('n1', RECENT, 1, 100), key('n1')); // duplicate
    await q.drain();
    assert.deepEqual(events.applied.map(a => a.id), ['n1']);
    assert.deepEqual(events.receipts, ['n1']);
});

test('history: chunk 3 is not applied before chunk 2', async () => {
    const { q, events } = makeHarness();
    // enqueue both without awaiting each (they collect before the deferred loop runs)
    const p3 = q.enqueue(notif('c3', RECENT, 3, 100), key('c3'));
    const p2 = q.enqueue(notif('c2', RECENT, 2, 50), key('c2'));
    await Promise.all([p2, p3]);
    assert.deepEqual(events.applied.map(a => a.order), [2, 3]);
    assert.deepEqual(events.receipts, ['c2', 'c3']);
});

test('history: progress===100 -> recentCompleted only after successful apply', async () => {
    const { q, events } = makeHarness();
    await q.enqueue(notif('c1', RECENT, 1, 50), key('c1'));
    await q.enqueue(notif('c2', RECENT, 2, 100), key('c2'));
    await q.drain();
    assert.deepEqual(events.applied.map(a => a.order), [1, 2]);
    // recentCompleted only for the progress===100 chunk, and only after it applied
    assert.deepEqual(events.recentCompleted, [2]);
    assert.deepEqual(events.applied.find(a => a.order === 2).isLatest, true);
    assert.deepEqual(events.applied.find(a => a.order === 1).isLatest, false);
});

test('history: restart resumes a persisted pending chunk', async () => {
    // shared in-memory persistence across two queue instances
    const store = new Map();
    const persistence = {
        loadAll: async () => [...store.values()].map(r => ({ ...r })),
        put: async (r) => { store.set(r.id, { ...r }); },
        remove: async (id) => { store.delete(id); }
    };
    // first instance: enqueue but simulate a crash before processing by not draining
    const first = makeHistoryChunkQueue({
        logger: silentLogger, orderedSyncTypes: [RECENT], persistence,
        downloadAndDecode: async () => { throw new Error('crash before processing'); },
        applyChunk: async () => { }, sendCompletionReceipt: async () => { },
        setTimer: () => 0, clearTimer: () => { }, now: () => 1, maxRetries: 99
    });
    // do NOT await: the retry timer is disabled, so this chunk never reaches a
    // terminal state; we only need it persisted before the simulated crash.
    const pendingFirst = first.enqueue(notif('n1', RECENT, 1, 100), key('n1'));
    pendingFirst.catch(() => { });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.equal(store.has('n1'), true);
    first.dispose();
    // second instance (restart): should resume and complete
    const applied = [];
    const receipts = [];
    const second = makeHistoryChunkQueue({
        logger: silentLogger, orderedSyncTypes: [RECENT], persistence,
        downloadAndDecode: async (n) => ({ decoded: n?.id ?? 'resumed' }),
        applyChunk: async (_d, meta) => { applied.push(meta.chunkOrder); },
        sendCompletionReceipt: async (msgKey) => { receipts.push(msgKey.id); },
        setTimer: (fn) => setImmediate(fn), clearTimer: () => { }, now: () => 1
    });
    await second.drain();
    assert.deepEqual(applied, [1]);
    assert.deepEqual(receipts, ['n1']);
});

test('history: enqueue resolves only after the chunk is applied + receipt sent', async () => {
    const order = [];
    const q = makeHistoryChunkQueue({
        logger: silentLogger, orderedSyncTypes: [RECENT],
        setTimer: (fn) => setImmediate(fn), clearTimer: () => { }, now: () => 1,
        downloadAndDecode: async (n) => ({ decoded: n.id }),
        applyChunk: async () => { order.push('apply'); },
        sendCompletionReceipt: async () => { order.push('receipt'); }
    });
    const done = q.enqueue(notif('n1', RECENT, 1, 100), key('n1'));
    order.push('enqueued');
    const state = await done;
    order.push('awaited');
    assert.equal(state, HISTORY_CHUNK_STATE.COMPLETION_RECEIPT_SENT);
    // apply + receipt happened before the await resolved
    assert.deepEqual(order, ['enqueued', 'apply', 'receipt', 'awaited']);
});

test('history: unordered types (bootstrap) process without order gating', async () => {
    const { q, events } = makeHarness();
    await q.enqueue(notif('b1', BOOTSTRAP, 0, 100), key('b1'));
    await q.drain();
    assert.deepEqual(events.receipts, ['b1']);
});
