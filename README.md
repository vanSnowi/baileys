# @vansnowi/baileys

Zup, this is some weird but useful Baileys fork.

## Features

- rc14 based
- SQL auth
- `participant` support
- `richMenu` (quick reply, open URL)
- secure code from logging via bots
- stability & messaging fixes
- reduced the proto from >5mb to <1mb

## Examples

**participant** — send only to the target's devices, skip your own (recipient-only, no "waiting" on your side):

```js
const message = { conversation: 'hey' }
await sock.relayMessage(jid, message, { participant: { jid } })
```

**isSecret** — send only to the target's main (primary) device:

```js
await sock.relayMessage(jid, message, { isSecret: true })
```

**protected** — send to everything except the target's linked (secondary) devices:

```js
await sock.relayMessage(jid, message, { protected: true })
```

**richMenu** — quick-reply buttons (or a carousel of cards) with an image header and an open-URL footer:

```js
await sock.richMenu(jid, {
  header: {
    title: 'Main Menu',
    image: { url: 'https://example.com/banner.png', inline: false }
  },
  body: {
    title: 'Pick one',
    buttons: ['Profile', 'Settings', 'Help'],
    toast: 'opening...'
  },
  footer: {
    text: 'Join us',
    url: 't.me/example'
  }
})

// carousel of cards instead of buttons
await sock.richMenu(jid, {
  body: {
    carousel: true,
    cards: [
      { title: 'Card 1', buttons: ['A', 'B'], toast: '...' },
      { title: 'Card 2', buttons: ['C', 'D'], toast: '...' }
    ]
  }
})
```

## License

MIT — see [`LICENSE`](./LICENSE). Based on [Baileys](https://github.com/WhiskeySockets/Baileys) by the WhiskeySockets project.
