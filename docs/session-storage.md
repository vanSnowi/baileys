# SQLite Session-Speicherung (`useSqliteAuthState`)

Crash-sicherer, schneller Ersatz für `useMultiFileAuthState`. Speichert **alles** in
**einem** WAL-gesicherten `.db`-File mit atomaren, gebündelten Writes:

- `creds` (Identity/Noise-Keys)
- `session` (libsignal Sessions), `pre-key`, `sender-key`, `sender-key-memory`
- `app-state-sync-key`, `app-state-sync-version`
- `lid-mapping` (PN↔LID)
- `tctoken` (Trusted-Contact-Tokens)

## Warum

Der alte Multi-File-JSON-Store schreibt jeden Key mit einem **nicht-atomaren** `writeFile`.
Crasht der Prozess mitten im Schreiben einer Session-Datei, wird das kaputte JSON beim
nächsten Lesen als `null` interpretiert → **Key still verloren** → Entschlüsselung bricht →
Retries → Restriction-/Ban-Risiko. SQLite im WAL-Modus committet **atomar**: ein Key ist
entweder vollständig geschrieben oder gar nicht. Dazu: ein File statt Zehntausender kleiner
Dateien, binäre Buffer statt base64, ein `set()` mit vielen Keys = **eine** Transaktion.

## Setup

`better-sqlite3` ist eine reguläre Dependency und wird mit dem Paket **automatisch
installiert** (Prebuilt-Binaries für gängige Plattformen) — nichts extra nötig.

## Nutzung

Akzeptiert — wie `useMultiFileAuthState` — einen **Ordner** (die DB landet als
`<ordner>/auth.db`) **oder** einen expliziten `.db`-Pfad:

```js
import { makeWASocket, useSqliteAuthState } from '@vansnowi/tsm-baileys'

// Ordner-Stil (wie useMultiFileAuthState) -> ./auth/auth.db
const { state, saveCreds } = await useSqliteAuthState('./auth')

// oder expliziter File-Pfad:
// const { state, saveCreds } = await useSqliteAuthState('./auth/session.db')

const sock = makeWASocket({ auth: state /*, … */ })
sock.ev.on('creds.update', saveCreds)
```

Ein Pfad, der auf `.db` / `.sqlite` / `.sqlite3` endet, wird direkt als Datei genutzt;
alles andere gilt als Ordner. Der Dateiname im Ordner ist per `options.fileName`
überschreibbar (Default `auth.db`).

### Migration vom alten Ordner (einmalig, verlustfrei)

Zeigt auf deinen bestehenden `useMultiFileAuthState`-Ordner. Wird **nur** ausgeführt, wenn
die `.db` noch frisch ist (keine `creds`). Dadurch bleibt die Identität erhalten — **kein
Re-Pairing**, keine neue Session (was WA sonst als verdächtig werten könnte).

```js
const { state, saveCreds } = await useSqliteAuthState('./auth/session.db', {
  migrateFromFolder: './auth_legacy',   // alter Multi-File-Ordner
  logger,
})
```

Die Migration ist ein 1:1-Copy: der alte Dateiname-Stamm ist exakt der neue DB-Key
(gleiches `fixFileName`-Mangling), daher werden auch heikle IDs wie `sender-key`
(`group::user::device`) oder base64 `app-state-sync-key`-IDs verlustfrei übernommen.

## Optionen

| Option | Default | Bedeutung |
|---|---|---|
| `fileName` | `auth.db` | Dateiname, wenn ein Ordner statt eines `.db`-Pfads übergeben wird |
| `migrateFromFolder` | – | Alter Multi-File-Ordner, einmalig importiert (nur bei frischer db) |
| `logger` | – | Optionaler Logger (`warn`/`info`) |

## Rückgabe

`{ state: { creds, keys }, saveCreds, db, close }` — `state`/`saveCreds` wie bei
`useMultiFileAuthState`. `db` ist die rohe better-sqlite3-Instanz (für eigene Queries),
`close()` schließt sie sauber.

## Interna (für Reviewer — hier führt ein Bug zu Bans)

- **Schema:** `auth_state(k TEXT PRIMARY KEY, v BLOB) WITHOUT ROWID`. `k = fixFileName('{category}-{id}')`.
- **Codec:** Buffer-Werte → `0x01` + rohe Bytes; strukturierte Werte → `0x00` + BufferJSON-JSON.
  BufferJSON ist identisch zur Codebase, Buffer round-trippen exakt.
- **`app-state-sync-key`** wird bei `get` mit `proto.Message.AppStateSyncKeyData.fromObject`
  rehydriert — wie im alten Store.
- **Löschen:** `set({cat:{id:null}})` → `DELETE`. **Batch:** ein `set()` = eine Transaktion (atomar).
- **Pragmas:** `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`.
- **Defensive Reads:** eine einzelne unlesbare Row wird als „missing" behandelt (Key
  re-established), wirft nie aus `get()` — wie das Read-Error-Verhalten des alten Stores.
- **`clear()`** löscht Signal-Keys, behält `creds` (voller Reset = db-File löschen).

Getestet: Buffer-Exaktheit, `::`/`-` IDs, base64-IDs, Proto-Rehydration, Löschen,
Batch-Atomizität, Reopen-Persistenz, verlustfreie Migration (27 Unit- + 12 Integrationstests).
