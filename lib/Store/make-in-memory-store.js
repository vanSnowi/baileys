import { existsSync, readFileSync, writeFileSync } from 'fs';
import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { toNumber, updateMessageWithPollUpdate, updateMessageWithReaction, updateMessageWithReceipt } from '../Utils/index.js';
import { jidNormalizedUser } from '../WABinary/index.js';
import KeyedDB from './keyed-db.js';
import makeOrderedDictionary from './make-ordered-dictionary.js';
import { ObjectRepository } from './object-repository.js';
const waChatKey = pin => (c1, c2) => {
  const pinnedDiff = pin ? Number(!!c2.pinned) - Number(!!c1.pinned) : 0;
  if (pinnedDiff) return pinnedDiff;
  const t1 = toNumber(c1.conversationTimestamp) || 0;
  const t2 = toNumber(c2.conversationTimestamp) || 0;
  if (t1 !== t2) return t2 - t1;
  return (c1.id || '').localeCompare(c2.id || '');
};
const waMessageID = m => m.key?.id || '';
const waLabelAssociationKey = (a1, a2) => (a1.type || '').localeCompare(a2.type || '') || (a1.chatId || '').localeCompare(a2.chatId || '') || (a1.labelId || '').localeCompare(a2.labelId || '');
const labelAssociationId = a => (a.type || '') + ':' + (a.chatId || a.messageId || '') + ':' + (a.labelId || '');
const makeMessagesDictionary = () => makeOrderedDictionary(waMessageID);
export const makeInMemoryStore = (config = {}) => {
  const socket = config.socket;
  const chatKeyCompare = config.chatKey || waChatKey(true);
  const labelAssociationKeyCompare = config.labelAssociationKey || waLabelAssociationKey;
  const logger = config.logger || DEFAULT_CONNECTION_CONFIG.logger?.child?.({
    stream: 'in-mem-store'
  });
  const chats = new KeyedDB(chatKeyCompare, c => c.id);
  const messages = {};
  const contacts = {};
  const groupMetadata = {};
  const presences = {};
  const state = {
    connection: 'close'
  };
  const labels = new ObjectRepository();
  const labelAssociations = new KeyedDB(labelAssociationKeyCompare, labelAssociationId);
  const assertMessageList = jid => {
    if (!messages[jid]) {
      messages[jid] = makeMessagesDictionary();
    }
    return messages[jid];
  };
  const contactsUpsert = newContacts => {
    const oldContacts = new Set(Object.keys(contacts));
    for (const contact of newContacts) {
      oldContacts.delete(contact.id);
      contacts[contact.id] = Object.assign(contacts[contact.id] || {}, contact);
    }
    return oldContacts;
  };
  const labelsUpsert = newLabels => {
    for (const label of newLabels) {
      labels.upsertById(label.id, label);
    }
  };
  const bind = ev => {
    ev.on('connection.update', update => {
      Object.assign(state, update);
    });
    ev.on('messaging-history.set', ({
      chats: newChats,
      contacts: newContacts,
      messages: newMessages,
      isLatest,
      syncType
    }) => {
      if (isLatest) {
        chats.clear();
        for (const id of Object.keys(messages)) {
          delete messages[id];
        }
      }
      const chatsAdded = chats.insertIfAbsent(...newChats).length;
      logger?.debug?.({
        chatsAdded
      }, 'synced chats');
      const oldContacts = contactsUpsert(newContacts);
      logger?.debug?.({
        deletedContacts: oldContacts.size,
        newContacts
      }, 'synced contacts');
      for (const msg of newMessages) {
        const jid = jidNormalizedUser(msg.key.remoteJid);
        const list = assertMessageList(jid);
        list.upsert(msg, 'prepend');
      }
      logger?.debug?.({
        messages: newMessages.length
      }, 'synced messages');
    });
    ev.on('contacts.upsert', newContacts => {
      contactsUpsert(newContacts);
    });
    ev.on('contacts.update', updates => {
      for (const update of updates) {
        let contact;
        if (update.id && (contact = contacts[update.id])) {
          Object.assign(contact, update);
        } else {
          logger?.debug?.({
            update
          }, 'got update for non-existant contact');
        }
      }
    });
    ev.on('chats.upsert', newChats => {
      chats.upsert(...newChats);
    });
    ev.on('chats.update', updates => {
      for (let update of updates) {
        const existing = chats.get(update.id);
        if (existing) {
          chats.upsert(Object.assign(existing, update));
        } else {
          logger?.debug?.({
            update
          }, 'got update for non-existant chat');
        }
      }
    });
    ev.on('labels.edit', label => {
      if (label.deleted) {
        labels.deleteById(label.id);
        return;
      }
      labels.upsertById(label.id, label);
    });
    ev.on('labels.association', ({
      type,
      association
    }) => {
      switch (type) {
        case 'add':
          labelAssociations.upsert(association);
          break;
        case 'remove':
          labelAssociations.deleteById(labelAssociationId(association));
          break;
        default:
          logger?.error?.(`unknown operation type ${type}`);
      }
    });
    ev.on('presence.update', ({
      id,
      presences: update
    }) => {
      presences[id] = presences[id] || {};
      Object.assign(presences[id], update);
    });
    ev.on('chats.delete', deletions => {
      for (const item of deletions) {
        if (chats.get(item)) {
          chats.deleteById(item);
        }
      }
    });
    ev.on('messages.upsert', ({
      messages: newMessages,
      type
    }) => {
      switch (type) {
        case 'append':
        case 'notify':
          for (const msg of newMessages) {
            const jid = jidNormalizedUser(msg.key.remoteJid);
            const list = assertMessageList(jid);
            list.upsert(msg, 'append');
            if (type === 'notify') {
              if (!chats.get(jid)) {
                ev.emit('chats.upsert', [{
                  id: jid,
                  conversationTimestamp: toNumber(msg.messageTimestamp),
                  unreadCount: 1
                }]);
              }
            }
          }
          break;
      }
    });
    ev.on('messages.update', updates => {
      for (const {
        update,
        key
      } of updates) {
        const list = assertMessageList(jidNormalizedUser(key.remoteJid));
        if (update?.status) {
          const listStatus = list.get(key.id)?.status;
          if (listStatus && update.status <= listStatus) {
            logger?.debug?.({
              update,
              storedStatus: listStatus
            }, 'status stored newer then update');
            delete update.status;
          }
        }
        const result = list.updateAssign(key.id, update);
        if (!result) {
          logger?.debug?.({
            update
          }, 'got update for non-existent message');
        }
      }
    });
    ev.on('messages.delete', item => {
      if ('all' in item) {
        const list = messages[item.jid];
        list?.clear();
      } else {
        const jid = item.keys[0].remoteJid;
        const list = messages[jidNormalizedUser(jid)];
        if (list) {
          const idSet = new Set(item.keys.map(k => k.id));
          list.filter(m => !idSet.has(m.key.id));
        }
      }
    });
    ev.on('messages.reaction', reactions => {
      for (const {
        key,
        reaction
      } of reactions) {
        const obj = messages[jidNormalizedUser(key.remoteJid)];
        const msg = obj?.get(key.id);
        if (msg) {
          updateMessageWithReaction(msg, reaction);
        }
      }
    });
    ev.on('message-receipt.update', updates => {
      for (const {
        key,
        receipt
      } of updates) {
        const obj = messages[jidNormalizedUser(key.remoteJid)];
        const msg = obj?.get(key.id);
        if (msg) {
          updateMessageWithReceipt(msg, receipt);
        }
      }
    });
    ev.on('groups.update', updates => {
      for (const update of updates) {
        const id = update.id;
        if (groupMetadata[id]) {
          Object.assign(groupMetadata[id], update);
        } else {
          logger?.debug?.({
            update
          }, 'got update for non-existant group metadata');
        }
      }
    });
    ev.on('group-participants.update', ({
      id,
      participants,
      action
    }) => {
      const metadata = groupMetadata[id];
      if (metadata) {
        switch (action) {
          case 'add':
            metadata.participants.push(...participants.map(p => ({
              id: p,
              isAdmin: false,
              isSuperAdmin: false
            })));
            break;
          case 'demote':
          case 'promote':
            for (const participant of metadata.participants) {
              if (participants.includes(participant.id)) {
                participant.isAdmin = action === 'promote';
              }
            }
            break;
          case 'remove':
            metadata.participants = metadata.participants.filter(p => !participants.includes(p.id));
            break;
        }
      }
    });
    ev.on('groups.upsert', newGroups => {
      for (const group of newGroups) {
        groupMetadata[group.id] = group;
      }
    });
  };
  const toJSON = () => ({
    chats,
    contacts,
    messages,
    labels,
    labelAssociations
  });
  const fromJSON = json => {
    chats.upsert(...json.chats);
    labelAssociations.upsert(...(json.labelAssociations || []));
    contactsUpsert(Object.values(json.contacts));
    labelsUpsert(Object.values(json.labels || {}));
    for (const jid in json.messages) {
      const list = assertMessageList(jid);
      for (const msg of json.messages[jid]) {
        list.upsert(msg, 'append');
      }
    }
  };
  const writeToFile = path => {
    const data = JSON.stringify(toJSON(), BufferJSON_replacer);
    writeFileSync(path, data);
  };
  const readFromFile = path => {
    if (existsSync(path)) {
      logger?.debug?.({
        path
      }, 'reading from file');
      const jsonStr = readFileSync(path, {
        encoding: 'utf-8'
      });
      const json = JSON.parse(jsonStr, BufferJSON_reviver);
      fromJSON(json);
    }
  };
  return {
    chats,
    contacts,
    messages,
    groupMetadata,
    state,
    presences,
    labels,
    labelAssociations,
    bind,
    loadMessages: async (jid, count, cursor) => {
      const list = assertMessageList(jidNormalizedUser(jid));
      const mode = !cursor || 'before' in cursor ? 'before' : 'after';
      const cursorKey = cursor ? 'before' in cursor ? cursor.before : cursor.after : undefined;
      const cursorValue = cursorKey ? list.get(cursorKey.id) : undefined;
      let messagesList;
      if (list && mode === 'before' && (!cursorKey || cursorValue)) {
        if (cursorValue) {
          const msgIdx = list.array.findIndex(m => m.key.id === cursorKey?.id);
          messagesList = list.array.slice(0, msgIdx);
        } else {
          messagesList = list.array;
        }
        return messagesList.slice(-count);
      }
      return [];
    },
    loadMessage: async (jid, id) => messages[jidNormalizedUser(jid)]?.get(id),
    getMessage: (jid, id) => messages[jidNormalizedUser(jid)]?.get(id),
    mostRecentMessage: async jid => {
      const message = messages[jidNormalizedUser(jid)]?.array.slice(-1)[0];
      return message;
    },
    fetchImageUrl: async (jid, sock) => {
      const s = sock || socket;
      const contact = contacts[jid];
      if (!contact) {
        return s?.profilePictureUrl(jid);
      }
      if (typeof contact.imgUrl === 'undefined') {
        contact.imgUrl = await s?.profilePictureUrl(jid);
      }
      return contact.imgUrl;
    },
    fetchGroupMetadata: async (jid, sock) => {
      const s = sock || socket;
      if (!groupMetadata[jid]) {
        const metadata = await s?.groupMetadata(jid);
        if (metadata) {
          groupMetadata[jid] = metadata;
        }
      }
      return groupMetadata[jid];
    },
    fetchMessageReceipts: async ({
      remoteJid,
      id
    }, sock) => {
      const s = sock || socket;
      const list = messages[jidNormalizedUser(remoteJid)];
      const msg = list?.get(id);
      return msg?.userReceipt;
    },
    toJSON,
    fromJSON,
    writeToFile,
    readFromFile
  };
};
function BufferJSON_replacer(_key, value) {
  if (value?.type === 'Buffer' && Array.isArray(value?.data)) {
    return value;
  }
  if (value instanceof Uint8Array || typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return {
      type: 'Buffer',
      data: Buffer.from(value).toString('base64'),
      __enc: 'base64'
    };
  }
  return value;
}
function BufferJSON_reviver(_key, value) {
  if (value?.type === 'Buffer') {
    if (value.__enc === 'base64' && typeof value.data === 'string') {
      return Buffer.from(value.data, 'base64');
    }
    if (Array.isArray(value.data)) {
      return Buffer.from(value.data);
    }
  }
  return value;
}
export default makeInMemoryStore;
