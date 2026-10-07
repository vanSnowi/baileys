import { Boom } from '@hapi/boom';
import { createHash } from 'crypto';
import { getBinaryNodeChild, getBinaryNodeChildBuffer } from '../WABinary/index.js';

/**
 * Alt-device-linking (phone-number / pairing-code) runtime state, modelled after
 * current WhatsApp Web (companion_hello -> primary_hello -> companion_finish ->
 * pair-success). This is per-socket runtime state; it is NOT long-lived auth
 * credential state.
 */
export const PairingStage = Object.freeze({
    NotStarted: 'not_started',
    Initialized: 'initialized',
    AfterSendCompanionHello: 'after_send_companion_hello',
    AfterSendCompanionFinish: 'after_send_companion_finish',
    Paired: 'paired'
});

export const PAIRING_CODE_MAX_AGE_SECONDS = 180;
export const PAIRING_MAX_PRIMARY_HELLO_ATTEMPTS = 3;
export const PAIRING_CODE_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTVWXYZ';
export const PAIRING_CODE_RE = /^[123456789ABCDEFGHJKLMNPQRSTVWXYZ]{8}$/;

/** Strip everything but digits so "+49 123", "49-123" and "49123" map to one JID. */
export const normalizePairingPhoneNumber = (phoneNumber) => String(phoneNumber ?? '').replace(/[^0-9]/g, '');

/** Short, non-reversible fingerprint of a pairing ref for correlation logging. */
export const refFingerprint = (ref) => {
    if (!ref) {
        return undefined;
    }
    return createHash('sha256').update(Buffer.from(ref)).digest('hex').slice(0, 12);
};

export const maskPhoneNumber = (phone) => {
    const digits = normalizePairingPhoneNumber(phone);
    return digits.length > 4 ? `***${digits.slice(-4)}` : '***';
};

/**
 * Strictly parse a companion_hello IQ result and return the server pairing ref.
 * Throws a Boom(400) when the response is not a valid accepted companion_hello.
 */
export const parseCompanionHelloResult = (result) => {
    const reg = getBinaryNodeChild(result, 'link_code_companion_reg');
    if (!reg || reg.attrs?.stage !== 'companion_hello') {
        throw new Boom('Invalid companion hello response', { statusCode: 400, data: result });
    }
    const ref = getBinaryNodeChildBuffer(reg, 'link_code_pairing_ref');
    if (!ref?.length) {
        throw new Boom('Missing pairing ref', { statusCode: 400, data: result });
    }
    return Buffer.from(ref);
};

const bufEquals = (a, b) => !!a && !!b && Buffer.from(a).equals(Buffer.from(b));

export function makePairingController({ now = () => Date.now() } = {}) {
    const state = {
        phone: undefined,
        pairingCode: undefined,
        ref: undefined,
        stage: PairingStage.NotStarted,
        codeGenerationTs: undefined,
        primaryHelloAttemptCount: 0,
        ephemeralKeyPair: undefined,
        generation: 0
    };
    const nowSec = () => Math.floor(now() / 1000);
    const clearAttempt = () => {
        state.phone = undefined;
        state.pairingCode = undefined;
        state.ref = undefined;
        state.stage = PairingStage.NotStarted;
        state.codeGenerationTs = undefined;
        state.primaryHelloAttemptCount = 0;
        state.ephemeralKeyPair = undefined;
    };
    return {
        PairingStage,
        get state() {
            return state;
        },
        getState() {
            return state;
        },
        isCurrentGeneration(generation) {
            return state.generation === generation;
        },
        /** Drop any in-flight attempt (keeps the monotonic generation counter). */
        reset() {
            clearAttempt();
        },
        /** Start a fresh attempt; returns its generation id. Supersedes any prior attempt. */
        begin({ phone, pairingCode, ephemeralKeyPair }) {
            clearAttempt();
            const generation = ++state.generation;
            state.phone = phone;
            state.pairingCode = pairingCode;
            state.ephemeralKeyPair = ephemeralKeyPair;
            state.codeGenerationTs = nowSec();
            state.stage = PairingStage.Initialized;
            return generation;
        },
        /** Commit the server ref from an accepted companion_hello. Rejects if superseded. */
        commitCompanionHello(ref, generation) {
            if (generation !== undefined && state.generation !== generation) {
                throw new Boom('Pairing attempt was superseded', { statusCode: 409 });
            }
            state.ref = Buffer.from(ref);
            state.stage = PairingStage.AfterSendCompanionHello;
        },
        assertActivePairingCode() {
            if (!state.pairingCode) {
                throw new Boom('Missing active pairing state', { statusCode: 400 });
            }
            return state.pairingCode;
        },
        assertActiveEphemeralKeyPair() {
            if (!state.ephemeralKeyPair) {
                throw new Boom('Missing active pairing state', { statusCode: 400 });
            }
            return state.ephemeralKeyPair;
        },
        matchesRef(incomingRef) {
            return bufEquals(state.ref, incomingRef);
        },
        /** Validate an incoming primary_hello ref + code age. Returns the cached ref. */
        validatePrimaryHello(incomingRef) {
            if (!state.ref) {
                throw new Boom('Missing pairing ref', { statusCode: 400 });
            }
            if (!bufEquals(state.ref, incomingRef)) {
                throw new Boom('Unexpected pairing ref', { statusCode: 400 });
            }
            if (!state.codeGenerationTs) {
                throw new Boom('Missing active pairing state', { statusCode: 400 });
            }
            if (nowSec() - state.codeGenerationTs > PAIRING_CODE_MAX_AGE_SECONDS) {
                throw new Boom('Pairing code expired', { statusCode: 408 });
            }
            return state.ref;
        },
        /**
         * Account for a primary_hello attempt. When it repeats after companion_finish
         * was already sent, it re-opens the flow (caller must re-init the ADV secret);
         * past the max it throws. Returns { needsAdvReinit }.
         */
        registerPrimaryHelloAttempt() {
            state.primaryHelloAttemptCount += 1;
            if (state.stage === PairingStage.AfterSendCompanionFinish) {
                if (state.primaryHelloAttemptCount > PAIRING_MAX_PRIMARY_HELLO_ATTEMPTS) {
                    throw new Boom('Too many primary hello attempts', { statusCode: 429 });
                }
                state.stage = PairingStage.AfterSendCompanionHello;
                return { needsAdvReinit: true };
            }
            return { needsAdvReinit: false };
        },
        markCompanionFinishSent() {
            state.stage = PairingStage.AfterSendCompanionFinish;
        },
        /** Final success: keep nothing temporary. Auth creds live elsewhere. */
        markPaired() {
            clearAttempt();
            state.stage = PairingStage.Paired;
        }
    };
}

