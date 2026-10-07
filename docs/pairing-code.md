# Pairing-code (phone-number) linking

`requestPairingCode(phoneNumber, customPairingCode?)` now mirrors current
WhatsApp Web's alt-device-linking flow.

## What changed

- **`companion_hello` is a real request/response.** It is sent with `query()` and
  resolves only after the server accepts it and returns a `link_code_pairing_ref`.
  A returned code therefore always has a confirmed server ref.
- **Rejections surface.** If the server replies with an IQ error
  (`bad-request`, `feature-not-available`, `rate-overlimit`, `forbidden`, …) or an
  invalid/empty ref, `requestPairingCode()` rejects and returns no code.
- **Nonce** is the single byte `0x00` (was ASCII `"0"` / `0x30`).
- **A fresh Curve25519 ephemeral key** is generated per attempt; a new request
  supersedes an unfinished one (generation guard + mutex serialization).
- **Pairing state machine**: `NotStarted → Initialized → AfterSendCompanionHello
  → AfterSendCompanionFinish → Paired`, with `phone`, `ref`, `codeGenerationTs`,
  `primaryHelloAttemptCount`. Shared between the socket and the receive layer.
- **`primary_hello`**: the incoming ref must equal the cached ref, and the code
  must be ≤ 180 s old, or it is rejected before any `companion_finish` crypto.
  The notification is ACKed immediately; the `companion_finish` crypto/round-trip
  runs asynchronously (matches WhatsApp Web). Up to 3 repeated `primary_hello`
  attempts are handled (each re-initialising the ADV secret); the 4th is rejected.
- **`companion_finish`** uses the server-cached, validated ref — never the ref
  echoed from the notification.
- **`refresh_code`** is routed separately from `primary_hello` (no primary-hello
  crypto): the ref is validated, the notification is ACKed, and on a match a new
  code is generated (new key, new `companion_hello`, new ref) and delivered to the
  consumer. `force_manual_refresh="true"` is distinguished.
- **`companion_reg_refresh`** regenerates the ADV secret and ACKs.
- **`registered` becomes `true` only on a real `pair-success`**, not after
  `companion_finish`. ADV/account signature verification is unchanged.

## Consuming a server-initiated refresh

Server refreshes are additive events (the returned-value API is unchanged):

```js
sock.ev.on('pairing-code.update', ({ code, phoneNumber, reason }) => {
  // reason: 'server_refresh' | 'force_manual_refresh'
})
// also emitted on connection.update as { pairingCode }
```

## Caveats

- This does not make WhatsApp always allow pairing: server-side feature gates and
  rate limits still apply, and now surface as a rejection instead of a code that
  later fails on the phone.
- A code is valid ~180 s for `primary_hello` processing.
- `examples/pairing-code-debug.js` is a manual harness (reads `WA_PHONE_NUMBER`,
  prints only the user-facing code and stage logs). It is not run by the tests.
