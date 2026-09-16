/**
 * Round-trip tests for the patch-layer module. Run with:
 *   node --test test/patch.test.mjs
 *
 * The module is deliberately dependency-light (node:fs plus an injected
 * js-yaml), so these tests load the same js-yaml the profile hoists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MCP_CLIENT_PACKAGE,
  appendBlock,
  dropDisabledOverrides,
  dropOverrides,
  emitDisabledBlock,
  emitInsertBlock,
  insertedIds,
  itemText,
  joinTopLevel,
  parseItem,
  readDocument,
  readPatchText,
  removeRowFromBlock,
  rewriteInsertBlock,
  splitTopLevel,
  updateRowInBlock,
  validateDocument,
} from '../lib/patch.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Load `js-yaml` the way the plugin does at runtime: from the harness home's
 * profile, which is where the loader's own include plugin resolves it. A
 * `DSH_HOME` override (or the default `~/.dsh`) is the same search anchor.
 */
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const profileRequire = createRequire(join(dshHome, 'profiles', 'web', 'package.json'));
const yaml = profileRequire('js-yaml');

/** The entry-list dialect: `!!js` scalars become expression nodes. */
const jsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: (value) =>
    value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string',
  represent: (value) => value.__jsExpr,
});
const schema = yaml.JSON_SCHEMA.extend(jsExpr);

/**
 * A representative user patch layer: the profile's header comments, a row with
 * flow-style args and a quoted env key, and a second transport form.
 */
const SAMPLE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
- insert:
    - id: mcp-dbx
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dbx
        transport: stdio
        command: "D:\\\\programs\\\\nvm\\\\v24.2.0\\\\node.exe"
        args: ["D:\\\\programs\\\\nvm\\\\v24.2.0\\\\node_modules\\\\@dbx-app\\\\mcp-server\\\\bin\\\\dbx-mcp-server.js"]
        env:
          "DBX_DATA_DIR": "E:\\\\tools\\\\DBX_x64-portable\\\\data"
    - id: mcp-other
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: other
        transport: streamable-http
        url: http://localhost:3000/mcp
        headers:
          Authorization: "Bearer abc"
