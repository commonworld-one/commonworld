import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ entryPoints: [path.join(root, 'browser/handoff.ts')], outfile: path.join(root, 'src/pages/static/handoff.js'), bundle: true, format: 'esm', target: 'es2022', platform: 'browser', legalComments: 'none' });
