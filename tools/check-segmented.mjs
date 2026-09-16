/**
 * Check the segmented switch's geometry arithmetic.
 *
 * The sliding pill is `width: calc((100% - 6px) / 2)` offset by one `translateX(100%)`.
 * That is only correct if each of the two buttons occupies exactly the same
 * width inside the track's content box. This verifies that assumption against
 * the actual CSS, because a wrong pill is the kind of bug that looks fine in a
 * screenshot of the default state and only shows when switching modes.
 *
 * Run with:  node tools/check-segmented.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
const css = /var CSS = \[([\s\S]*?)\]\.join/.exec(source)?.[1] ?? '';

/** Pull one rule's declarations out of the bundled stylesheet. */
function rule(selector) {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`);
  const match = pattern.exec(css);
  if (match === null) throw new Error(`rule not found: ${selector}`);
  return Object.fromEntries(
    match[1].split(';').filter(Boolean).map((decl) => {
      const at = decl.indexOf(':');
      return [decl.slice(0, at).trim(), decl.slice(at + 1).trim()];
    }),
  );
}

const track = rule('.mcpmp-seg');
const pill = rule('.mcpmp-seg-pill');
const button = rule('.mcpmp-seg-btn');

const problems = [];
const padding = Number.parseFloat(track.padding ?? '0');

// 1. The pill must be inset by exactly the track's padding on both sides.
if (pill.top !== `${padding}px` || pill.bottom !== `${padding}px` || pill.left !== `${padding}px`) {
  problems.push(
    `pill inset (${pill.top}/${pill.bottom}/${pill.left}) does not match the track padding (${padding}px)`,
  );
}

// 2. Its width must be half the content box: (100% - 2*padding) / 2.
const expected = `calc((100% - ${padding * 2}px)/2)`;
if (pill.width !== expected) {
  problems.push(`pill width is ${pill.width}, expected ${expected}`);
}

// 3. Each button must take an equal share, and the buttons must not add a gap
//    the pill does not account for.
if (button.flex !== '1') problems.push(`seg buttons must share the track equally, got flex:${button.flex}`);
if (track.gap !== undefined && track.gap !== '0') {
  problems.push(`a gap of ${track.gap} between buttons would offset the pill`);
}

// 4. The pill must translate by exactly one button width, which is 100%.
const shift = /\.mcpmp-seg\[data-index="1"\] \.mcpmp-seg-pill\{transform:translateX\(([^)]+)\)\}/.exec(css);
if (shift === null) problems.push('no translate rule for the second option');
else if (shift[1] !== '100%') problems.push(`second-option shift is ${shift[1]}, expected 100%`);

// 5. Both call sites must pass exactly two options, since the pill width is
//    hard-coded to halves.
const callSites = [...source.matchAll(/h\(Segmented, \{[\s\S]*?\}\)/g)].map((m) => m[0]);
if (callSites.length === 0) problems.push('no Segmented call site found');
for (const [i, site] of callSites.entries()) {
  const options = [...site.matchAll(/\{ value: '[^']+', label: t\('[^']+'\)/g)].length;
  if (options !== 2) problems.push(`call site ${i + 1} passes ${options} options; the pill assumes 2`);
}

// 6. The track must position the pill.
if (track.position !== 'relative') problems.push('the track must be positioned for the absolute pill');
if (pill.position !== 'absolute') problems.push('the pill must be absolutely positioned');

console.log(`track padding : ${padding}px`);
console.log(`pill          : inset ${pill.top}/${pill.bottom}/${pill.left}, width ${pill.width}`);
console.log(`button flex   : ${button.flex}`);
console.log(`second shift  : ${shift?.[1] ?? '(none)'}`);

if (problems.length === 0) {
  console.log('OK: the pill geometry matches a two-option track');
  process.exit(0);
}
console.log(`PROBLEMS (${problems.length}):`);
for (const p of problems) console.log('  - ' + p);
process.exit(1);
