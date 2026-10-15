/**
 * Compatibility tests for the `js-yaml` layer. Run with:
 *   node --test test/yaml.test.mjs
 *
 * The reported failure was environmental: a profile that hoists `js-yaml@5`
 * (because some *other* plugin says `js-yaml@^5`) made `new yaml.Type(...)`
 * throw inside `loadYaml()`, so the whole panel answered 500 with
 * `yaml.Type is not a constructor`. Nothing here needs a v5 to be installed:
 * a copy without the custom-type API is modelled by taking the module this
 * environment actually reaches and hiding `Type`, which is exactly the shape
 * v5 presents. Resolution itself is driven with an injected loader, so the
 * "hoisted v5 loses to the plugin's own copy" ordering is asserted
 * deterministically on any machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  adaptYamlModule,
  buildEntrySchema,
  resolveEntryYaml,
  yamlResolutionAnchors,
} from '../lib/yaml.js';
import { emitInsertBlock, parseItem, readDocument, validateDocument } from '../lib/patch.js';

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');

/**
 * The `js-yaml` this machine reaches through the plugin's own resolution —
 * v4 on a healthy profile, v5 when the bug is present.
 */
const resolved = await resolveEntryYaml(
  yamlResolutionAnchors(null, { home: dshHome, profile: 'web' }),
);

/**
 * A module shaped like a `js-yaml` that dropped the custom-type API: it still
 * parses, it just cannot carry `!!js`.
 * @param mod - a working `js-yaml` module.
 * @returns a module without `Type`.
 */
function withoutCustomTypes(mod) {
  const stripped = { load: (text, options) => mod.load(text, options) };
  const base = mod.JSON_SCHEMA ?? mod.DEFAULT_SCHEMA;
  if (base !== undefined) stripped.JSON_SCHEMA = base;
  return stripped;
}

/** A `js-yaml` copy that can build the entry-list schema. */
const capableModule = {
  Type: class {
    constructor(tag) {
      this.tag = tag;
    }
  },
  JSON_SCHEMA: { extend: (type) => ({ type }) },
};

const incompatibleModule = withoutCustomTypes(resolved.raw);
const fast = resolved;
const degraded = adaptYamlModule(incompatibleModule, 'js-yaml@5.4.3');

/** A patch layer that uses every `!!js` form the dialect allows. */
const DOCUMENT = [
  '- insert:',
  '    - id: mcp-demo',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: demo',
  '        transport: stdio',
  '        command: "node.exe"',
  '        env:',
  '          API_KEY: !!js process.env.TOKEN',
  '          PLAIN: "!!js not a tag"',
  '        headers:',
  '          Authorization: !!js |-',
  '            process.env.A + process.env.B',
  '        args: ["echo !!js x"] # and this one is a plain string too',
  '# a comment that mentions !!js expressions allowed',
  '',
].join('\n');

test('the custom-type API is probed, not assumed', () => {
  assert.equal(typeof fast.yaml.load, 'function', 'resolution must yield a usable module');
  // The claim under test is the *consistency* of the probe: whatever this
  // environment resolves, the adapter's verdict must match the probe.
  assert.equal(buildEntrySchema(resolved.raw) === null, resolved.degraded);
  assert.equal(buildEntrySchema(incompatibleModule), null);
  assert.equal(buildEntrySchema(capableModule) !== null, true);
  assert.equal(degraded.degraded, true);
  assert.equal(fast.degraded, buildEntrySchema(resolved.raw) === null);
});

test('a module that advertises Type but throws while building it degrades', () => {
  const throwing = {
    JSON_SCHEMA: { extend: () => ({}) },
    Type: function Throwing() {
      throw new Error('Type is not a constructor');
    },
  };
  assert.equal(buildEntrySchema(throwing), null);
  assert.equal(adaptYamlModule(throwing, 'throwing').degraded, true);
});

test('a module with Type but no extensible base schema degrades', () => {
  const Type = class {};
  assert.equal(buildEntrySchema({ Type }), null);
  assert.equal(buildEntrySchema({ Type, JSON_SCHEMA: {} }), null);
  assert.equal(buildEntrySchema(null), null);
  assert.equal(buildEntrySchema('js-yaml'), null);
});

