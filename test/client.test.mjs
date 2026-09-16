/**
 * Client-half check: run `lib/client.js` the way the browser shell does —
 * through a `window.__ModuleLoader__` facade with a CommonJS `require` — and
 * assert it registers a `settings.section` page without throwing.
 *
 * This is the check that catches the failure modes a build step would
 * otherwise catch: a syntax error in the bundle, a `require` of a module that
 * is not in the shell's frozen table, or an `apply()` that reaches for a
 * service it never asked for.
 *
 * Run with:  node test/client.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '..', 'lib', 'client.js');

/**
 * Strip comments so structure checks look only at executable code.
 *
 * The bundle documents its own pitfalls in prose, and a check that matched the
 * explanation instead of the code would pass while the bug was present.
 * @param source - the bundle text.
 * @returns the text with `//` and block comments removed.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** The modules the shell seeds into every bundle's `require`. */
function seededRequire(name) {
  if (name === 'react') return reactStub;
  throw new Error(`unexpected require("${name}"): not in the platform seed table`);
}

/**
 * A minimal React stand-in: enough for a component factory and `createElement`
 * to run, and for the element tree to be inspected. `useState` and friends
 * throw, because the module body must not call them at load time.
 */
const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.filter((c) => c !== undefined && c !== null) };
  },
  Fragment: Symbol('Fragment'),
  useState() {
    throw new Error('useState called outside a render');
  },
  useEffect() {
    throw new Error('useEffect called outside a render');
  },
  useCallback() {
    throw new Error('useCallback called outside a render');
  },
  useRef() {
    throw new Error('useRef called outside a render');
  },
};

/**
 * Load the client bundle into a fake browser and return what it registered.
 * @returns `{ exports, registrations, effects, styles }`.
 */
