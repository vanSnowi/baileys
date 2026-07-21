// Slim protobuf runtime: table-driven codec + protobufjs-compatible `proto` shim.
// Old protobufjs static module lives in the git history / backup zip.
import { fileURLToPath } from 'url';
import { makeProto } from './proto-shim.js';
const tablePath = fileURLToPath(new URL('./wa-table.json', import.meta.url));
const built = makeProto(tablePath);
export const proto = built.proto;
export const codec = built.codec; // { encode(name,obj), decode(name,buf) }
export default { proto, codec };
