/**
 * Serial processor for offline (backlog) stanzas delivered on reconnect.
 *
 * Guarantees:
 *  - FIFO order is preserved; exactly one processing loop runs at a time.
 *  - Handler errors are counted and swallowed so one bad node cannot block the
 *    rest of the queue.
 *  - `waitForIdle()` never loses a wakeup and never stays pending forever: it
 *    resolves when the queue drains, or immediately on `dispose()` (socket end
 *    / abort), so no caller hangs on a dead socket.
 *
 * Lifecycle API:
 *  - enqueue(type, node)
 *  - pendingCount / processedCount / failedCount / receivedCount (getters)
 *  - isIdle()
 *  - waitForIdle()            -> Promise resolved when idle (or disposed)
 *  - onStanzaProcessed(fn)    -> subscribe; returns an unsubscribe fn
 *  - dispose()                -> stop, clear queue, resolve all waiters
 */
export function makeOfflineNodeProcessor(nodeProcessorMap, deps, batchSize = 10) {
    const nodes = [];
    let head = 0;
    let processing = false;
    let received = 0;
    let processed = 0;
    let failed = 0;
    let disposed = false;
    const idleWaiters = [];
    const stanzaListeners = new Set();
    const isWsOpen = typeof deps?.isWsOpen === 'function' ? deps.isWsOpen : () => true;
    const yieldToEventLoop = typeof deps?.yieldToEventLoop === 'function'
        ? deps.yieldToEventLoop
        : () => new Promise(resolve => setImmediate(resolve));
    const onUnexpectedError = typeof deps?.onUnexpectedError === 'function' ? deps.onUnexpectedError : () => { };
    const pending = () => nodes.length - head;
    const isIdle = () => !processing && pending() === 0;
    const resolveIdleWaiters = () => {
        if (!isIdle() && !disposed) {
            return;
        }
        while (idleWaiters.length) {
            const resolve = idleWaiters.shift();
            resolve();
        }
    };
    const notifyStanza = (info) => {
        for (const listener of stanzaListeners) {
            try {
                listener(info);
            }
            catch (err) {
                onUnexpectedError(err, 'offline stanza listener');
            }
        }
    };
    const compact = () => {
        if (head === 0) {
            return;
        }
        if (head >= nodes.length) {
            nodes.length = 0;
            head = 0;
        }
        else if (head > 64 && head * 2 >= nodes.length) {
            nodes.splice(0, head);
            head = 0;
        }
    };
    const runLoop = async () => {
        if (processing) {
            return;
        }
        processing = true;
        try {
            let inBatch = 0;
            while (head < nodes.length) {
                if (disposed || !isWsOpen()) {
                    break;
                }
                const { type, node } = nodes[head++];
                const nodeProcessor = nodeProcessorMap.get(type);
                if (!nodeProcessor) {
                    failed++;
                    onUnexpectedError(new Error(`unknown offline node type: ${type}`), 'processing offline node');
                }
                else {
                    try {
                        await nodeProcessor(node);
                    }
                    catch (err) {
                        failed++;
                        onUnexpectedError(err, `processing offline ${type}`);
                    }
                }
                processed++;
                notifyStanza({ type, pending: pending(), processed, failed });
                inBatch++;
                if (inBatch >= batchSize) {
                    inBatch = 0;
                    compact();
                    await yieldToEventLoop();
                }
            }
            compact();
        }
        finally {
            processing = false;
            resolveIdleWaiters();
        }
    };
    const kick = () => {
        if (processing || disposed) {
            return;
        }
        runLoop().catch(err => {
            processing = false;
            onUnexpectedError(err, 'processing offline nodes');
            resolveIdleWaiters();
        });
    };
    return {
        enqueue(type, node) {
            if (disposed) {
                return;
            }
            received++;
            nodes.push({ type, node });
            kick();
        },
        get pendingCount() {
            return pending();
        },
        get processedCount() {
            return processed;
        },
        get failedCount() {
            return failed;
        },
        get receivedCount() {
            return received;
        },
        isIdle,
        waitForIdle() {
            if (disposed || isIdle()) {
                return Promise.resolve();
            }
            return new Promise(resolve => {
                idleWaiters.push(resolve);
            });
        },
        onStanzaProcessed(fn) {
            stanzaListeners.add(fn);
            return () => stanzaListeners.delete(fn);
        },
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            nodes.length = 0;
            head = 0;
            while (idleWaiters.length) {
                const resolve = idleWaiters.shift();
                resolve();
            }
            stanzaListeners.clear();
        }
    };
}
