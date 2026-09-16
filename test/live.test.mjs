/**
 * Live-profile smoke check: drive the plugin's routes against the REAL profile
 * (the actual `$DSH_HOME/profiles/web` directory and its patch file), with the
 * loader entry list simulated from the composed tree.
 *
 * This is the closest thing to a production read that does not require the
 * running process: it answers "does the manager see the servers this machine
 * actually has, and does it parse this profile's real file".
 *
 * Read-only: it never writes, so it is safe to run against a live profile.
 *
 * Run with:  node test/live.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const profileDir = join(dshHome, 'profiles', 'web');
const patchPath = join(profileDir, 'cordis.patch.yml');

const hasProfile = existsSync(join(profileDir, 'package.json'));

/**
 * Boot the plugin against the real profile directory.
 * @param loaderEntries - simulated loader entry list.
 * @param extraServices - additional `ctx.get` answers (tools, providers).
 */
async function bootReal(loaderEntries, extraServices = {}) {
  const plugin = await import('../lib/index.js');
  const routes = [];
  const ctx = {
    get(name) {
      if (Object.hasOwn(extraServices, name)) return extraServices[name];
      if (name === 'loader') return { entries: () => loaderEntries };
      return undefined;
    },
    effect(factory) {
      const dispose = factory();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  const route = routes.find((entry) => entry.path === '/mcp-manager-plus');
  assert.ok(route);
  return async function request(method, path, body) {
    const req = {
      method,
      url: `/mcp-manager-plus${path}`,
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8');
      },
    };
    let status = 0;
    let payload = '';
    const res = {
      writeHead(code) {
        status = code;
      },
      end(text) {
        payload = text ?? '';
      },
    };
    await route.handler(req, res);
    return { status, body: payload === '' ? null : JSON.parse(payload) };
  };
}

test('the real profile is reachable and its patch file parses', { skip: !hasProfile }, async () => {
  const request = await bootReal([
    { options: { id: 'include', name: 'cordis:include', config: { path: join(profileDir, 'cordis.yml') } } },
  ]);
  const { status, body } = await request('GET', '/servers');
  assert.equal(status, 200);
  assert.equal(body.patchPath, patchPath, 'the plugin must find the real patch file');
  assert.equal(body.profileDir, profileDir);
  assert.deepEqual(body.issues, [], 'this profile must produce no structural complaints');
});

test('the servers this machine configured are all visible, with secrets masked', { skip: !hasProfile }, async () => {
  const request = await bootReal([
    { options: { id: 'include', name: 'cordis:include', config: { path: join(profileDir, 'cordis.yml') } } },
  ]);
  const { body } = await request('GET', '/servers');
  assert.ok(body.servers.length > 0, 'this profile has at least one MCP server configured');

  for (const server of body.servers) {
    assert.equal(typeof server.serverName, 'string');
    assert.ok(server.serverName.length > 0);
    assert.ok(['user', 'bundle', 'builtin'].includes(server.source));
    assert.ok(['stdio', 'streamable-http', 'built-in'].includes(server.transport));
    // No credential-shaped value may survive into the payload.
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (!/KEY|PASSWORD|SECRET|TOKEN/i.test(key)) continue;
      assert.notEqual(value, '', `${server.serverName}.${key} must be masked`);
      assert.match(String(value), /^•+$/, `${server.serverName}.${key} must reach the page masked`);
    }
    for (const [key, value] of Object.entries(server.headers ?? {})) {
      if (!/KEY|PASSWORD|SECRET|TOKEN|AUTH/i.test(key)) continue;
      assert.match(String(value), /^•+$/, `${server.serverName}.${key} must reach the page masked`);
    }
  }
});

test('live tool names are reported raw, and mount state follows the fiber', { skip: !hasProfile }, async () => {
  const tools = {
    schemas: () => [
      { name: 'mcp__dbx__dbx_list_connections', description: 'List connections' },
      { name: 'mcp__dbx__dbx_open_table', description: 'Open a table' },
      { name: 'mcp__other__ping', description: 'Ping' },
      { name: 'read', description: 'Not an MCP tool' },
    ],
  };
  const request = await bootReal(
    [
      { options: { id: 'include', name: 'cordis:include', config: { path: join(profileDir, 'cordis.yml') } } },
      {
        options: {
          id: 'mcp-dbx',
          name: '@deepseek-ai/dsh-mcp-client',
          config: { serverName: 'dbx', transport: 'stdio', command: 'node' },
        },
        fiber: { state: 2 },
        disabled: false,
      },
    ],
    { tools },
  );
  const { body } = await request('GET', '/servers');
  const dbx = body.servers.find((server) => server.serverName === 'dbx');
  assert.ok(dbx, 'the dbx server from this profile must be listed');
  assert.equal(dbx.live.mounted, true, 'the composed row must be matched by serverName, not entry id');
  assert.equal(dbx.live.phase, 'active');
  assert.deepEqual(
    dbx.live.tools.map((tool) => tool.name),
    ['dbx_list_connections', 'dbx_open_table'],
    'tools must be attributed by the mcp__<server>__ prefix and named raw',
  );
  // The prefix must not leak a same-prefix neighbour from another server.
  assert.equal(dbx.live.tools.some((tool) => tool.name === 'ping'), false);
});

test('a failed fiber is reported as failed rather than silently idle', { skip: !hasProfile }, async () => {
  const request = await bootReal([
    { options: { id: 'include', name: 'cordis:include', config: { path: join(profileDir, 'cordis.yml') } } },
    {
      options: {
        id: 'mcp-dbx',
        name: '@deepseek-ai/dsh-mcp-client',
        config: { serverName: 'dbx', transport: 'stdio', command: 'node' },
      },
      fiber: { state: 3 },
      disabled: false,
    },
  ]);
  const { body } = await request('GET', '/servers');
  const dbx = body.servers.find((server) => server.serverName === 'dbx');
  assert.equal(dbx.live.phase, 'failed');
});
