/**
 * Verify a published release against a real registry, in a scratch profile.
 *
 *   node tools/verify-release.mjs                       # version from package.json
 *   node tools/verify-release.mjs 0.4.4 --sync-mirror   # also wait for the CN mirror
 *   node tools/verify-release.mjs 0.4.4 --registry https://registry.npmmirror.com
 *   node tools/verify-release.mjs 0.4.4 --keep          # keep the scratch profile
 *
 * What it checks, in order:
 *   1. the registry serves that version, and it is `latest`;
 *   2. a fresh install pulls the package's own `js-yaml` (the copy the plugin
 *      falls back to when a profile hoists an incompatible one);
 *   3. the installed panel survives the reported scenario. A: the profile
 *      hoists a js-yaml shaped like v5 while the plugin keeps a capable copy —
 *      the capable copy must win. B: the v5-shaped copy is the only one
 *      reachable — the parser must degrade instead of throwing, and emit
 *      byte-identically to the fast path;
 *   4. with `--sync-mirror`, the npmmirror mirror eventually serves the version.
 *
 * The scratch profile is built under the OS temp directory and removed at the
 * end unless `--keep` is passed. Nothing here touches the real `~/.dsh`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME = 'dsh-mcp-manager-plus';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const shell = process.platform === 'win32';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};
const trim = (url) => url.replace(/\/+$/u, '');

const api = {
  registry: trim(flag('--registry', 'https://registry.npmjs.org')),
  mirror: trim(flag('--mirror', 'https://registry.npmmirror.com')),
  syncMirror: argv.includes('--sync-mirror'),
  keep: argv.includes('--keep'),
  version: argv.find((a) => /^\d+\.\d+\.\d+/u.test(a))
    ?? JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version,
};

const results = [];
const check = (ok, label) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  return ok;
};

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/**
 * The entry-list patch layer the host half works with — the reporter's example.
 * @returns a patch document using every `!!js` form the dialect allows.
 */
const DOCUMENT = [
  '- insert:',
  '    - id: mcp-demo',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        env:',
  '          API_KEY: !!js process.env.TOKEN',
  '          PLAIN: "!!js not a tag"',
  '        headers:',
  '          Authorization: !!js |-',
  '            process.env.A + process.env.B',
  '        args: ["echo !!js x"] # and this one is a plain string too',
  '',
].join('\n');

/**
 * Scenario A/B against an installed copy. A expects the capable copy to win;
 * B expects the compatibility parser, with emission identical to A's.
 * @param mode - 'a' or 'b'.
 * @param scratch - the scratch profile holding `node_modules/<NAME>`.
 */
