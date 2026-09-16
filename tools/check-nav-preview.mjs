/** Verify the generated nav-icon preview carries the swap rules and a marked row. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'nav-icon-preview.html'), 'utf8');

const checks = [
  ['marked row rendered', /data-mcpmp-nav>/.test(html)],
  ['gear hidden rule', /\[data-mcpmp-nav\]>svg:first-child\{display:none\}/.test(html)],
  ['::before glyph rule', /\[data-mcpmp-nav\]::before/.test(html)],
  ['mask data-url present', /mask-image:url\("data:image\/svg\+xml,/.test(html)],
  ['mask inherits currentColor', /\[data-mcpmp-nav\]::before\{[^}]*background-color:currentColor/.test(html)],
];

const marked = (html.match(/data-mcpmp-nav>/g) ?? []).length;
const rows = (html.match(/class="navCell/g) ?? []).length;
// Two panels (light + dark), one marked row each.
checks.push(['one marked row per theme', marked === 2 && rows === 16]);

let bad = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) bad += 1;
}
console.log(`rows=${rows} marked=${marked}`);
console.log(bad === 0 ? 'OK' : `${bad} PROBLEMS`);
process.exit(bad === 0 ? 0 : 1);
