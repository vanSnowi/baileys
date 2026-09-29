import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { makeCommunitiesSocket } from './communities.js';
const makeWASocket = config => {
  const newConfig = {
    ...DEFAULT_CONNECTION_CONFIG,
    ...config
  };
  // Keep requireFullSync (client payload) consistent with the history-sync
  // consumer: if the caller opts into full history but keeps the default filter
  // (which drops FULL), don't silently discard the FULL chunks the server will
  // now send. An explicit custom shouldSyncHistoryMessage is always respected.
  if (newConfig.syncFullHistory &&
    newConfig.shouldSyncHistoryMessage === DEFAULT_CONNECTION_CONFIG.shouldSyncHistoryMessage) {
    newConfig.shouldSyncHistoryMessage = () => true;
  }
  return makeCommunitiesSocket(newConfig);
};
export default makeWASocket;
