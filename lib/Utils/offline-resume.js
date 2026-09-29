/**
 * Coordinates the offline (backlog) delivery window on reconnect, matching
 * WhatsApp Web's behaviour:
 *  - request offline stanzas repeatedly and adaptively (max `batchSize` per
 *    batch, refill once the locally pending amount falls to <= `refillThreshold`);
 *  - keep the server terminal and the local queue state separate;
 *  - finalize (flush buffered events + signal `receivedPendingNotifications`)
 *    ONLY after the server terminal was received AND the local queue is empty;
 *  - a timeout may release buffered events so the client stays operational, but
 *    it reports a `degraded` status/warning instead of faking full success.
 *
 * IO/timers are injected so the controller is deterministically testable.
 *
 *  deps:
 *    sendBatchRequest(count)      -> send one <ib><offline_batch count/></ib>
 *    finalize(status, metrics)    -> flush buffer + emit connection.update once
 *                                    (status: 'complete' | 'degraded')
 *    logger                       -> pino-like (info/warn/debug/trace)
 *    setTimer(fn, ms) / clearTimer(id)   (default setTimeout/clearTimeout)
 *    now()                        (default Date.now)
 *    batchSize        (default 200)
 *    refillThreshold  (default 200)
 *    refillDebounceMs (default 100)
 *    drainTimeoutMs   (default 60000, 0 disables the timeout)
 */
export function makeOfflineResumeController(deps) {
    const sendBatchRequest = deps.sendBatchRequest;
    const finalizeCb = deps.finalize;
    const logger = deps.logger || { info() { }, warn() { }, debug() { }, trace() { } };
    const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer || (id => clearTimeout(id));
    const now = deps.now || (() => Date.now());
    const batchSize = deps.batchSize ?? 200;
    const refillThreshold = deps.refillThreshold ?? 200;
    const refillDebounceMs = deps.refillDebounceMs ?? 100;
    const drainTimeoutMs = deps.drainTimeoutMs ?? 60000;

    let queue = null;
    let unsubscribeQueue = null;
    let active = false;
    let previewCount = 0;
    let requestedBatches = 0;
    let terminalReceived = false;
    let serverTerminalCount = 0;
    let batchInFlight = false;
    let finalized = false;
    let disposed = false;
    let awaitingIdle = false;
    let startedMs = 0;
    let drainTimer = undefined;
    let refillTimer = undefined;

    const pending = () => (queue ? queue.pendingCount : 0);

    const metrics = () => ({
        previewCount,
        requestedBatches,
        received: queue ? queue.receivedCount : 0,
        pending: pending(),
        processed: queue ? queue.processedCount : 0,
        failed: queue ? queue.failedCount : 0,
        terminalReceived,
        serverTerminalCount,
        drainMs: startedMs ? now() - startedMs : 0
    });

    const clearRefillTimer = () => {
        if (refillTimer !== undefined) {
            clearTimer(refillTimer);
            refillTimer = undefined;
        }
    };
    const clearDrainTimer = () => {
        if (drainTimer !== undefined) {
            clearTimer(drainTimer);
            drainTimer = undefined;
        }
    };

    const doFinalize = (status) => {
        if (finalized || disposed) {
            return;
        }
        finalized = true;
        active = false;
        clearRefillTimer();
        clearDrainTimer();
        const m = metrics();
        if (status === 'degraded') {
            logger.warn(m, 'offline drain finalized as degraded (terminal or local queue did not settle in time)');
        }
        else {
            logger.info(m, 'offline drain complete');
        }
        try {
            finalizeCb(status, m);
        }
        catch (err) {
            logger.warn({ err }, 'offline drain finalize callback threw');
        }
    };

    const tryFinalize = () => {
        if (finalized || disposed || !terminalReceived) {
            return;
        }
        if (!queue || queue.isIdle()) {
            doFinalize('complete');
            return;
        }
        if (awaitingIdle) {
            return;
        }
        awaitingIdle = true;
        queue.waitForIdle().then(() => {
            awaitingIdle = false;
            // dispose() resolves waiters too; only finalize as complete if the
            // queue really drained (not because we were torn down / timed out).
            if (disposed || finalized) {
                return;
            }
            if (queue.isIdle()) {
                doFinalize('complete');
            }
        });
    };

    const requestBatch = () => {
        if (disposed || finalized || terminalReceived || batchInFlight) {
            return;
        }
        batchInFlight = true;
        requestedBatches++;
        try {
            sendBatchRequest(batchSize);
            logger.debug({ batchSize, requestedBatches, pending: pending() }, 'requested offline batch');
        }
        catch (err) {
            batchInFlight = false;
            logger.warn({ err }, 'failed to send offline batch request');
        }
    };

    const scheduleRefill = () => {
        if (disposed || finalized || terminalReceived || batchInFlight) {
            return;
        }
        if (refillTimer !== undefined) {
            return;
        }
        if (pending() > refillThreshold) {
            return;
        }
        refillTimer = setTimer(() => {
            refillTimer = undefined;
            requestBatch();
        }, refillDebounceMs);
    };

    return {
        attachQueue(q) {
            queue = q;
            if (unsubscribeQueue) {
                unsubscribeQueue();
            }
            unsubscribeQueue = queue.onStanzaProcessed
                ? queue.onStanzaProcessed(() => {
                    // a processed stanza lowers pending -> maybe refill / maybe finalize
                    scheduleRefill();
                    tryFinalize();
                })
                : null;
        },
        /** Called from the connect path once the initial event buffer is armed. */
        begin() {
            if (active || disposed) {
                return;
            }
            active = true;
            startedMs = now();
            if (drainTimeoutMs > 0) {
                drainTimer = setTimer(() => {
                    drainTimer = undefined;
                    if (!finalized && !disposed) {
                        doFinalize('degraded');
                    }
                }, drainTimeoutMs);
            }
        },
        /** <ib><offline_preview count=.../></ib> */
        handlePreview(count) {
            if (disposed) {
                return;
            }
            if (!active) {
                this.begin();
            }
            previewCount = Number(count) || 0;
            logger.info({ previewCount }, 'offline preview received');
            requestBatch();
        },
        /** One offline stanza was enqueued locally (delivery is flowing). */
        noteReceived() {
            if (disposed || finalized) {
                return;
            }
            // the outstanding batch produced a delivery -> free to pull the next window
            batchInFlight = false;
            scheduleRefill();
        },
        /** <ib><offline count=.../></ib> terminal from the server. */
        handleTerminal(count) {
            if (disposed) {
                return;
            }
            if (!active) {
                this.begin();
            }
            terminalReceived = true;
            serverTerminalCount = Number(count) || 0;
            clearRefillTimer();
            logger.info({ serverTerminalCount, pending: pending() }, 'offline server terminal received');
            tryFinalize();
        },
        isActive() {
            return active && !finalized;
        },
        isFinalized() {
            return finalized;
        },
        metrics,
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            active = false;
            clearRefillTimer();
            clearDrainTimer();
            if (unsubscribeQueue) {
                unsubscribeQueue();
                unsubscribeQueue = null;
            }
        }
    };
}
