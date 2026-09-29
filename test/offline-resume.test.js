import assert from 'node:assert/strict';
import test from 'node:test';
import { makeOfflineNodeProcessor } from '../lib/Utils/offline-node-processor.js';
import { makeOfflineResumeController } from '../lib/Utils/offline-resume.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

// Deterministic, injectable clock for the controller's timers.
function fakeClock() {
    let time = 0;
    let seq = 1;
    const timers = new Map();
    return {
        now: () => time,
        setTimer: (fn, ms) => {
            const id = seq++;
            timers.set(id, { fn, at: time + ms });
            return id;
        },
        clearTimer: (id) => { timers.delete(id); },
        pendingTimers: () => timers.size,
        advance(ms) {
            time += ms;
            let ran = true;
            while (ran) {
                ran = false;
                for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
                    if (t.at <= time) {
                        timers.delete(id);
                        ran = true;
                        t.fn();
                        break;
                    }
                }
            }
        }
    };
}

// Minimal fake of the offline node queue the controller inspects.
function fakeQueue() {
    let pending = 0;
    let processed = 0;
    let received = 0;
    let failed = 0;
    const listeners = new Set();
    let idleResolvers = [];
    return {
        get pendingCount() { return pending; },
        get processedCount() { return processed; },
        get receivedCount() { return received; },
        get failedCount() { return failed; },
        isIdle() { return pending === 0; },
        waitForIdle() {
            if (pending === 0) return Promise.resolve();
            return new Promise(r => idleResolvers.push(r));
        },
        onStanzaProcessed(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        _recv(n = 1) { pending += n; received += n; },
        _process(n = 1) {
            for (let i = 0; i < n; i++) {
                if (pending <= 0) break;
                pending--; processed++;
                for (const l of listeners) l({ pending, processed });
            }
            if (pending === 0) {
                const rs = idleResolvers; idleResolvers = [];
                rs.forEach(r => r());
            }
        }
    };
}

function makeController(overrides = {}) {
    const clock = fakeClock();
    const requests = [];
    const finalizations = [];
    const controller = makeOfflineResumeController({
        logger: { info() { }, warn() { }, debug() { }, trace() { } },
        batchSize: 200,
        refillThreshold: 200,
        refillDebounceMs: 100,
        drainTimeoutMs: 60000,
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        sendBatchRequest: (count) => requests.push(count),
        finalize: (status, metrics) => finalizations.push({ status, metrics }),
        ...overrides
    });
    return { controller, clock, requests, finalizations };
}

// ---------------------------------------------------------------------------
// offline node processor
// ---------------------------------------------------------------------------

test('processor: preserves FIFO order and reports counts, waitForIdle resolves', async () => {
    const seen = [];
    const proc = makeOfflineNodeProcessor(new Map([
        ['message', async (node) => { seen.push(node.id); }]
    ]), { isWsOpen: () => true }, 2);
    for (let i = 0; i < 5; i++) proc.enqueue('message', { id: i });
    assert.equal(proc.receivedCount, 5);
    await proc.waitForIdle();
    assert.deepEqual(seen, [0, 1, 2, 3, 4]);
    assert.equal(proc.processedCount, 5);
    assert.equal(proc.receivedCount, 5);
    assert.equal(proc.failedCount, 0);
    assert.equal(proc.isIdle(), true);
});

test('processor: a handler error is counted and does not block the rest', async () => {
    const seen = [];
    const proc = makeOfflineNodeProcessor(new Map([
        ['message', async (node) => {
            if (node.id === 1) throw new Error('boom');
            seen.push(node.id);
        }]
    ]), { isWsOpen: () => true, onUnexpectedError: () => { } });
    for (let i = 0; i < 4; i++) proc.enqueue('message', { id: i });
    await proc.waitForIdle();
    assert.deepEqual(seen, [0, 2, 3]);
    assert.equal(proc.processedCount, 4);
    assert.equal(proc.failedCount, 1);
});

test('processor: dispose resolves waitForIdle (no hang) and clears the queue', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const proc = makeOfflineNodeProcessor(new Map([
        ['message', async () => { await gate; }]
    ]), { isWsOpen: () => true });
    proc.enqueue('message', { id: 0 });
    proc.enqueue('message', { id: 1 });
    const idle = proc.waitForIdle();
    proc.dispose();
    await idle; // must resolve despite the in-flight handler never being released
    assert.equal(proc.pendingCount, 0);
    release();
});