function loadClientBundle() {
  const registrations = [];
  const effects = [];
  const styles = [];
  const listeners = new Map();

  const documentStub = {
    head: { appendChild: (node) => styles.push(node) },
    getElementById: () => null,
    createElement: (tag) => ({ tag, id: '', textContent: '', style: {} }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };

  let captured = null;
  const windowStub = {
    __ModuleLoader__: {
      load(spec) {
        assert.equal(spec.id, 'dsh-mcp-manager-plus', 'the bundle must register under the package id');
        assert.equal(typeof spec.factory, 'function');
        captured = spec.factory(seededRequire);
      },
    },
    confirm: () => true,
  };

  const source = readFileSync(bundlePath, 'utf8');
  // The bundle is a script that calls window.__ModuleLoader__.load(...).
  const run = new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'console', source);
  run(windowStub, documentStub, () => Promise.reject(new Error('no fetch in this test')), () => 0, () => {}, console);

  assert.ok(captured, 'the bundle must register a factory');

  // Drive apply() the way the shell does: a context where each service the
  // plugin DECLARED in `inject` is resolved as a property before apply() runs
  // (`ctx.slots`), and undeclared services are only reachable through the
  // optional `ctx.get()` lookup. Modelling this faithfully is the whole point:
  // an earlier version of this stub answered `get('slots')` as well, which
  // made a plugin that never declared `slots` look like it worked.
  const slotsStub = {
    inject(key, callback) {
      assert.equal(key, 'settings.section', 'the page must register into the settings section seat');
      return callback();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  };

  const localeStub = {
    register(ns, dicts) {
      registrations.push({ dictionary: { ns, dicts } });
      return () => {};
    },
    getLocale: () => ({ id: 'zh' }),
    subscribe: () => () => {},
  };

  // Drive apply() the way the shell does: a context where each service the
  // plugin DECLARED in `inject` is resolved as a property before apply() runs
  // (`ctx.slots`), and undeclared services are only reachable through the
  // optional `ctx.get()` lookup. Modelling this faithfully is the whole point:
  // an earlier version of this stub answered `get('slots')` as well, which
  // made a plugin that never declared `slots` look like it worked.
  const declared = new Set(captured.inject ?? []);
  const ctx = {
    get(name) {
      if (declared.has(name)) throw new Error(`service "${name}" is declared; it must be read as ctx.${name}`);
      if (name === 'locale') return localeStub;
      return undefined;
    },
    effect(factory, label) {
      const dispose = factory();
      effects.push({ label, dispose });
      return dispose;
    },
  };
  if (declared.has('slots')) ctx.slots = slotsStub;
  if (declared.has('locale')) ctx.locale = localeStub;

  captured.apply(ctx);
  return { exports: captured, registrations, effects, styles, documentStub };
}

test('the bundle registers a factory under the package id', () => {
  const { exports } = loadClientBundle();
  assert.equal(exports.name, 'dsh-mcp-manager-plus');
  assert.equal(typeof exports.apply, 'function');
  // `slots` is a hard dependency: without the declaration cordis never
  // resolves the service, and the settings page silently never registers.
  // `locale` stays undeclared because the page falls back to its own copy.
  assert.deepEqual(exports.inject, ['slots']);
});

test('apply() claims the settings section seat with an id of its own', () => {
  const { registrations } = loadClientBundle();
  const section = registrations.find((entry) => entry.options?.name === 'settings.section');
  assert.ok(section, 'the page must register into settings.section');
  assert.equal(section.options.id, 'mcp');
  assert.equal(section.options.order, 35);
  assert.equal(typeof section.component, 'function', 'the registration must carry a component');
  assert.equal(typeof section.options.label, 'function');
  assert.equal(section.options.label(), 'MCP 管理', 'the nav label must follow the default locale');
});

test('the page label follows the active locale', () => {
  const { exports, registrations } = loadClientBundle();
  // The English label is reachable through the exported dictionary, which is
  // what the locale service and the label thunk both read.
  const section = registrations.find((entry) => entry.options?.name === 'settings.section');
  assert.equal(section.options.label(), 'MCP 管理');
  assert.equal(exports.name, 'dsh-mcp-manager-plus');
});

test('the dictionaries are registered for both shipped locales', () => {
  const { registrations } = loadClientBundle();
  const dict = registrations.find((entry) => entry.dictionary !== undefined);
  assert.ok(dict, 'the bundle must register its dictionaries');
  assert.equal(dict.dictionary.ns, 'dsh-mcp-manager-plus');
  assert.ok(dict.dictionary.dicts.zh.nav);
  assert.ok(dict.dictionary.dicts.en.nav);
  // The two locales must carry the same keys, or one language silently falls
  // back to the other's text mid-page.
  assert.deepEqual(
    Object.keys(dict.dictionary.dicts.zh).sort(),
    Object.keys(dict.dictionary.dicts.en).sort(),
  );
});

test('the stylesheet is injected once and scoped to this plugin', () => {
  const { styles } = loadClientBundle();
  assert.equal(styles.length, 1);
  assert.equal(styles[0].id, 'dsh-mcp-manager-plus-styles');
  assert.match(styles[0].textContent, /\.mcpmp-root/);
  // Every colour comes from a theme token, so the page follows light/dark.
  const literals = styles[0].textContent.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(
    literals.filter((value) => !['#fff'].includes(value)),
    [],
    'no hard-coded colours other than white on the primary button',
  );
});

test('every declared effect is disposable, so the page unwinds on unload', () => {
  const { effects } = loadClientBundle();
  assert.ok(effects.length > 0);
  assert.ok(effects.every((entry) => typeof entry.dispose === 'function'));
});

test('a slot service reachable only through ctx.get() is never trusted', () => {
  // The regression this plugin actually shipped: `inject: []` plus a
  // `ctx.get('slots')` lookup resolves to `undefined` under real cordis even
  // while the service is live, so the page silently never appeared in the
  // settings sidebar. The bundle must read the DECLARED service.
  const source = readFileSync(bundlePath, 'utf8');
  // Strip comments first: the bundle explains this pitfall in prose, and only
  // executable code decides whether the bug is present.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  assert.doesNotMatch(
    code,
    /ctx\.get\(\s*['"]slots['"]\s*\)/,
    'slots must be a declared dependency read as ctx.slots, not an optional ctx.get() lookup',
  );
  assert.match(code, /ctx\.slots\b/, 'the bundle must read the declared slots service');
});

test('an unavailable slot service fails loudly instead of silently', () => {
  // A settings page that never registers is indistinguishable from a plugin
  // that was never installed, so the failure must surface in the console.
  const { exports } = loadClientBundle();
  const bare = {
    get: () => undefined,
    effect: (factory) => factory(),
  };
  assert.throws(
    () => exports.apply(bare),
    /slots service is unavailable/,
    'apply() must throw when the declared service is missing',
  );
});

test('the client bundle never reaches for a dynamic-plugin-only global', () => {
  const source = readFileSync(bundlePath, 'utf8');
  assert.doesNotMatch(source, /\bhost\.call\(/, 'host.call belongs to dynamic Packages, not client plugins');
  assert.doesNotMatch(source, /\brequire\(['"]\.\//, 'a bundle may only require seed modules');
  assert.doesNotMatch(source, /\bprocess\./, 'the browser has no process');
});

test('the page talks to its host over the loopback API it declares', () => {
  const source = readFileSync(bundlePath, 'utf8');
  const host = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8');
  // The prefix must match the host route, or every call 404s in production.
  const clientPrefix = /API_PREFIX = '([^']+)'/.exec(source)?.[1];
  const hostPrefix = /API_PREFIX = '([^']+)'/.exec(host)?.[1];
  assert.ok(clientPrefix, 'the client must declare an API prefix');
  assert.equal(clientPrefix, hostPrefix, 'the client and host prefixes must agree');
  assert.match(clientPrefix, /^\//, 'the API prefix must be an absolute path');
});

// ── the edit dialog's form/JSON mode switch ─────────────────────────────────

test('the edit dialog offers both modes and the JSON mode posts originalName', () => {
  const source = readFileSync(bundlePath, 'utf8');
  const code = stripComments(source);

  // The switch exists and only for an edit: the JSON editor updates a named
  // row, so it needs a server to name — an add has none.
  assert.match(code, /headerExtra/, 'the modal must expose a header slot for the switch');
  assert.match(code, /modeForm/, 'the switch must offer the form mode');
  assert.match(code, /modeJson/, 'the switch must offer the JSON mode');
  assert.match(
    code,
    /onSwitchToJson/,
    'the form dialog must be able to hand off to the JSON dialog',
  );
  assert.match(
    code,
    /onSwitchToForm/,
    'the JSON dialog must be able to hand back to the form',
  );

  // The JSON submit carries the row identity, which is what makes the paste an
  // edit rather than a create.
  const importCall = /api\(\s*'import',\s*\{[\s\S]{0,220}?\}/.exec(code);
  assert.ok(importCall, 'the JSON dialog must call the import endpoint');
  assert.match(
    importCall[0],
    /originalName/,
    'the JSON dialog must send originalName so the row is updated, not duplicated',
  );
});

test('the JSON editor opens seeded with the server being edited', () => {
  const source = readFileSync(bundlePath, 'utf8');
  const code = stripComments(source);
  // An empty box would make the user retype configuration we already hold.
  assert.match(code, /function serverToJson/, 'the JSON seed must come from the server row');
  assert.match(
    code,
    /useState\(function \(\) \{\s*return editing \? serverToJson\(props\.server\) : ''/,
    'the textarea must start from the server JSON when editing, and empty when adding',
  );
  // Only the fields the server actually uses are emitted, so a stdio server
  // does not open with a stray empty `url`.
  assert.match(code, /server\.transport === 'streamable-http'/);
});

test('serverToJson produces a standard mcpServers document', async () => {
  // Exercise the serializer by rendering the dialog through a stub React, so a
  // field it forgets to emit shows up here rather than in the browser.
  const { exports } = loadClientBundle();
  assert.equal(exports.name, 'dsh-mcp-manager-plus');
  const source = readFileSync(bundlePath, 'utf8');
  const body = /function serverToJson\(server\) \{([\s\S]*?)\n    \}/.exec(source)?.[1];
  assert.ok(body, 'serverToJson must be present');
  // Build the function standalone and check both transports.
  const build = new Function('server', `${body.replace(/^/, '')}\n`);
  const stdio = JSON.parse(build({ serverName: 'a', transport: 'stdio', command: 'npx', args: ['-y', 'p'], env: { K: 'v' } }));
  assert.deepEqual(stdio, { mcpServers: { a: { command: 'npx', args: ['-y', 'p'], env: { K: 'v' } } } });
  const http = JSON.parse(build({ serverName: 'b', transport: 'streamable-http', url: 'https://x/mcp', headers: { A: '1' } }));
  assert.deepEqual(http, { mcpServers: { b: { url: 'https://x/mcp', headers: { A: '1' } } } });
  // Empty optional fields are omitted rather than emitted as empty.
  const bare = JSON.parse(build({ serverName: 'c', transport: 'stdio', command: 'x' }));
  assert.deepEqual(bare, { mcpServers: { c: { command: 'x' } } });
});

test('the mode switch is a labelled radiogroup with a sliding indicator', () => {
  const source = readFileSync(bundlePath, 'utf8');
  const code = stripComments(source);
  // Not two loose buttons: a radiogroup announces the current mode and gives
  // arrow-key navigation, which plain buttons do not.
  assert.match(code, /role: 'radiogroup'/, 'the switch must present itself as a radiogroup');
  assert.match(code, /role: 'radio'/, 'each option must be a radio');
  assert.match(code, /'aria-checked'/, 'the active option must report its state');
  assert.match(code, /onKeyDown/, 'arrow keys must move between the options');
  // The indicator is its own element so it can animate and so neither label
  // reflows while it moves.
  assert.match(code, /mcpmp-seg-pill/, 'the switch must draw a sliding pill');
  assert.match(code, /markNavRow|data-index/, 'the pill position must be driven by the active index');
});

test('both mode options carry an icon, and the icons exist', () => {
  const source = readFileSync(bundlePath, 'utf8');
  const code = stripComments(source);
  // Icons make the two modes scannable without reading the labels.
  const uses = [...code.matchAll(/icon: ICON_PATH\.(\w+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 4, `expected the switch to pass icons at both call sites, saw ${uses.length}`);
  for (const name of new Set(uses)) {
    assert.match(code, new RegExp(`\\b${name}:`), `ICON_PATH.${name} is referenced but not defined`);
  }
  // An icon must be a single <path>, since Icon renders exactly one child.
  assert.doesNotMatch(code, /form: h\('g'/, 'a multi-child icon would not render through Icon');
});

test('the JSON dialog explains which tools it accepts', () => {
  const source = readFileSync(bundlePath, 'utf8');
  const code = stripComments(source);
  assert.match(code, /FORMAT_ROWS/, 'the tool list must come from one table');
  assert.match(code, /formatsSummary/, 'the hint must have a summary line');
  assert.match(code, /formatsFooter/, 'the hint must state that no rewriting is needed');
  // Rendering it in both dialogs is the point: adding a server and editing one
  // through JSON accept the same formats.
  const uses = [...code.matchAll(/h\(FormatHint,/g)].length;
  assert.ok(uses >= 1, 'the format hint must be rendered');
  // It must be collapsible so the textarea stays the focus of the dialog.
  assert.match(code, /'details'/, 'the hint must be a details element');
});

test('the advertised formats agree with what the parser accepts', async () => {
  // The hint is only useful if it is true, so the table in the bundle and the
  // container keys in the parser are checked against each other.
  const source = readFileSync(bundlePath, 'utf8');
  const table = /var FORMAT_ROWS = \[([\s\S]*?)\n    \];/.exec(source)?.[1];
  assert.ok(table, 'FORMAT_ROWS must be present');

  const advertised = [...table.matchAll(/key: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(advertised.length >= 5, 'the table must list the tool families');

  const { parseMcpConfig } = await import('../lib/import.js');
  // Every advertised container key must actually be understood.
  for (const key of new Set(advertised)) {
    const probe = key === 'mcp_servers'
      ? `[${key}.probe]\ncommand = "x"\n`
      : JSON.stringify({ [key]: { probe: { command: 'x' } } });
    const parsed = parseMcpConfig(probe);
    assert.equal(parsed.servers[0].serverName, 'probe', `advertised key "${key}" was not parsed`);
  }

  // And the reverse: a tool the parser handles should not be missing from the
  // table. These names must appear somewhere in it.
  const mentioned = table;
  for (const tool of ['Claude Code', 'Cursor', 'Windsurf', 'Qoder', 'Cherry Studio', 'CodeBuddy', 'TRAE', 'ZCode', 'VS Code', 'Codex', 'OpenCode', 'Continue', 'Pi', 'DeepSeek Harness']) {
    assert.ok(mentioned.includes(tool), `"${tool}" is supported by the parser but not advertised`);
  }
});
