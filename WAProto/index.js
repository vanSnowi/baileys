import { fileURLToPath } from 'url';
import { makeProto } from './proto-shim.js';
const tablePath = fileURLToPath(new URL('./wa-table.json', import.meta.url));
const built = makeProto(tablePath);
export const proto = built.proto;
export const codec = built.codec;
export default {
  proto,
  codec
};
