# @vansnowi/baileys

Zup, this is some weird but useful Baileys fork.

## Features

- rc14 based
- SQL auth
- `participant` support
- `richMenu` (quick reply, open URL)
- secure code from logging via bots
- stability & messaging fixes

## The funcs (short)

**SQL auth** — `useSqliteAuthState(dir)` → stores creds/keys in SQLite via Node's built-in `node:sqlite`. No native build, runs the same on Termux / Linux / Windows / panels. Falls back to file auth on Node < 22.5.

**participant** — `relayMessage(jid, msg, { participant: { jid } })` → send only to the target's devices, skip your own (recipient-only, no "waiting" on your side).

**isSecret** — `{ isSecret: true }` → send only to the target's **main** (primary) device.

**protected** — `{ protected: true }` → send to everything **except** the target's **linked** (secondary) devices.

**participants** — `{ participants: { jid, count } }` → retry-resend to a single device.

**richMenu** — `sock.richMenu(jid, { header, body, footer, contextInfo })` → builds a GenAI rich-response menu: title/image header, buttons or a carousel of cards (quick replies), and a footer CTA (open URL).

**secure code from logging via bots** — `isSecret` / `protected` keep a message off linked/companion devices, so a "logger" bot running on a linked device never receives it (it only lands on the phone).

**stability & messaging fixes** — poll-vote decryption (LID + PN), `botInvoke` type fix, tc-token handling, WAProto made CommonJS-requireable, and `ignoreOfflineMessages` (skip history / placeholder / offline batch on reconnect).

## License

MIT — see [`LICENSE`](./LICENSE). Based on [Baileys](https://github.com/WhiskeySockets/Baileys) by the WhiskeySockets project.