const noopLogger = { info() { }, warn() { }, debug() { }, error() { }, trace() { } };

/** The <link_code_pairing_nonce> value WhatsApp Web sends: a single 0x00 byte. */
export const pairingNonceValue = () => Buffer.from([0]);

/** Build the children of a companion_hello <link_code_companion_reg>. */
export const buildCompanionHelloContent = ({ wrappedEphemeralPub, noiseKeyPublic, companionPlatformId, companionPlatformDisplay }) => ([
    { tag: 'link_code_pairing_wrapped_companion_ephemeral_pub', attrs: {}, content: wrappedEphemeralPub },
    { tag: 'companion_server_auth_key_pub', attrs: {}, content: noiseKeyPublic },
    { tag: 'companion_platform_id', attrs: {}, content: companionPlatformId },
    { tag: 'companion_platform_display', attrs: {}, content: companionPlatformDisplay },
    { tag: 'link_code_pairing_nonce', attrs: {}, content: pairingNonceValue() }
]);

/**
 * Companion-hello runner: one round-trip that only resolves after the server
 * accepted the hello and returned a ref. IO is injected for testing.
 *
 * deps: controller, query(iq), generateMessageTag(), applyAttemptCreds(attempt),
 * newEphemeralKeyPair(), newPairingCode(), newAdvSecret(), wrapEphemeralPub(code, keyPair),
 * meJid(phone), noiseKeyPublic, companionPlatformId, companionPlatformDisplay, logger.
 */
export function makeCompanionHelloRunner(deps) {
    const logger = deps.logger || noopLogger;
    return async ({ phoneNumber, customPairingCode, shouldShowPushNotification = true }) => {
        if (customPairingCode && customPairingCode.length !== 8) {
            throw new Boom('Custom pairing code must be exactly 8 chars', { statusCode: 400 });
        }
        const normalizedPhoneNumber = normalizePairingPhoneNumber(phoneNumber);
        if (!normalizedPhoneNumber) {
            throw new Boom('A phone number is required for pairing', { statusCode: 400 });
        }
        const pairingCode = customPairingCode ?? deps.newPairingCode();
        const ephemeralKeyPair = deps.newEphemeralKeyPair();
        const advSecretKey = deps.newAdvSecret();
        const generation = deps.controller.begin({ phone: normalizedPhoneNumber, pairingCode, ephemeralKeyPair });
        const jid = deps.meJid(normalizedPhoneNumber);
        deps.applyAttemptCreds({ phoneNumber: normalizedPhoneNumber, jid, pairingCode, ephemeralKeyPair, advSecretKey });
        logger.info({ stage: PairingStage.Initialized, phone: maskPhoneNumber(normalizedPhoneNumber) }, 'pairing attempt started');
        const wrappedEphemeralPub = await deps.wrapEphemeralPub(pairingCode, ephemeralKeyPair);
        const iq = {
            tag: 'iq',
            attrs: { to: deps.serverJid || '@s.whatsapp.net', type: 'set', id: deps.generateMessageTag(), xmlns: 'md' },
            content: [
                {
                    tag: 'link_code_companion_reg',
                    attrs: { jid, stage: 'companion_hello', should_show_push_notification: shouldShowPushNotification ? 'true' : 'false' },
                    content: buildCompanionHelloContent({
                        wrappedEphemeralPub,
                        noiseKeyPublic: deps.noiseKeyPublic(),
                        companionPlatformId: deps.companionPlatformId(),
                        companionPlatformDisplay: deps.companionPlatformDisplay()
                    })
                }
            ]
        };
        let result;
        try {
            logger.info('pairing companion hello sent');
            result = await deps.query(iq);
        }
        catch (error) {
            deps.controller.reset();
            logger.warn({ stage: PairingStage.Initialized, statusCode: error?.output?.statusCode }, 'pairing companion hello failed');
            throw error;
        }
        let ref;
        try {
            ref = parseCompanionHelloResult(result);
        }
        catch (error) {
            deps.controller.reset();
            logger.warn({ stage: PairingStage.Initialized, statusCode: error?.output?.statusCode }, 'pairing companion hello rejected');
            throw error;
        }
        deps.controller.commitCompanionHello(ref, generation);
        logger.debug({ stage: PairingStage.AfterSendCompanionHello, hasRef: true, ref: refFingerprint(ref) }, 'pairing companion hello accepted');
        return pairingCode;
    };
}
