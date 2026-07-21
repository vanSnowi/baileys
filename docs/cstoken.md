# cstoken — Anti-Spam-Fallback-Token (kompletter Ablauf)

Der `cstoken` („nct token") ist ein **lokal berechneter** Fallback-Token, den WhatsApp Web an
**1:1-Nachrichten an kalte Kontakte** anhängt — also genau dann, wenn **kein** `tctoken`
(Trusted-Contact-Token) vorliegt. Er ist Metas Anti-Spam-Signal für Erstkontakte und wurde
1:1 aus dem WhatsApp-Web-Quellcode rekonstruiert (`WAWebSendMsgCreateFanoutStanza`,
`WACryptoHmac`, `WAWebNctSalt`, `NctSaltSyncAction`).

> **Status im Fork:** implementiert und **standardmäßig AN** (greift transparent auch über
> `sendMessage`). Gezielt abschaltbar per `relayMessage(jid, msg, { cstoken: false })`.
> Hängt nur dann wirklich einen Node an, wenn das Gating erfüllt ist (kalter 1:1 + LID + Salt).

---

## 1. Was ist der cstoken?

- Ein **deterministischer HMAC** über die LID des Empfängers, mit einem **kontoweiten Salt**
  als Schlüssel.
- Zweck: Der Server kann bei einem Erstkontakt (kein tctoken) trotzdem einen Token sehen, der
  beweist, dass der Sender ein legitimer Client mit gültigem Salt ist. Fehlt **jeder** Token,
  ist die Nachricht ein klassisches Cold-Spam-Signal.
- **tctoken vs cstoken:**
  - `tctoken` = server-ausgestellter Beziehungs-Token (existiert nur bei bestehender Beziehung).
  - `cstoken` = client-berechneter Fallback, wenn kein tctoken da ist.
  - Es wird **immer nur einer** angehängt: tctoken hat Vorrang; cstoken nur, wenn tctoken fehlt.

---

## 2. Die Formel (verifiziert aus WA Web)

```
cstoken = HMAC-SHA256( key = nctSalt , data = utf8("<user>@lid") )      // 32 Bytes, ungekürzt
```

- **key** = `nctSalt` (rohe Bytes, kontoweit, kommt via App-State — siehe §3)
- **data** = UTF-8 des **device-losen** LID-Strings des Empfängers, Format `"<user>@lid"`
  (in baileys: `jidNormalizedUser(recipientLid)` bzw. `resolveTcTokenJid(...)`)
- **Ausgabe** = 32-Byte-Digest, roh als Node-Content

### Quelle in WA Web (`WAWebSendMsgCreateFanoutStanza`)
```js
if (ABProp("wa_nct_token_send_enabled") !== true || !recipient.isRegularUser()) return null
const nctSalt = IndexedDB.get("WAWebNctSalt")            // null -> "[nct-cstoken] no salt available"
const recipientLid = recipient.accountLid                // null -> "[nct-cstoken] recipientLid is null"
const s = HMAC_SHA256(decodeB64(nctSalt), utf8(recipientLid.toString()))   // toString() = "<user>@lid"
return wap("cstoken", null, s)                           // <cstoken>{32 bytes}</cstoken>
```
`WACryptoHmac.hmacSha256(key, data)` → `importKey(HMAC-SHA256, key).sign(data)`, keine Kürzung.

---

## 3. Woher kommt der Salt? (`nctSalt`)

Der Salt ist **kontoweit** (ein Salt für alle Empfänger) und wird vom Server über den
**App-State-Sync** verteilt:

```
Server  ──(app-state patch)──►  SyncActionValue { nctSaltSyncAction: { salt: <bytes> } }
                                          │  (proto: NctSaltSyncAction.salt = 1,
                                          │          action index NCT_SALT_SYNC_ACTION = 80)
                                          ▼
Fork: chats.js  onMutation(mutation)
      → mutation.syncAction.value.nctSaltSyncAction.salt
      → authState.keys.set({ 'nct-salt': { default: Buffer } })      // Keystore
```

WA Web speichert denselben Salt in IndexedDB unter `WAWebNctSalt`. Im Fork liegt er im
Keystore unter Kategorie `nct-salt`, Key `default`.

> ⏳ **Wichtig:** Der Salt ist erst **nach einem App-State-Sync** vorhanden. Direkt nach dem
> ersten Connect/Pairing kann er noch fehlen — dann wird (bei `cstoken:true`) **kein** Node
> angehängt und geloggt: `cstoken requested but no nct salt stored yet`.

---

## 4. Anhängen beim Senden (`messages-send.js`, `relayMessage`)

Ablauf pro ausgehender Nachricht:

```
relayMessage(jid, msg, { cstoken })
        │
        ▼
Ist cstoken === true ?  ── nein ─►  nichts tun
        │ ja
        ▼
Ist es ein 1:1-Send (kein Gruppe/Status/Newsletter/Peer/Retry) ?  ── nein ─►  nichts tun
        │ ja
        ▼
Liegt bereits ein tctoken an (tcTokenBuffer) ?  ── ja ─►  nichts tun (tctoken hat Vorrang)
        │ nein (kalter Kontakt)
        ▼
Empfänger zu LID auflösen (resolveTcTokenJid)   ── kein LID ─►  log "recipient has no LID"
        │ hat LID
        ▼
nctSalt aus Keystore lesen ('nct-salt'/default)  ── fehlt ─►  log "no nct salt stored yet"
        │ vorhanden
        ▼
cs = HMAC-SHA256(nctSalt, utf8(lid))
stanza.content.push({ tag:'cstoken', attrs:{}, content: cs })
log "attached cstoken (nct fallback)"
```

Der Node landet in derselben Message-Stanza wie ein tctoken es täte:
```xml
<message ...>
  ...
  <cstoken>…32 Bytes…</cstoken>
</message>
```

### Gating-Bedingungen (alle müssen erfüllt sein)
| Bedingung | Quelle |
|---|---|
| `cstoken` nicht auf `false` gesetzt | Default `true` (an) |
| 1:1-Send (kein Gruppe/Status/Newsletter/Peer/Retry) | `is1on1Send` |
| **kein** tctoken vorhanden | `!tcTokenBuffer?.length` |
| Empfänger als LID auflösbar | `isLidUser(resolveTcTokenJid(...))` |
| nctSalt im Keystore | `authState.keys.get('nct-salt', ['default'])` |

---

## 5. Nutzung

```js
import { makeWASocket } from '@vansnowi/tsm-baileys'
const sock = makeWASocket({ /* … */ })

// AN (Default): cstoken wird bei kaltem Kontakt automatisch angehängt
await sock.relayMessage(jid, message, { messageId })
await sock.sendMessage(jid, content)          // greift auch hier transparent

// gezielt AUS für einen einzelnen Send
await sock.relayMessage(jid, message, { messageId, cstoken: false })
```

`cstoken` ist ein reiner „darf-angehängt-werden"-Schalter (Default `true`) — ob der Node **tatsächlich**
rausgeht, entscheidet das Gating aus §4 (kalt + LID + Salt).

---

## 6. Testen (sicher, mit Wegwerf-Nummer)

1. Mit einer **Test-Nummer** verbinden, Logger auf `debug`.
2. Kurz warten, bis ein **App-State-Sync** durch ist (sonst kein Salt).
3. Einen **kalten Kontakt** (der dir nie geschrieben hat) anschreiben (cstoken ist per Default an).
4. Log prüfen:
   - ✅ `attached cstoken (nct fallback)` → Node ging raus.
   - ⚠️ `cstoken requested but no nct salt stored yet` → Salt fehlt noch.
   - ⚠️ `cstoken requested but recipient has no LID` → kein LID auflösbar.
5. **Server-ACK**: kommt **kein** `463` / keine Restriction → Token akzeptiert (LID-Format
   passt). Kommt `463` → **sofort aus** und LID-Format nachjustieren.

> Der Server ist der **einzige** echte Validator des exakten LID-Strings. Deshalb ist der
> Flag da: erst Test-Nummer + ACK beobachten, dann Hauptnummer.

---

## 7. Fehlerbild / Troubleshooting

| Symptom | Ursache | Fix |
|---|---|---|
| kein `attached cstoken`-Log, nur normaler Send | tctoken vorhanden (warmer Kontakt) | erwartetes Verhalten — cstoken nur bei kalten |
| `no nct salt stored yet` | App-State-Sync noch nicht durch | warten / reconnecten |
| `recipient has no LID` | Empfänger-PN nicht zu LID gemappt | LID-Mapping muss erst befüllt sein |
| `463` nach dem Send | LID-String matcht server-seitig nicht | Flag aus, LID-Format prüfen (device-los `<user>@lid`) |

---

## 8. Code-Referenzen (Fork)

| Baustein | Datei |
|---|---|
| Salt-Capture aus App-State | `lib/Socket/chats.js` (`onMutation`) |
| cstoken-Option + HMAC + Anhang | `lib/Socket/messages-send.js` (`relayMessage`) |
| Proto `NctSaltSyncAction.salt` | `WAProto/WAProto.proto` |
| WA-Web-Verifikation / Gap-Analyse | `extracts/WA-WEB-ANALYSE.md` |

## 9. Abgrenzung (nicht verwechseln)

- **tctoken** — server-ausgestellter Beziehungs-Token (Fork implementiert vollständig).
- **ACSToken** (`WAACSTokenUtils`) — Privacy-Pass-Blind-Tokens für Status-Musik/Channels-
  Crediting, **kein** Anti-Spam. Unabhängig vom cstoken.
- **counter_abuse_token** — mobiles Server-ACK-Metadatum, kein Web-Sender-Konstrukt.
