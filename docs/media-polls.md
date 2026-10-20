# Polls with option images

WhatsApp Android 2.26.35.8 sends a media poll as one parent poll and one separately uploaded image
message per option. Each option image points at the parent key through a `MEDIA_POLL` message
association. The helper uploads every image first, sends the parent before its children, then sends
a same-content poll edit after the children. The final edit asks the client to rebuild the open-chat
poll view after every associated image is available.

Use the socket helper so media upload, association, hashing, order, stanza metadata and own-event
emission stay together:

```js
const result = await sock.sendPollWithImages(from, {
    name: 'Which image do you prefer?',
    selectableCount: 1,
    options: [
        {
            name: 'First image',
            image: { url: './first-image.jpg' }
        },
        {
            name: 'Second image',
            image: { url: './second-image.jpg' }
        }
    ]
})
```

Each `image` accepts the same source forms as an ordinary Baileys image message. The return value
contains `pollMessage`, `optionImageMessages` and the final `refreshMessage`.

## Wire construction

The parent is `pollCreationMessageV3` with `pollContentType = IMAGE`, a 32-byte
`messageContextInfo.messageSecret`, and an `optionHash` on every option. The hash is:

```text
SHA-256-hex(SHA-256-hex(option name UTF-8) + base64(image fileSha256))
```

Every child has this shape after media upload:

```js
{
    pollCreationOptionImageMessage: {
        message: {
            imageMessage: {
                caption: 'Exact option name'
            }
        }
    },
    messageContextInfo: {
        messageAssociation: {
            associationType: proto.MessageAssociation.AssociationType.MEDIA_POLL,
            parentMessageKey
        }
    }
}
```

The image caption must equal the option name. `messageIndex` is intentionally absent: the Android
2.26.35.8 association serializer has no type-specific index provider for `MEDIA_POLL`; the client
matches the child through the option name, image upload hash and the parent's `optionHash`.

The helper rejects newsletters and status broadcasts. Rendering still depends on the recipient
account and client feature rollout and therefore requires a live device test.
