import { readFileSync } from 'node:fs';

// Read package.json relative to this file. Works both unbundled (src/pkg.js -> ../package.json)
// and bundled (bin/crew.js -> ../package.json) since both sit one dir below the repo root.
export const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
