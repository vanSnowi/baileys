import { readFileSync } from 'fs';
import { makeCodec } from './codec.js';
import Long from 'long';
const KIND = [{
  k: 'varint',
  s: 'int'
}, {
  k: 'varint',
  s: 'zigzag'
}, {
  k: 'varint',
  s: 'bool'
}, {
  k: 'i64',
  s: 'long'
}, {
  k: 'i64',
  s: 'double'
}, {
  k: 'i32',
  s: 'int'
}, {
  k: 'i32',
  s: 'float'
}, {
  k: 'string'
}, {
  k: 'bytes'
}, {
  k: 'varint',
  s: 'enum'
}, {
  k: 'varint',
  s: 'long'
}, {
  k: 'varint',
  s: 'zigzaglong'
}];
export function makeProto(tablePath) {
  const {
    m,
    t,
    e
  } = JSON.parse(readFileSync(tablePath, 'utf8'));
  const TABLE = {};
  for (const [full, fields] of Object.entries(t)) {
    const order = fields.map(([name, id, tc, flags = 0, enumName]) => {
      const base = tc >= 100 ? {
        k: 'msg',
        msg: m[tc - 100]
      } : KIND[tc];
      const f = {
        name,
        id,
        ...base,
        rep: !!(flags & 1),
        packed: !!(flags & 2)
      };
      if (tc === 9 && enumName && e[enumName]) f.enumMap = e[enumName];
      return f;
    });
    const byId = {};
    for (const f of order) byId[f.id] = f;
    TABLE[full] = {
      order,
      byId
    };
  }
  const codec = makeCodec(TABLE, {
    Long,
    bytesJSON: true
  });
  const proto = {};
  const nodeFor = path => {
    let c = proto;
    for (const p of path) c = c[p] || (c[p] = {});
    return c;
  };
  for (const full of Object.keys(t)) {
    const node = nodeFor(full.replace(/^proto\./, '').split('.'));
    node.encode = o => ({
      finish: () => codec.encode(full, o || {})
    });
    node.decode = b => codec.decode(full, b);
    node.create = o => o || {};
    node.fromObject = o => o || {};
    node.toObject = o => o || {};
    node.verify = () => null;
    node.name = full.split('.').pop();
  }
  for (const [full, values] of Object.entries(e)) {
    const node = nodeFor(full.replace(/^proto\./, '').split('.'));
    for (const [k, v] of Object.entries(values)) {
      node[k] = v;
      node[v] = k;
    }
  }
  return {
    proto,
    codec
  };
}
