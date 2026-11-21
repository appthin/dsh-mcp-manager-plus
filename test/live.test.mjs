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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * Boot the plugin against a temporary profile whose patch file this suite
 * writes, so a case never depends on what the machine's real profile happens to
 * contain. Only the patch content is synthetic: `js-yaml` still resolves
 * through the real profile, which is why every caller keeps `skip: !hasProfile`.
 * @param patchText - the patch file the plugin will read and report.
 * @param loaderEntries - simulated loader entries beyond the include row.
 * @param extraServices - additional `ctx.get` answers (tools, providers).
 * @returns `{ request, dir }`; the caller removes `dir`.
 */
async function bootSynthetic(patchText, loaderEntries, extraServices = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-live-'));
  writeFileSync(join(dir, 'cordis.patch.yml'), patchText);
  writeFileSync(join(dir, 'cordis.yml'), '[]\n');
  const request = await bootReal(
    [
      { options: { id: 'include', name: 'cordis:include', config: { path: join(dir, 'cordis.yml') } } },
      ...loaderEntries,
    ],
    extraServices,
  );
  return { request, dir };
}

/** A patch layer holding one managed `dbx` row, exactly as the page writes it. */
const DBX_PATCH = `- insert:
    - id: mcp-dbx
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dbx
        transport: stdio
        command: node
`;

