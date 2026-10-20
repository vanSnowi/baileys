// Regenerates the protobufjs static module from WAProto.proto.
//
//   npm run WAProto
//
// Produces WAProto/index.js (ESM static module) and WAProto/index.d.ts, the same
// format protobufjs' pbjs/pbts emit. Requires the protobufjs-cli devDependency.
// The only post-step is fixing the runtime import so it resolves under Node ESM
// (`protobufjs/minimal` -> default import of `protobufjs/minimal.js`).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const bin = (name) => fileURLToPath(new URL(`../node_modules/.bin/${name}`, import.meta.url));
const indexJs = dir + 'index.js';
const indexDts = dir + 'index.d.ts';
const protoFile = dir + 'WAProto.proto';

execFileSync(bin('pbjs'), ['-t', 'static-module', '-w', 'es6', '--force-long', '-o', indexJs, protoFile], { stdio: 'inherit' });

// pbjs' es6 wrapper emits `import * as $protobuf from "protobufjs/minimal";`.
// Under Node ESM that specifier needs the extension and a default import (the
// CJS module object lives on the default binding, not as named exports).
const patched = readFileSync(indexJs, 'utf8').replace(
    'import * as $protobuf from "protobufjs/minimal";',
    'import $protobuf from "protobufjs/minimal.js";'
);
writeFileSync(indexJs, patched);

execFileSync(bin('pbts'), ['-o', indexDts, indexJs], { stdio: 'inherit' });

console.log('WAProto: generated index.js + index.d.ts');
