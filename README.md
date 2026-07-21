# baileys

A self-modified, prebuilt fork of [Baileys](https://github.com/WhiskeySockets/Baileys)
(based on `@whiskeysockets/baileys` `7.0.0-rc13`).

- **Ships prebuilt** — the compiled `lib/` (JS) and the generated `WAProto/`. There is
  **no build step**, so installing never compiles anything.
- **API** is compatible with upstream Baileys.
- The original upstream README is kept as [`README.upstream.md`](./README.upstream.md).

## Install

```bash
npm install github:vanSnowi/baileys
```

```ts
import makeWASocket from '@vansnowi/baileys'
// or: import { makeWASocket, useMultiFileAuthState, makeInMemoryStore } from '@vansnowi/baileys'
```

## Auth state

Two auth-state helpers are available:

```ts
import { useMultiFileAuthState, useSqliteAuthState } from '@vansnowi/baileys'

// multi-file (folder of JSON files)
const { state, saveCreds } = await useMultiFileAuthState('auth')

// single-file SQLite (crash-safe, WAL, atomic writes) — needs `better-sqlite3`
const { state, saveCreds } = await useSqliteAuthState('auth.db')
```

## In-memory store

A classic in-memory store keeps chats, contacts, messages, group metadata and
presences in sync by binding to the socket's event emitter:

```ts
import makeWASocket, { makeInMemoryStore } from '@vansnowi/baileys'

const store = makeInMemoryStore({})
const sock = makeWASocket({ /* ... */ })
store.bind(sock.ev)

// read back
store.loadMessage(jid, id)         // a single message
store.chats.all()                  // all chats
store.contacts                     // contact map

// persist / restore
store.writeToFile('./store.json')
store.readFromFile('./store.json')
```

## License

MIT — see [`LICENSE`](./LICENSE). Based on Baileys by the WhiskeySockets project.