/** The composed row a live loader hands back for `dbx`. */
const DBX_ENTRY = {
  options: {
    id: 'mcp-dbx',
    name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'dbx', transport: 'stdio', command: 'node' },
  },
  fiber: { state: 2 },
  disabled: false,
};

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
  const { request, dir } = await bootSynthetic(DBX_PATCH, [DBX_ENTRY], { tools });
  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed fiber is reported as failed rather than silently idle', { skip: !hasProfile }, async () => {
  const { request, dir } = await bootSynthetic(DBX_PATCH, [{ ...DBX_ENTRY, fiber: { state: 3 } }]);
  try {
    const { body } = await request('GET', '/servers');
    const dbx = body.servers.find((server) => server.serverName === 'dbx');
    assert.equal(dbx.live.phase, 'failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a patch-layer disable wins over a live-looking loader entry', { skip: !hasProfile }, async () => {
  // The patch layer is what the page writes and the loader composes on top of,
  // so a row it disables reads as disabled; asserting on the machine's own
  // profile here is what made this suite depend on local state.
  const { request, dir } = await bootSynthetic(`${DBX_PATCH}- id: mcp-dbx\n  disabled: true\n`, [DBX_ENTRY]);
  try {
    const { body } = await request('GET', '/servers');
    const dbx = body.servers.find((server) => server.serverName === 'dbx');
    assert.equal(dbx.enabled, false);
    assert.equal(dbx.live.phase, 'disabled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a row the patch layer does not own is listed from the composed tree', { skip: !hasProfile }, async () => {
  const { request, dir } = await bootSynthetic('# header\n[]\n', [DBX_ENTRY]);
  try {
    const { body } = await request('GET', '/servers');
    const dbx = body.servers.find((server) => server.serverName === 'dbx');
    assert.ok(dbx, 'a deployment-provided server must still be listed');
    assert.equal(dbx.source, 'bundle');
    assert.equal(dbx.editable, false);
    assert.equal(dbx.live.mounted, true);
    assert.equal(dbx.live.phase, 'active');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A stand-in for `@deepseek-ai/dsh-mcp-client`'s status API.
 *
 * The real module's status cell is a WeakMap keyed by the fiber, so a fake has
 * to hand back a handle per fiber. Each fixture fiber carries its own
 * `status` field, which keeps the case data in the test instead of the fixture.
 */
const STATUS_FIXTURE = `export function connectionStatusOf(fiber) {
  const status = fiber && fiber.status;
  if (!status) return undefined;
  return {
    current: () => status,
    closure: () => ({ closeConfirmed: true }),
    onChange: () => () => {},
  };
}
`;

/**
 * Run `body` with the status-module override pointed at a fixture.
 *
 * The override is the only injection point the host exposes, so the env var has
 * to be restored afterwards: a leftover value would make every later case read
 * a status the fixture no longer stands behind.
 * @param fixture - module source the host will import as the status bridge.
 * @param body - the cases to run while the override is installed.
 */
async function withStatusModule(fixture, body) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-status-'));
  const modulePath = join(dir, 'status-fixture.mjs');
  writeFileSync(modulePath, fixture);
  const previous = process.env.DSH_MCP_MANAGER_STATUS_MODULE;
  process.env.DSH_MCP_MANAGER_STATUS_MODULE = modulePath;
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.DSH_MCP_MANAGER_STATUS_MODULE;
    else process.env.DSH_MCP_MANAGER_STATUS_MODULE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A fiber whose bridge reports `status`, as a live entry would carry. */
function entryWithStatus(status) {
  return { ...DBX_ENTRY, fiber: { state: 2, status } };
}

test('a failed handshake is reported as failed even though the fiber is active', { skip: !hasProfile }, async () => {
  await withStatusModule(STATUS_FIXTURE, async () => {
    const entry = entryWithStatus({
      state: 'failed',
      reason: 'gave-up',
      lastError: 'spawn node ENOENT',
    });
    const { request, dir } = await bootSynthetic(DBX_PATCH, [entry]);
    try {
      const { body } = await request('GET', '/servers');
      const dbx = body.servers.find((server) => server.serverName === 'dbx');
      // The lifecycle phase is unchanged on purpose: it answers "did the plugin
      // mount", which is a different question from "did the handshake succeed".
      assert.equal(dbx.live.phase, 'active', 'the loader entry itself mounted fine');
      assert.equal(dbx.live.connection.state, 'failed');
      assert.equal(dbx.live.connection.reason, 'gave-up');
      assert.equal(dbx.live.connection.lastError, 'spawn node ENOENT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('a confirmed connection keeps saying connected, with zero tools or not', { skip: !hasProfile }, async () => {
  await withStatusModule(STATUS_FIXTURE, async () => {
    const entry = entryWithStatus({ state: 'connected', toolCount: 0, connectedAt: 1_700_000_000 });
    const { request, dir } = await bootSynthetic(DBX_PATCH, [entry]);
    try {
      const { body } = await request('GET', '/servers');
      const dbx = body.servers.find((server) => server.serverName === 'dbx');
      // A real handshake that simply exposed nothing must not be downgraded to
      // the "maybe disconnected" guess the fallback would otherwise produce.
      assert.equal(dbx.live.connection.state, 'connected');
      assert.equal(dbx.live.connection.toolCount, 0);
      assert.equal(dbx.live.connection.connectedAt, 1_700_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('an active row with no tools and no bridge status is reported as unverified', { skip: !hasProfile }, async () => {
  // No override: this run exercises the fallback that has to work when the
  // bridge status API cannot be reached at all.
  const { request, dir } = await bootSynthetic(DBX_PATCH, [DBX_ENTRY]);
  try {
    const { body } = await request('GET', '/servers');
    const dbx = body.servers.find((server) => server.serverName === 'dbx');
    assert.equal(dbx.live.phase, 'active');
    assert.equal(dbx.live.toolCount, 0);
    assert.equal(
      dbx.live.connection?.state,
      'unknown',
      'a mounted row with no tools must not claim a connection nobody confirmed',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an active row with tools says nothing about a connection it cannot see', { skip: !hasProfile }, async () => {
  const tools = { schemas: () => [{ name: 'mcp__dbx__dbx_ping', description: 'Ping' }] };
  const { request, dir } = await bootSynthetic(DBX_PATCH, [DBX_ENTRY], { tools });
  try {
    const { body } = await request('GET', '/servers');
    const dbx = body.servers.find((server) => server.serverName === 'dbx');
    assert.equal(dbx.live.toolCount, 1);
    // Registered tools already prove the handshake happened; adding a
    // connection field would only restate what the count shows.
    assert.equal(dbx.live.connection, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a disabled row is never described as a connection problem', { skip: !hasProfile }, async () => {
  await withStatusModule(STATUS_FIXTURE, async () => {
    const entry = entryWithStatus({ state: 'connected', toolCount: 4, connectedAt: 1_700_000_000 });
    const { request, dir } = await bootSynthetic(`${DBX_PATCH}- id: mcp-dbx\n  disabled: true\n`, [entry]);
    try {
      const { body } = await request('GET', '/servers');
      const dbx = body.servers.find((server) => server.serverName === 'dbx');
      assert.equal(dbx.live.phase, 'disabled');
      assert.equal(dbx.live.connection, undefined, 'a row we disabled has no live connection to report');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
