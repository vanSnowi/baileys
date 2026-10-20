import { Boom } from '@hapi/boom';
import { randomBytes } from 'node:crypto';
import { proto } from '../../WAProto/compiler.js';
import { sha256 } from './crypto.js';

const assertOptionName = (value) => {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Boom('Media poll option names must be non-empty strings', { statusCode: 400 });
    }
};

export const getMediaPollOptionHash = (optionName, fileSha256) => {
    assertOptionName(optionName);
    if (!fileSha256 || Buffer.from(fileSha256).length === 0) {
        throw new Boom('Media poll option images need fileSha256', { statusCode: 400 });
    }
    const optionNameHash = sha256(Buffer.from(optionName, 'utf8')).toString('hex');
    const fileSha256Base64 = Buffer.from(fileSha256).toString('base64');
    return sha256(Buffer.from(optionNameHash + fileSha256Base64, 'utf8')).toString('hex');
};

export const buildMediaPollMessages = ({
    name,
    options,
    parentMessageKey,
    selectableOptionsCount = 1,
    messageSecret = randomBytes(32)
}) => {
    if (typeof name !== 'string' || name.length === 0) {
        throw new Boom('Media poll name must be a non-empty string', { statusCode: 400 });
    }
    if (!Array.isArray(options) || options.length === 0) {
        throw new Boom('Media poll options must be a non-empty array', { statusCode: 400 });
    }
    if (!parentMessageKey?.remoteJid || !parentMessageKey?.id) {
        throw new Boom('Media poll parent key needs remoteJid and id', { statusCode: 400 });
    }
    if (!Number.isInteger(selectableOptionsCount) ||
        selectableOptionsCount < 0 ||
        selectableOptionsCount > options.length) {
        throw new Boom('Media poll selectableOptionsCount is invalid', { statusCode: 400 });
    }

    const pollOptions = [];
    const optionImageMessages = [];
    for (const option of options) {
        assertOptionName(option?.name);
        if (!option?.imageMessage) {
            throw new Boom('Every media poll option needs an uploaded imageMessage', { statusCode: 400 });
        }
        const imageMessage = proto.Message.ImageMessage.fromObject({
            ...option.imageMessage,
            caption: option.name
        });
        pollOptions.push({
            optionName: option.name,
            optionHash: getMediaPollOptionHash(option.name, imageMessage.fileSha256)
        });
        optionImageMessages.push(proto.Message.create({
            pollCreationOptionImageMessage: {
                message: {
                    imageMessage
                }
            },
            messageContextInfo: {
                messageAssociation: {
                    associationType: proto.MessageAssociation.AssociationType.MEDIA_POLL,
                    parentMessageKey
                }
            }
        }));
    }

    return {
        pollMessage: proto.Message.create({
            pollCreationMessageV3: {
                name,
                options: pollOptions,
                selectableOptionsCount,
                pollContentType: proto.Message.PollContentType.IMAGE
            },
            messageContextInfo: {
                messageSecret
            }
        }),
        optionImageMessages
    };
};

export const buildMediaPollRefreshMessage = ({
    pollMessage,
    parentMessageKey,
    timestampMs = Date.now()
}) => {
    if (!pollMessage?.pollCreationMessageV3) {
        throw new Boom('Media poll refresh needs a V3 poll message', { statusCode: 400 });
    }
    if (!parentMessageKey?.remoteJid || !parentMessageKey?.id) {
        throw new Boom('Media poll refresh needs the parent key', { statusCode: 400 });
    }
    return proto.Message.create({
        protocolMessage: {
            key: parentMessageKey,
            type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
            timestampMs,
            editedMessage: pollMessage
        }
    });
};
