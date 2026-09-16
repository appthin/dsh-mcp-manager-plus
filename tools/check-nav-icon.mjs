/**
 * Validate the nav-icon mask payload without a browser: decode the data URL
 * out of the injected stylesheet and check it is well-formed, drawable SVG.
 *
 * This is the substitute for a screenshot in an environment where Chromium's
 * IPC channel is blocked: it proves the glyph is real geometry with sane
 * coordinates, in the right viewBox, coloured black so the CSS mask can use it
 * as a stencil.
 *
 * Run with:  node tools/check-nav-icon.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

const styles = [];
const fakeEl = { id: '', textContent: '', style: {}, appendChild() {} };
globalThis.document = {
  getElementById: () => null,
  createElement: () => fakeEl,
  head: { appendChild: (node) => styles.push(node) },
  querySelectorAll: () => [],
};

// Load the bundle and run apply(), which is what injects the stylesheet.
const captured = [];
globalThis.window = { __ModuleLoader__: { load: (r) => captured.push(r) } };
new Function(source)();
const factory = captured[0].factory((spec) => {
  if (spec !== 'react') throw new Error(`unexpected require: ${spec}`);
  return {
    createElement: () => null, Fragment: Symbol('F'),
    useState: () => [null, () => {}], useEffect: () => {}, useCallback: (f) => f,
    useRef: () => ({ current: null }),
  };
});
factory.apply({
  slots: { inject: (_k, cb) => cb(), register: () => () => {} },
  get: () => undefined,
  effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {}; },
});

const css = styles.map((s) => s.textContent).join('\n');
const match = /mask-image:url\("data:image\/svg\+xml,([^"]+)"\)/.exec(css);
if (match === null) {
  console.log('FAIL no mask data URL in the injected stylesheet');
  process.exit(1);
}

const svg = decodeURIComponent(match[1]);
const problems = [];

if (!/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg)) problems.push('svg root lacks the SVG namespace (a mask needs it)');
if (!/viewBox="0 0 16 16"/.test(svg)) problems.push('viewBox is not the 16x16 the sidebar uses');
if (!/fill="none"/.test(svg)) problems.push('root should declare fill:none and let each path fill');
if (!/width="16" height="16"/.test(svg)) problems.push('svg is not sized 16x16');

const paths = [...svg.matchAll(/<path d="([^"]+)" fill="([^"]*)"\/>/g)];
if (paths.length === 0) problems.push('no <path> elements — the mask would be blank');

let coords = 0;
for (const [, d, fill] of paths) {
  if (fill !== '#000') problems.push('a path is not solid black; a mask needs opaque geometry');
  if (d.length < 20) problems.push(`a path looks truncated (${d.length} chars)`);
  if (!/^[MmZzLlHhVvCcSsQqTtAa0-9.,\s+eE+-]+$/.test(d)) problems.push('a path has unexpected characters');
  // Every coordinate should sit inside (or just outside) the 16px box.
  for (const num of d.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const value = Number(num[0]);
    if (Number.isFinite(value) && value > 16.5) { coords += 1; }
  }
}
if (coords > 0) problems.push(`${coords} coordinates fall outside the 16x16 box`);

console.log(`mask payload : ${match[1].length} chars`);
console.log(`svg          : ${svg.length} chars, ${paths.length} paths`);
const opacities = paths.map((p) => p[1].length);
console.log(`path lengths : ${opacities.join(', ')}`);

if (problems.length === 0) {
  console.log('OK: the glyph is a valid 16x16 black stencil with real geometry');
  process.exit(0);
}
console.log(`PROBLEMS (${problems.length}):`);
for (const p of problems) console.log('  - ' + p);
process.exit(1);