// The reported regression: the profile anchor resolves a v5 that another
// plugin hoisted, while the plugin's own pinned copy sits further down the
// anchor list. Resolution must skip the incompatible copy, not use it.
test('an incompatible copy at the profile anchor loses to a capable one', async () => {
  const adapted = await resolveEntryYaml(['profile-anchor', 'plugin-anchor'], {
    load: async (anchor) =>
      anchor === 'profile-anchor'
        ? { module: incompatibleModule, source: 'js-yaml@5.4.3' }
        : { module: capableModule, source: 'plugin/js-yaml@4' },
  });
  assert.equal(adapted.degraded, false);
  assert.equal(adapted.source, 'plugin/js-yaml@4');
  assert.equal(typeof adapted.yaml.Type, 'function');
});

test('when every copy is incompatible the adapter degrades instead of throwing', async () => {
  const adapted = await resolveEntryYaml(['a', 'b'], {
    load: async (anchor) => {
      if (anchor === null) throw new Error('bare import failed');
      return { module: incompatibleModule, source: 'js-yaml@5.4.3' };
    },
  });
  assert.equal(adapted.degraded, true);
  assert.deepEqual(adapted.yaml.load('- id: a\n  x: !!js process.env.T\n')[0].x, {
    __jsExpr: 'process.env.T',
  });
});

test('nothing resolvable anywhere still reports a usable error', async () => {
  await assert.rejects(
    resolveEntryYaml(['a'], {
      load: async () => {
        throw new Error('MODULE_NOT_FOUND');
      },
    }),
    /js-yaml/u,
  );
});

test('a !!js scalar survives a parse without the custom type', () => {
  const { rows, issues } = readDocument(DOCUMENT, degraded.yaml, degraded.schema);
  assert.deepEqual(issues, []);
  assert.equal(rows.length, 1);
  const config = rows[0].config;
  assert.deepEqual(config.env.API_KEY, { __jsExpr: 'process.env.TOKEN' });
  // A block scalar is folded by the YAML parser, exactly as the fast path does.
  assert.deepEqual(config.headers.Authorization, { __jsExpr: 'process.env.A + process.env.B' });
});

test('a quoted string or comment mentioning !!js is never re-tagged', () => {
  const { rows } = readDocument(DOCUMENT, degraded.yaml, degraded.schema);
  const config = rows[0].config;
  assert.equal(config.env.PLAIN, '!!js not a tag');
  assert.deepEqual(config.args, ['echo !!js x']);
  // The trailing comment is part of the item and must parse as a comment.
  const item = parseItem(DOCUMENT, degraded.yaml, degraded.schema);
  assert.equal(typeof item.insert[0].config, 'object');
});

test('a degraded parse writes the same bytes as the fast path', () => {
  const plain = readDocument(DOCUMENT, fast.yaml, fast.schema);
  const adapted = readDocument(DOCUMENT, degraded.yaml, degraded.schema);
  assert.deepEqual(adapted.rows[0].config, plain.rows[0].config);
  assert.equal(emitInsertBlock(adapted.rows), emitInsertBlock(plain.rows));
});

test('re-emitted !!js scalars still validate and round-trip', () => {
  const { rows } = readDocument(DOCUMENT, degraded.yaml, degraded.schema);
  const block = emitInsertBlock(rows);
  assert.match(block, /API_KEY: !!js process\.env\.TOKEN/u);
  assert.doesNotMatch(block, /__jsExpr/u);
  assert.match(block, /"!!js not a tag"/u);
  assert.equal(validateDocument(block, degraded.yaml, degraded.schema), null);
  const again = parseItem(block, degraded.yaml, degraded.schema);
  assert.deepEqual(again.insert[0].config.env.API_KEY, { __jsExpr: 'process.env.TOKEN' });
  assert.equal(again.insert[0].config.env.PLAIN, '!!js not a tag');
});

test('a !!js scalar in flow context stays an expression node', () => {
  const doc =
    '- insert:\n    - id: mcp-flow\n      name: \'@deepseek-ai/dsh-mcp-client\'\n      config: { serverName: flow, headers: { A: !!js process.env.T, B: "x" } }\n';
  const { rows, issues } = readDocument(doc, degraded.yaml, degraded.schema);
  assert.deepEqual(issues, []);
  assert.deepEqual(rows[0].config.headers, { A: { __jsExpr: 'process.env.T' }, B: 'x' });
});
