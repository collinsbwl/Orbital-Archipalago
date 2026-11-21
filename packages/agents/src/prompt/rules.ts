// Frozen system text. Sourced from Markdown files in `./rules/` and loaded once
// at module init. Keep the strings sorted in a stable layout (world + role),
// never splice in cycle numbers or names: anything variable belongs in
// `context` or `state`.

import type { Role } from '@orbital/contracts';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function read(name: string): string {
  // When bundled we expect the files to sit alongside the compiled module in
  // `dist/prompt/rules/`. During development they live in `src/prompt/rules/`.
  const candidates = [resolve(HERE, 'rules', name), resolve(HERE, '..', '..', 'src', 'prompt', 'rules', name)];
  for (const c of candidates) {
    try {
      return readFileSync(c, 'utf8');
    } catch {
      /* try next */
    }
  }
  throw new Error(`cannot find rules file ${name}`);
}

const WORLD = read('world.md').trim();
const ROLE_RULES: Partial<Record<Role, string>> = {
  colonist: read('colonist.md').trim(),
  trader: read('trader.md').trim(),
};

export function systemRulesFor(role: Role): string {
  const roleText = ROLE_RULES[role] ?? '';
  return `${WORLD}\n\n${roleText}`.trim();
}
