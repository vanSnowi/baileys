import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { makeCommunitiesSocket } from './communities.js';
// export the last socket layer (communities wraps groups/chats/messages;
// connection behaviour is unchanged)
const makeWASocket = (config) => {
    const newConfig = {
        ...DEFAULT_CONNECTION_CONFIG,
        ...config
    };
    return makeCommunitiesSocket(newConfig);
};
export default makeWASocket;
