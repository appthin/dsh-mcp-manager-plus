/**
 * Composition check: compose the web profile's real bundle layers plus its
 * user patch layer, and assert this plugin's row resolves to a loadable
 * package with a client bundle the module system can serve.
 *
 * This is the same `applyEntryPatches` call the boot include makes, so it
 * answers "will the next boot find my row" without booting anything.
 *
 * Run with:  node test/compose.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const profileDir = join(dshHome, 'profiles', 'web');
const profileRequire = createRequire(join(profileDir, 'package.json'));

const appBootMod = await import(
  pathToFileURL(profileRequire.resolve('@deepseek-ai/dsh-app-boot')).href
);
// `dsh-app-boot` ships CJS with a `default` object alongside named exports;
// prefer named, fall back to the default's own properties.
const appBoot = { ...(appBootMod.default ?? {}), ...appBootMod };
const includeMod = await import(
  pathToFileURL(profileRequire.resolve('@deepseek-ai/cordis-plugin-include')).href
);
const applyEntryPatches = includeMod.applyEntryPatches ?? includeMod.default?.applyEntryPatches;
assert.equal(typeof applyEntryPatches, 'function', 'the include plugin must export applyEntryPatches');

const ROW_ID = 'mcp-manager-plus';
const PACKAGE = 'dsh-mcp-manager-plus';

/** Compose every bundle layer for the profile, then the profile's own patch. */
function composeProfile() {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  const layers = [];
  for (const bundle of manifest.dsh.profile.bundles) {
    const dir = appBoot.resolveBundleDir('dsh', bundle, join(dshHome, '..'), profileDir);
    const patch = appBoot.readProfileManifest('dsh', dir).dsh?.bundle?.patch;
    if (typeof patch !== 'string' || patch === '') continue;
    layers.push(appBoot.loadOverlayPatches('dsh', join(dir, patch)));
  }
  const userPatch = join(profileDir, 'cordis.patch.yml');
  if (existsSync(userPatch)) layers.push(appBoot.loadOverlayPatches('dsh', userPatch));
  return applyEntryPatches([], layers.flat(), () => {});
}

test('every profile bundle layer resolves, so a missing one is caught here', () => {
  const entries = composeProfile();
  assert.ok(entries.length > 0, 'the composed tree must not be empty');
});

test('the manager row is inserted with the package name the loader will import', () => {
  const entries = composeProfile();
  const row = entries.find((entry) => entry.id === ROW_ID);
  assert.ok(row, `row ${ROW_ID} must exist in the composed tree`);
  assert.equal(row.name, PACKAGE);
  assert.notEqual(row.disabled, true, 'the row must start enabled');
});

test('no two bundles insert the same row id (a duplicate id is a hard boot failure)', () => {
  const entries = composeProfile();
  const ids = entries.map((entry) => entry.id).filter((id) => typeof id === 'string');
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], `duplicate loader entry ids: ${duplicates.join(', ')}`);
});

test('the package entry artifact the loader will import exists', () => {
  const dir = join(profileDir, 'node_modules', PACKAGE);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const entry = manifest.exports?.['.']?.default ?? manifest.main;
  assert.ok(entry, 'the package must declare an entry');
  assert.ok(existsSync(join(dir, entry)), `entry artifact ${entry} must exist`);
});

test('the client bundle the module system will serve exists and is non-empty', () => {
  const dir = join(profileDir, 'node_modules', PACKAGE);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(manifest.dsh?.client?.platform, 'web', 'the package must declare a web client');
  const clientRel = manifest.exports?.['./client'];
  assert.equal(typeof clientRel, 'string', 'the package must export ./client');
  const clientPath = join(dir, clientRel);
  assert.ok(existsSync(clientPath), `client artifact ${clientRel} must exist`);
  assert.ok(statSync(clientPath).size > 0, 'the client bundle must not be empty');
  // The bundle protocol: the shell needs a factory registered under this id.
  const source = readFileSync(clientPath, 'utf8');
  assert.match(source, /__ModuleLoader__\.load\(/);
  assert.match(source, new RegExp(`id:\\s*'${PACKAGE}'`));
});

test('the host half imports cleanly from the profile', async () => {
  const dir = join(profileDir, 'node_modules', PACKAGE);
  const mod = await import(pathToFileURL(join(dir, 'lib', 'index.js')).href);
  assert.equal(mod.name, PACKAGE);
  assert.deepEqual(mod.inject, ['webServer']);
  assert.equal(typeof mod.apply, 'function');
});