async function runScenario(mode, scratch) {
  const pluginDir = join(scratch, 'node_modules', NAME);
  const lib = (file) => pathToFileURL(join(pluginDir, 'lib', file)).href;
  const { buildEntrySchema, resolveEntryYaml, yamlResolutionAnchors } = await import(lib('yaml.js'));
  const { emitInsertBlock, readDocument, validateDocument } = await import(lib('patch.js'));

  const anchors = yamlResolutionAnchors(scratch, { home: scratch, profile: 'web', pluginDir, cwd: scratch });
  const { yaml, schema, degraded, source, raw } = await resolveEntryYaml(anchors);
  const { rows, issues } = readDocument(DOCUMENT, yaml, schema);
  const block = emitInsertBlock(rows);
  const { rows: again } = readDocument(block, yaml, schema);
  const config = rows[0]?.config ?? {};
  const short = (value) => String(value).replace(scratch, '<scratch>').replace(/\\/gu, '/');

  console.log(`\n--- scenario ${mode.toUpperCase()} ---`);
  console.log(`resolved: degraded=${degraded} source=${short(source)}`);
  console.log(`probe agrees: ${buildEntrySchema(raw) === null === degraded}  (typeof Type=${typeof yaml.Type})`);
  console.log(`API_KEY=${JSON.stringify(config.env?.API_KEY)}`);
  console.log(`Authorization=${JSON.stringify(config.headers?.Authorization)}`);
  console.log(`PLAIN=${JSON.stringify(config.env?.PLAIN)} args=${JSON.stringify(config.args)}`);
  console.log(`emit: !!js=${/!!js/u.test(block)} __jsExpr=${/__jsExpr/u.test(block)} validates=${validateDocument(block, yaml, schema) === null}`);

  writeFileSync(join(scratch, `block-${mode}.txt`), block);
  const prefix = mode.toUpperCase();
  const checks = [
    check(degraded === (mode === 'b'), `${prefix}1 degraded=${degraded} matches the scenario`),
    check(buildEntrySchema(raw) === null === degraded, `${prefix}2 the capability probe agrees with the reported state`),
    check(typeof yaml.load === 'function', `${prefix}3 resolution yielded a usable module`),
    check(issues.length === 0, `${prefix}4 the entry list parses without issues`),
    check(config.env?.API_KEY?.__jsExpr === 'process.env.TOKEN', `${prefix}5 inline !!js becomes an expression node`),
    check(config.env?.PLAIN === '!!js not a tag', `${prefix}6 a quoted mention of !!js stays a literal string`),
    check(config.headers?.Authorization?.__jsExpr === 'process.env.A + process.env.B', `${prefix}7 block-form !!js becomes an expression node`),
    check(config.args?.[0] === 'echo !!js x', `${prefix}8 !!js inside a flow string stays literal`),
    check(validateDocument(block, yaml, schema) === null, `${prefix}9 re-emitted output still validates`),
    check(!/__jsExpr/u.test(block) && /!!js/u.test(block), `${prefix}10 re-emitted output carries !!js, not the placeholder`),
  ];
  if (mode === 'b') {
    const fast = join(scratch, 'block-a.txt');
    const ok = existsSync(fast) && block === readFileSync(fast, 'utf8');
    checks.push(check(ok, 'B11 degraded emission is byte-identical to the fast path'));
  }
  const failed = checks.filter((x) => !x).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * Replace a js-yaml copy with one shaped like v5: it still loads and dumps, it
 * just cannot carry `!!js`, in both the CJS and the ESM entry point.
 * @param copyDir - the js-yaml package directory to hollow out.
 * @param realDir - a working js-yaml the stub re-exports everything else from.
 */
function fakeV5(copyDir, realDir) {
  const manifestPath = join(copyDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = '5.4.3';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const specifier = (fromDir) => {
    const path = relative(fromDir, realDir).replace(/\\/gu, '/');
    return path.startsWith('.') ? path : `./${path}`;
  };
  const surface = ['FAILSAFE_SCHEMA', 'JSON_SCHEMA', 'CORE_SCHEMA', 'DEFAULT_SCHEMA', 'load', 'loadAll', 'dump', 'YAMLException', 'types'];
  const cjs = [
    "'use strict'",
    '// v5 shape: no custom-type API.',
    `const real = require('${specifier(copyDir)}/index.js')`,
    ...surface.map((key) => `module.exports.${key} = real.${key}`),
    "module.exports.__shape = 'v5'",
    '',
  ].join('\n');
  writeFileSync(join(copyDir, 'index.js'), cjs);

  const dist = join(copyDir, 'dist');
  const mjs = [
    '// v5 shape: no custom-type API.',
    `import * as real from '${specifier(dist)}/dist/js-yaml.mjs'`,
    ...surface.map((key) => `export const ${key} = real.${key}`),
    "export const __shape = 'v5'",
    '',
  ].join('\n');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'js-yaml.mjs'), mjs);
}

async function syncMirror() {
  console.log(`\n--- mirror sync (${api.mirror}) ---`);
  try {
    const response = await fetch(`${api.mirror}/-/package/${NAME}/syncs`, { method: 'PUT' });
    console.log(`sync request: ${response.status} ${(await response.text()).slice(0, 120)}`);
  } catch (error) {
    console.log(`sync request failed: ${error.message}`);
  }
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const meta = await fetchJson(`${api.mirror}/${NAME}`).catch(() => null);
    if (meta?.versions?.[api.version]) {
      check(true, `the mirror serves ${NAME}@${api.version} (after ${attempt} checks)`);
      return;
    }
    if (attempt % 4 === 0) console.log(`  still ${meta?.['dist-tags']?.latest ?? 'unreachable'} … (${attempt}/40)`);
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  check(false, `the mirror serves ${NAME}@${api.version} within 10 minutes (trigger it again later)`);
}

