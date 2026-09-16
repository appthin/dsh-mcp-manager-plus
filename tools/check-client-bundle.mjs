/** Load the client bundle the way the shell does and report what it registers. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

const captured = [];
const styles = [];
const fakeEl = {
  id: '', textContent: '', style: {},
  appendChild() {}, closest: () => null, querySelectorAll: () => [],
  setAttribute() {}, removeAttribute() {},
};
globalThis.window = { __ModuleLoader__: { load: (r) => captured.push(r) } };
globalThis.document = {
  getElementById: () => null,
  createElement: () => fakeEl,
  head: { appendChild: (n) => styles.push(n) },
  querySelectorAll: () => [],
};

new Function(source)();
const plugin = captured[0].factory((spec) => {
  if (spec === 'react') {
    return {
      createElement: () => null, Fragment: Symbol('F'),
      useState: () => [null, () => {}], useEffect: () => {},
      useCallback: (f) => f, useRef: () => ({ current: null }),
    };
  }
  throw new Error(`unexpected require: ${spec}`);
});

const registrations = [];
const slots = {
  inject(key, cb) { registrations.push(`inject:${key}`); return cb(); },
  register(opts) { registrations.push(`register:id=${opts.id},order=${opts.order}`); return () => {}; },
};
const ctx = {
  slots,
  get: (name) => (name === 'locale'
    ? { register: () => () => {}, getLocale: () => ({ id: 'zh' }), subscribe: () => () => {} }
    : undefined),
  effect: (factory) => { const d = factory(); return typeof d === 'function' ? d : () => {}; },
};

plugin.apply(ctx);

console.log('plugin.inject :', JSON.stringify(plugin.inject));
console.log('registrations :', JSON.stringify(registrations));
console.log('style tags    :', styles.length);

const css = styles.map((s) => s.textContent).join('\n');
const navRules = css.split('\n').filter((line) => line.includes('data-mcpmp-nav'));
console.log('nav-icon rules:', navRules.length);
for (const rule of navRules) {
  console.log('  ' + rule.slice(0, 110) + (rule.length > 110 ? ' …' : ''));
}
const maskUrl = /mask-image:url\("data:image\/svg\+xml,([^"]+)"\)/.exec(css);
console.log('mask payload  :', maskUrl === null ? 'MISSING' : `${maskUrl[1].length} chars`);

const ok = registrations.some((r) => r.startsWith('register:id=mcp'))
  && navRules.length === 2
  && maskUrl !== null
  && decodeURIComponent(maskUrl[1]).includes('<path');
console.log(ok ? 'OK' : 'PROBLEM');
process.exit(ok ? 0 : 1);