`;

function docs(text) {
  return readDocument(text, yaml, schema);
}

test('split/join round-trips the profile patch file byte for byte', () => {
  const actual = readFileSync(join(here, 'fixtures', 'cordis.patch.yml'), 'utf8');
  const parts = splitTopLevel(actual);
  assert.equal(joinTopLevel(parts), actual);
});

test('split/join round-trips a file with no trailing newline', () => {
  const text = '- id: a\n  disabled: true';
  assert.equal(joinTopLevel(splitTopLevel(text)), `${text}\n`);
});

test('an all-comment document regains its placeholder instead of booting broken', () => {
  const parts = { eol: '\n', preamble: ['# just a comment'], items: [], placeholder: true };
  assert.equal(joinTopLevel(parts), '# just a comment\n[]\n');
  assert.equal(joinTopLevel({ ...parts, placeholder: false }), '# just a comment\n[]\n');
  assert.equal(validateDocument(joinTopLevel(parts), yaml, schema), null);
});

test('appending to the shipped placeholder produces one document, not two', () => {
  const parts = splitTopLevel('# header\n[]\n');
  assert.equal(parts.placeholder, true);
  const text = appendBlock(parts, emitInsertBlock([
    { id: 'mcp-a', name: MCP_CLIENT_PACKAGE, config: { serverName: 'a', transport: 'stdio', command: 'npx' } },
  ]));
  assert.equal(validateDocument(text, yaml, schema), null);
  assert.doesNotMatch(text, /^\[\]$/mu);
  assert.match(text, /# header/);
});

test('every write path leaves the real profile file valid', () => {
  const document = docs(SAMPLE);
  const steps = [
    appendBlock(document.parts, emitDisabledBlock('mcp-dbx', true)),
    appendBlock(document.parts, emitInsertBlock([
      { id: 'mcp-new', name: MCP_CLIENT_PACKAGE, config: { serverName: 'new', transport: 'stdio', command: 'npx' } },
    ])),
  ];
  for (const text of steps) assert.equal(validateDocument(text, yaml, schema), null);
});

test('reads the MCP rows out of a real patch layer', () => {
  const document = docs(SAMPLE);
  assert.equal(document.issues.length, 0);
  assert.deepEqual(
    document.rows.map((row) => row.id),
    ['mcp-dbx', 'mcp-other'],
  );
  assert.equal(document.rows[0].config.serverName, 'dbx');
  assert.equal(document.rows[1].config.transport, 'streamable-http');
});

test('toggling preserves comments, siblings and the other insert block', () => {
  const document = docs(SAMPLE);
  const withOverride = appendBlock(document.parts, emitDisabledBlock('mcp-other', true));
  assert.equal(validateDocument(withOverride, yaml, schema), null);
  assert.ok(withOverride.startsWith('# Your patch layer'));
  // The untouched sibling row survives.
  assert.match(withOverride, /id: mcp-dbx/);
  assert.match(withOverride, /serverName: other/);
  const reparsed = docs(withOverride);
  assert.equal(reparsed.overrides.disabled.get('mcp-other'), true);
  assert.equal(reparsed.rows.length, 2);
});

test('repeated toggles leave exactly one override block', () => {
  let text = SAMPLE;
  for (const enabled of [false, true, false, false]) {
    const document = docs(text);
    const { parts } = dropOverrides(document.parts, ['mcp-other'], yaml, schema);
    text = enabled ? joinTopLevel(parts) : appendBlock(parts, emitDisabledBlock('mcp-other', true));
  }
  const occurrences = text.match(/^- id: mcp-other$/gmu) ?? [];
  assert.equal(occurrences.length, 1);
  assert.equal(validateDocument(text, yaml, schema), null);
});

test('rewriting one row keeps its siblings inside the shared insert block', () => {
  const document = docs(SAMPLE);
  const target = document.rows.find((row) => row.id === 'mcp-dbx');
  const config = { ...target.config, serverName: 'dbx', transport: 'stdio', command: 'node2' };
  const text = updateRowInBlock(
    document.parts,
    target,
    { id: 'mcp-dbx', name: MCP_CLIENT_PACKAGE, config },
    yaml,
    schema,
  );
  const reparsed = docs(text);
  assert.equal(reparsed.rows.length, 2);
  assert.equal(reparsed.rows.find((row) => row.id === 'mcp-dbx').config.command, 'node2');
  assert.equal(reparsed.rows.find((row) => row.id === 'mcp-other').config.serverName, 'other');
  assert.equal(validateDocument(text, yaml, schema), null);
});

test('removing one row keeps its sibling and leaves a valid document', () => {
  const document = docs(SAMPLE);
  const target = document.rows.find((row) => row.id === 'mcp-other');
  const { text, blockRemoved } = removeRowFromBlock(document.parts, target, yaml, schema);
  assert.equal(blockRemoved, false);
  assert.doesNotMatch(text, /mcp-other/);
  assert.match(text, /mcp-dbx/);
  assert.equal(validateDocument(text, yaml, schema), null);
});

test('removing the last row of a block drops the block entirely', () => {
  const single = `# header
- insert:
    - id: mcp-only
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: only
        transport: stdio
        command: npx
`;
  const document = docs(single);
  const target = document.rows.find((row) => row.id === 'mcp-only');
  const { text, blockRemoved } = removeRowFromBlock(document.parts, target, yaml, schema);
  assert.equal(blockRemoved, true);
  assert.match(text, /# header/);
  assert.match(text, /^\[\]$/mu);
  assert.equal(validateDocument(text, yaml, schema), null);
});

test('emitted rows survive a parse round-trip, env and args included', () => {
  const block = emitInsertBlock([
    {
      id: 'mcp-github',
      name: MCP_CLIENT_PACKAGE,
      config: {
        serverName: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'x', EMPTY: '' },
      },
    },
  ]);
  const parsed = yaml.load(block, { schema });
  assert.equal(parsed.length, 1);
  const row = parsed[0].insert[0];
  assert.equal(row.id, 'mcp-github');
  assert.equal(row.name, MCP_CLIENT_PACKAGE);
  assert.equal(row.config.serverName, 'github');
  assert.deepEqual(row.config.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.equal(row.config.env.GITHUB_TOKEN, 'x');
});

test('an emitted document is itself a valid patch layer', () => {
  const document = docs('# note\n[]\n');
  const text = appendBlock(document.parts, emitInsertBlock([
    { id: 'mcp-a', name: MCP_CLIENT_PACKAGE, config: { serverName: 'a', transport: 'stdio', command: 'npx' } },
  ]));
  assert.equal(validateDocument(text, yaml, schema), null);
  assert.doesNotMatch(text, /^\[\]$/mu, 'the empty-list placeholder must not survive two top-level documents');
});

test('a document with a broken fragment is refused rather than written', () => {
  const broken = '- id: a\n   config: [unclosed\n';
  assert.notEqual(validateDocument(broken, yaml, schema), null);
});

test('a top-level non-array document is refused', () => {
  assert.notEqual(validateDocument('id: a\ndisabled: true\n', yaml, schema), null);
});

test('id collisions are visible to the caller', () => {
  const document = docs(SAMPLE);
  const ids = insertedIds(document.parts, yaml, schema);
  assert.ok(ids.has('mcp-dbx'));
  assert.ok(ids.has('mcp-other'));
  assert.ok(!ids.has('mcp-new'));
});

test('a missing patch file reads as an empty document', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-'));
  try {
    assert.equal(readPatchText(join(dir, 'cordis.patch.yml')), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a toggle preserves a hand-written config override on the same row', () => {
  const text = `${SAMPLE}- id: mcp-dbx
  config:
    toolCallTimeoutMs: 90000