test('processor: waitForIdle added mid-processing is not a lost wakeup', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    let first = true;
    const proc = makeOfflineNodeProcessor(new Map([
        ['message', async () => { if (first) { first = false; await gate; } }]
    ]), { isWsOpen: () => true });
    proc.enqueue('message', { id: 0 });
    proc.enqueue('message', { id: 1 });
    await tick();
    const idle = proc.waitForIdle(); // registered while the loop is busy
    let resolved = false;
    idle.then(() => { resolved = true; });
    assert.equal(resolved, false);
    release();
    await idle;
    assert.equal(resolved, true);
    assert.equal(proc.isIdle(), true);
});

// ---------------------------------------------------------------------------
// offline resume controller
// ---------------------------------------------------------------------------

test('controller: preview requests the first batch', () => {
    const { controller, requests } = makeController();
    const q = fakeQueue();
    controller.attachQueue(q);
    controller.begin();
    controller.handlePreview(550);
    assert.deepEqual(requests, [200]);
});

test('controller: 550-stanza backlog triggers multiple adaptive batch requests', () => {
    const { controller, clock, requests } = makeController();
    const q = fakeQueue();
    controller.attachQueue(q);
    controller.begin();
    controller.handlePreview(550);
    // window 1 delivered
    q._recv(200); controller.noteReceived();
    clock.advance(100);
    // process window 1, deliver window 2
    q._process(200); q._recv(200); controller.noteReceived();
    clock.advance(100);
    // process window 2, deliver the last 150
    q._process(200); q._recv(150); controller.noteReceived();
    clock.advance(100);
    assert.ok(requests.length >= 3, `expected multiple batches, got ${requests.length}`);
    assert.ok(requests.every(c => c === 200));
});

test('controller: never more than one batch request in flight', () => {
    const { controller, clock, requests } = makeController();
    const q = fakeQueue();
    controller.attachQueue(q);
    controller.begin();
    controller.handlePreview(400); // request #1, batch in flight
    assert.equal(requests.length, 1);
    // no delivery yet -> refill attempts must not fire a second request
    controller.noteReceived === undefined; // no-op guard
    clock.advance(1000);
    assert.equal(requests.length, 1);
    // a delivery frees the window -> exactly one more request
    q._recv(200); controller.noteReceived();
    clock.advance(100);
    assert.equal(requests.length, 2);
});

test('controller: terminal while queue non-empty does NOT finalize early; drains to exactly one complete', async () => {
    const { controller, clock, finalizations } = makeController();
    const q = fakeQueue();
    controller.attachQueue(q);
    controller.begin();
    controller.handlePreview(100);
    q._recv(100); controller.noteReceived();
    controller.handleTerminal(100); // server done, but 100 still pending locally
    assert.equal(finalizations.length, 0, 'must not finalize while local queue is busy');
    q._process(100); // queue drains
    await tick();
    assert.equal(finalizations.length, 1);
    assert.equal(finalizations[0].status, 'complete');
    assert.equal(clock.pendingTimers(), 0, 'timers cleared after finalize');
});

test('controller: missing terminal -> timeout finalizes as degraded, never a false complete', () => {
    const { controller, clock, finalizations } = makeController({ drainTimeoutMs: 5000 });
    const q = fakeQueue();
    controller.attachQueue(q);
    controller.begin();
    controller.handlePreview(50);
    q._recv(50); controller.noteReceived();
    q._process(50); // local queue empty, but the server terminal never arrives
    clock.advance(5000);
    assert.equal(finalizations.length, 1);
    assert.equal(finalizations[0].status, 'degraded');
});

test('controller: dispose during drain clears timers and does not finalize', () => {
    const { controller, clock, finalizations } = makeController({ drainTimeoutMs: 5000 });
    const q = fakeQueue();
    controller.attachQueue(q);
    controller.begin();
    controller.handlePreview(300);
    q._recv(200); controller.noteReceived();
    controller.dispose();
    clock.advance(10000);
    assert.equal(finalizations.length, 0);
    assert.equal(clock.pendingTimers(), 0);
});

test('controller: empty backlog (terminal, nothing pending) finalizes complete once', async () => {
    const { controller, finalizations } = makeController();
    const q = fakeQueue();
    controller.attachQueue(q);
    controller.begin();
    controller.handleTerminal(0);
    await tick();
    assert.equal(finalizations.length, 1);
    assert.equal(finalizations[0].status, 'complete');
});