async function main() {
  console.log(`verifying ${NAME}@${api.version} against ${api.registry}`);
  const meta = await fetchJson(`${api.registry}/${NAME}`).catch((error) => {
    console.log(`registry lookup failed: ${error.message}`);
    return null;
  });
  check(meta?.versions?.[api.version] !== undefined, `the registry serves ${NAME}@${api.version}`);
  const latest = meta?.['dist-tags']?.latest;
  if (api.registry === 'https://registry.npmjs.org') {
    check(latest === api.version, `dist-tags.latest is ${api.version}`);
  } else {
    // A mirror caches the full packument, so `latest` can still point at the
    // previous version while the version endpoint already serves this one.
    console.log(`note  ${api.registry} reports latest=${latest}; a mirror's packument lags its version endpoint`);
  }
  check(meta?.versions?.[api.version]?.dependencies?.['js-yaml'] !== undefined,
    'the published manifest depends on js-yaml (the plugin\'s own copy)');
  if (meta?.versions?.[api.version] === undefined) {
    console.log('\nthe version is not published yet — nothing else to verify');
    process.exit(1);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'dsh-mcpmp-verify-'));
  console.log(`\nscratch profile: ${scratch}`);
  writeFileSync(join(scratch, 'package.json'), `${JSON.stringify({ name: 'verify', private: true, type: 'module' }, null, 2)}\n`);

  const install = spawnSync(npm, ['install', `${NAME}@${api.version}`, '--registry', api.registry, '--no-audit', '--no-fund', '--no-save'],
    { cwd: scratch, shell, encoding: 'utf8' });
  check(install.status === 0, `a fresh install of ${NAME}@${api.version} succeeds`);
  if (install.status !== 0) {
    console.log(install.stdout ?? '', install.stderr ?? '');
    process.exit(1);
  }

  const pluginDir = join(scratch, 'node_modules', NAME);
  const installed = existsSync(join(pluginDir, 'package.json'))
    ? JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
    : {};
  check(installed.version === api.version, `the installed package reports ${api.version}`);
  check(existsSync(join(pluginDir, 'lib', 'yaml.js')), 'the installed tarball carries lib/yaml.js');
  check(installed.dependencies?.['js-yaml'] !== undefined, 'the installed manifest declares the js-yaml dependency');

  // A capable copy the plugin can own, and a v5-shaped copy the profile hoists.
  const hoisted = join(scratch, 'node_modules', 'js-yaml');
  const capable = join(pluginDir, 'node_modules', 'js-yaml');
  const real = join(scratch, '_real-js-yaml');
  if (!existsSync(hoisted)) {
    console.log('warning: no hoisted js-yaml to model the reported profile');
    process.exit(1);
  }
  cpSync(hoisted, real, { recursive: true });
  if (!existsSync(capable)) {
    mkdirSync(dirname(capable), { recursive: true });
    cpSync(real, capable, { recursive: true });
  }
  check(existsSync(join(capable, 'index.js')), 'the plugin ends up with its own capable js-yaml copy');
  fakeV5(hoisted, real);

  const run = (mode) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--scenario', mode, '--scratch', scratch], { stdio: 'inherit' });
  const fast = run('a');
  renameSync(capable, join(scratch, '_stash-js-yaml'));
  const degraded = run('b');
  renameSync(join(scratch, '_stash-js-yaml'), capable);
  check(fast.status === 0, 'scenario A passes (the plugin\'s capable copy wins)');
  check(degraded.status === 0, 'scenario B passes (a v5-only profile degrades gracefully)');

  if (api.syncMirror) await syncMirror();

  if (!api.keep) rmSync(scratch, { recursive: true, force: true });
  else console.log(`\nkept the scratch profile at ${scratch}`);

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed for ${NAME}@${api.version}`);
  process.exit(failed === 0 ? 0 : 1);
}

const scenarioAt = argv.indexOf('--scenario');
if (scenarioAt === -1) await main();
else await runScenario(argv[scenarioAt + 1], flag('--scratch', tmpdir()));
