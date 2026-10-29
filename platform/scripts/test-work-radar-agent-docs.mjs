import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/pages/agent-docs.ts', import.meta.url), 'utf8');
const entry = "['/work-radar', 'public actionable work from the Commonworld Development catalog; Markdown /work-radar.md, JSON /work-radar.json']";

if (!source.includes(entry)) {
  throw new Error('Work Radar is missing from the shared public-page map');
}

const sharedMapUses = source.match(/PAGES\.map\(/g) ?? [];
if (sharedMapUses.length !== 1) {
  throw new Error(`Expected one rendering of the shared public-page map; found ${sharedMapUses.length}`);
}

console.log('Work Radar is present in the public-page map rendered by the agent documentation');
