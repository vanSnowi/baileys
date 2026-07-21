import protobuf from 'protobufjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';
const protoPath = process.argv[2] || './WAProto.proto';
const modPath = process.argv[3] || './mod.json';
const outPath = process.argv[4] || './wa-table.json';
const root = await protobuf.load(protoPath);
if (existsSync(modPath)) {
  const mod = JSON.parse(readFileSync(modPath, 'utf8'));
  for (const [parent, types] of Object.entries(mod.types || {})) {
    const P = root.lookupType(parent);
    for (const [name, def] of Object.entries(types)) {
      if (P.get(name)) continue;
      P.add(protobuf.Type.fromJSON(name, def));
    }
  }
  for (const [typeName, fields] of Object.entries(mod.fields || {})) {
    const T = root.lookupType(typeName);
    for (const [fname, f] of Object.entries(fields)) {
      if (T.get(fname)) continue;
      const clash = T.fieldsArray.find(x => x.id === f.id);
      if (clash) {
        continue;
      }
      T.add(new protobuf.Field(fname, f.id, f.type, f.rule));
    }
  }
}
root.resolveAll();
const SCALAR = {
  int32: 0,
  uint32: 0,
  sint32: 1,
  bool: 2,
  fixed64: 3,
  sfixed64: 3,
  double: 4,
  fixed32: 5,
  sfixed32: 5,
  float: 6,
  string: 7,
  bytes: 8,
  int64: 10,
  uint64: 10,
  sint64: 11
};
const msgNames = [];
const idx = n => {
  let i = msgNames.indexOf(n);
  return i < 0 ? msgNames.push(n) - 1 : i;
};
const t = {},
  enums = {};
let mapSkipped = 0;
(function build(ns) {
  for (const o of Object.values(ns.nested || {})) {
    if (o.values) enums[o.fullName.replace(/^\./, '')] = o.values;
    if (o.fieldsArray) {
      const full = o.fullName.replace(/^\./, '');
      const fs = [];
      for (const f of o.fieldsArray) {
        if (f.map) {
          mapSkipped++;
          continue;
        }
        const rt = f.resolvedType;
        let tc, enumName;
        if (rt && rt.fieldsArray !== undefined && rt.values === undefined) tc = 100 + idx(rt.fullName.replace(/^\./, ''));else if (rt && rt.values) {
          tc = 9;
          enumName = rt.fullName.replace(/^\./, '');
        } else tc = SCALAR[f.type];
        const numeric = tc < 100 && tc !== 7 && tc !== 8;
        const flags = (f.repeated ? 1 : 0) | (f.repeated && numeric && f.packed !== false ? 2 : 0);
        if (tc === 9) fs.push([f.name, f.id, 9, flags, enumName]);else if (flags) fs.push([f.name, f.id, tc, flags]);else fs.push([f.name, f.id, tc]);
      }
      fs.sort((a, b) => a[1] - b[1]);
      t[full] = fs;
    }
    if (o.nested) build(o);
  }
})(root);
const out = JSON.stringify({
  m: msgNames,
  t,
  e: enums
});
writeFileSync(outPath, out);
