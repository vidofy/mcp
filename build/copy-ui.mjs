/**
 * Copy the UI assets that `tsc` does not.
 *
 * The generation card is HTML, served verbatim through resources/read. tsc
 * compiles TypeScript and ignores everything else, so without this step the
 * card is missing from dist/ and the server answers a UI resource read with
 * nothing — a tool that advertises a view the host cannot load.
 *
 * Lives in build/ rather than scripts/: the repository's .gitignore has a bare
 * `scripts/` line, which git matches at EVERY level, so a build script there is
 * silently untracked and the package fails to build for anyone who clones it.
 *
 * Node, not `cp`, so `npm run build` behaves the same on every platform.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'src', 'ui');
const to = join(root, 'dist', 'ui');

if (!existsSync(from)) {
    console.error(`copy-ui: ${from} does not exist`);
    process.exit(1);
}

mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`copy-ui: src/ui → dist/ui`);