`;
  const document = docs(text);
  // Both the disable override and the unrelated config override target the row.
  assert.equal(document.rows.length, 2);
  const { parts, removed } = dropDisabledOverrides(document.parts, ['mcp-dbx'], yaml, schema);
  const next = appendBlock(parts, emitDisabledBlock('mcp-dbx', true));
  assert.equal(removed, 0, 'there was no disable override to drop yet');
  assert.match(next, /toolCallTimeoutMs: 90000/, 'the user config override must survive');
  assert.match(next, /- id: mcp-dbx\n  disabled: true/);
  assert.equal(validateDocument(next, yaml, schema), null);
});

test('toggling twice keeps the config override and leaves one disable block', () => {
  let text = `${SAMPLE}- id: mcp-dbx
  config:
    toolCallTimeoutMs: 90000
`;
  for (const enabled of [false, true, false]) {
    const document = docs(text);
    const { parts } = dropDisabledOverrides(document.parts, ['mcp-dbx'], yaml, schema);
    text = enabled ? joinTopLevel(parts) : appendBlock(parts, emitDisabledBlock('mcp-dbx', true));
  }
  assert.equal((text.match(/disabled: true/gmu) ?? []).length, 1);
  assert.equal((text.match(/toolCallTimeoutMs: 90000/gmu) ?? []).length, 1);
  assert.equal(validateDocument(text, yaml, schema), null);
});

test('readDocument exposes a row config override without confusing it for a row', () => {
  const text = `${SAMPLE}- id: mcp-dbx
  config:
    toolCallTimeoutMs: 90000
`;
  const document = docs(text);
  assert.equal(document.overrides.config.get('mcp-dbx').toolCallTimeoutMs, 90000);
  assert.equal(document.overrides.disabled.has('mcp-dbx'), false);
  assert.equal(document.rows.length, 2, 'an override is not an inserted row');
});

test('itemText and splitTopLevel keep a row with a nested list intact', () => {
  const document = docs(SAMPLE);
  const target = document.rows.find((row) => row.id === 'mcp-dbx');
  const text = itemText(target.item, document.parts.eol);
  assert.match(text, /args:/);
  assert.match(text, /dbx-mcp-server\.js/);
});

test('parseItem rejects the empty placeholder and accepts a real row', () => {
  assert.equal(parseItem('[]', yaml, schema), null);
  assert.equal(parseItem('- id: a\n  disabled: true', yaml, schema).id, 'a');
});

test('a !!js expression in a sibling row survives an edit of another row', () => {
  const text = `${SAMPLE}- insert:
    - id: mcp-tokened
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: tokened
        transport: streamable-http
        url: http://localhost:3000/mcp
        headers:
          Authorization: !!js 'Bearer token'
`;
  const document = docs(text);
  const target = document.rows.find((row) => row.id === 'mcp-dbx');
  const next = updateRowInBlock(
    document.parts,
    target,
    { id: 'mcp-dbx', name: MCP_CLIENT_PACKAGE, config: { ...target.config, command: 'node2' } },
    yaml,
    schema,
  );
  assert.match(next, /!!js/);
  // Still an expression node after a reparse, not a literal mapping.
  const reparsed = docs(next);
  const tokened = reparsed.rows.find((row) => row.id === 'mcp-tokened');
  assert.equal(tokened.config.headers.Authorization.__jsExpr, 'Bearer token');
});

test('a !!js expression value is emitted as a tagged scalar, not a mapping', () => {
  const block = emitInsertBlock([
    {
      id: 'mcp-a',
      name: MCP_CLIENT_PACKAGE,
      config: {
        serverName: 'a',
        transport: 'streamable-http',
        url: 'http://x/mcp',
        headers: { Authorization: { __jsExpr: 'Bearer token' } },
      },
    },
  ]);
  assert.match(block, /Authorization: !!js/);
  assert.doesNotMatch(block, /__jsExpr/);
  const parsed = yaml.load(block, { schema });
  assert.equal(parsed[0].insert[0].config.headers.Authorization.__jsExpr, 'Bearer token');
});
