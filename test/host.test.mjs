/**
 * End-to-end tests for the host half: the real `apply()` is driven through a
 * minimal fake Cordis context, so every HTTP route, the patch-file writes and
 * the inventory projection are exercised as they run in the harness.
 *
 * Run with:  node test/host.test.mjs
 *
 * The fake context provides only what the plugin actually uses (`get`,
 * `effect`, and a capturing `webServer`), which is also a check that the
 * plugin does not reach for anything else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const profileRequire = createRequire(join(dshHome, 'profiles', 'web', 'package.json'));
const yaml = profileRequire('js-yaml');

const plugin = await import('../lib/index.js');

const jsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: (value) => value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string',
  represent: (value) => value.__jsExpr,
});
const schema = yaml.JSON_SCHEMA.extend(jsExpr);

const SEED = `# Your patch layer for this dsh profile.
- insert:
    - id: mcp-dbx
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dbx
        transport: stdio
        command: "node.exe"
        args: ["dbx-mcp-server.js"]
        env:
          DBX_DATA_DIR: "E:\\\\tools\\\\DBX_x64-portable\\\\data"
          DBX_API_TOKEN: "s3cret"
`;

/**
 * Boot the plugin against a temporary profile and return a driver for its
 * routes.
 * @param seed - initial patch-file content (defaults to {@link SEED}).
 * @param options - `{ tools, services, includeEntry, entries }` stubs.
 * @returns `{ patchPath, request, read, dispose, log }`.
 */
async function boot(seed = SEED, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-host-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  if (seed !== null) writeFileSync(patchPath, seed);

  const routes = [];
  const cleanups = [];
  const log = [];
  const toolSchemas = options.tools ?? [];
  const services = options.services ?? {};

  const ctx = {
    get(name) {
      if (name === 'tools') return { schemas: () => toolSchemas };
      if (Object.hasOwn(services, name)) return services[name];
      if (name === 'loader') {
        if (options.includeEntry === null) return undefined;
        return {
          entries: () => [
            {
              options: {
                id: 'include',
                name: 'cordis:include',
                config: { path: options.includeEntry ?? patchPath.replace(/cordis\.patch\.yml$/u, 'cordis.yml') },
              },
              fiber: { state: 2 },
              disabled: false,
            },
            ...(options.entries ?? []),
          ],
        };
      }
      return undefined;
    },
    effect(factory, label) {
      const dispose = factory();
      cleanups.push(dispose);
      log.push(label);
      return dispose;
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
  };

  plugin.apply(ctx);
  const route = routes.find((entry) => entry.path === '/mcp-manager-plus');
  assert.ok(route, 'the management route must be registered');

  /** Issue one request through the real handler. */
  async function request(method, path, body) {
    const url = `/mcp-manager-plus${path}`;
    const req = {
      method,
      url,
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8');
      },
    };
    let status = 0;
    let payload = '';
    const headers = {};
    const res = {
      writeHead(code, sent) {
        status = code;
        Object.assign(headers, sent ?? {});
      },
      end(text) {
        payload = text ?? '';
      },
    };
    await route.handler(req, res);
    return { status, headers, body: payload === '' ? null : JSON.parse(payload) };
  }

  return {
    dir,
    patchPath,
    request,
    read: () => readFileSync(patchPath, 'utf8'),
    parse: () => yaml.load(readFileSync(patchPath, 'utf8'), { schema }),
    dispose() {
      for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('lists the servers already in the patch layer, with secrets masked', async () => {
  const app = await boot();
  try {
    const { status, body } = await app.request('GET', '/servers');
    assert.equal(status, 200);
    assert.equal(body.servers.length, 1);
    const server = body.servers[0];
    assert.equal(server.serverName, 'dbx');
    assert.equal(server.id, 'mcp-dbx');
    assert.equal(server.source, 'user');
    assert.equal(server.enabled, true);
    assert.equal(server.transport, 'stdio');
    assert.deepEqual(server.args, ['dbx-mcp-server.js']);
    assert.equal(server.env.DBX_DATA_DIR, 'E:\\tools\\DBX_x64-portable\\data');
    assert.notEqual(server.env.DBX_API_TOKEN, 's3cret', 'a credential must never reach the browser');
    assert.equal(body.writable, true);
  } finally {
    app.dispose();
  }
});

test('rejects a non-loopback caller', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-remote-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  writeFileSync(patchPath, '# header\n[]\n');
  const routes = [];
  const ctx = {
    get(name) {
      if (name === 'loader') {
        return {
          entries: () => [
            { options: { id: 'include', name: 'cordis:include', config: { path: join(dir, 'cordis.yml') } } },
          ],
        };
      }
      return undefined;
    },
    effect(factory) {
      return factory();
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
  try {
    let status = 0;
    let payload = '';
    await route.handler(
      {
        method: 'GET',
        url: '/mcp-manager-plus/servers',
        socket: { remoteAddress: '10.1.2.3' },
        async *[Symbol.asyncIterator]() {},
      },
      {
        writeHead(code) {
          status = code;
        },
        end(text) {
          payload = text ?? '';
        },
      },
    );
    assert.equal(status, 403);
    assert.match(JSON.parse(payload).error, /本机/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('creating a server appends a row and a re-read sees it', async () => {
  const app = await boot();
  try {
    const saved = await app.request('POST', '/save', {
      serverName: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'tok' },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.action, 'created');
    assert.equal(saved.body.serverName, 'github');

    // The dbx row is untouched, and the new row is a sibling block.
    const parsed = app.parse();
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].insert[0].id, 'mcp-dbx');
    assert.equal(parsed[1].insert[0].id, 'mcp-github');
    assert.equal(parsed[1].insert[0].config.serverName, 'github');
    assert.equal(parsed[1].insert[0].config.env.GITHUB_TOKEN, 'tok');

    const listing = await app.request('GET', '/servers');
    assert.deepEqual(
      listing.body.servers.map((s) => s.serverName),
      ['dbx', 'github'],
    );
  } finally {
    app.dispose();
  }
});

test('editing a server updates its own row and keeps its siblings', async () => {
  const app = await boot();
  try {
    const saved = await app.request('POST', '/save', {
      serverName: 'dbx',
      originalName: 'dbx',
      transport: 'stdio',
      command: 'node2.exe',
      args: ['a.js', 'b.js'],
    });
    assert.equal(saved.body.action, 'updated');
    const parsed = app.parse();
    assert.equal(parsed.length, 1, 'the row stays in its original block');
    const row = parsed[0].insert[0];
    assert.equal(row.id, 'mcp-dbx');
    assert.equal(row.config.command, 'node2.exe');
    assert.deepEqual(row.config.args, ['a.js', 'b.js']);
    // A field the form did not resubmit is preserved, not dropped.
    assert.equal(row.config.env.DBX_API_TOKEN, 's3cret');
  } finally {
    app.dispose();
  }
});

test('a masked credential round-trips unchanged when the form echoes it back', async () => {
  const app = await boot();
  try {
    const listing = await app.request('GET', '/servers');
    const masked = listing.body.servers[0].env;
    assert.notEqual(masked.DBX_API_TOKEN, 's3cret');
    await app.request('POST', '/save', {
      serverName: 'dbx',
      originalName: 'dbx',
      transport: 'stdio',
      command: 'node.exe',
      args: ['dbx-mcp-server.js'],
      env: masked,
    });
    const row = app.parse()[0].insert[0];
    assert.equal(row.config.env.DBX_API_TOKEN, 's3cret', 'the mask must resolve back to the real value');
  } finally {
    app.dispose();
  }
});

test('a renamed server keeps its row id and its own flag', async () => {
  const app = await boot();
  try {
    await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: false });
    const disabled = app.parse();
    assert.equal(disabled.length, 1, 'the flag is written on the row, not as a new block');
    assert.equal(disabled[0].insert[0].disabled, true);

    const saved = await app.request('POST', '/save', {
      serverName: 'dbx2',
      originalName: 'dbx',
      transport: 'stdio',
      command: 'node.exe',
    });
    assert.equal(saved.body.action, 'updated');
    assert.equal(saved.body.id, 'mcp-dbx');
    const parsed = app.parse();
    assert.equal(parsed[0].insert[0].id, 'mcp-dbx');
    assert.equal(parsed[0].insert[0].config.serverName, 'dbx2');
  } finally {
    app.dispose();
  }
});

test('disabling then enabling a user row flips the flag on the row', async () => {
  const app = await boot();
  try {
    await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: false });
    let listing = await app.request('GET', '/servers');
    assert.equal(listing.body.servers[0].enabled, false);
    assert.equal(app.parse()[0].insert[0].disabled, true, 'the flag lands on the row');

    await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: true });
    listing = await app.request('GET', '/servers');
    assert.equal(listing.body.servers[0].enabled, true);
    const parsed = app.parse();
    assert.equal(parsed.length, 1, 'the document stays one block');
    assert.equal(parsed[0].insert[0].disabled, false, 'enabling writes the other state explicitly');
  } finally {
    app.dispose();
  }
});

test('toggling repeatedly never appends a trailing block', async () => {
  const app = await boot();
  try {
    // Every flip lands on the row itself, so nothing accumulates anywhere.
    for (let i = 0; i < 5; i += 1) {
      await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: i % 2 === 0 });
    }
    assert.equal(
      (app.read().match(/^- id: mcp-dbx$/gmu) ?? []).length,
      0,
      'a row is never toggled by a trailing block',
    );

    // Ending on "disabled" leaves the flag on the row, however often it flipped.
    for (let i = 0; i < 6; i += 1) {
      await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: i % 2 === 0 });
    }
    assert.equal(app.parse()[0].insert[0].disabled, true);
    assert.equal(yaml.load(app.read(), { schema }).length, 1, 'the document stays one block');
    assert.equal((app.read().match(/^- id: mcp-dbx$/gmu) ?? []).length, 0);
  } finally {
    app.dispose();
  }
});

test('removing a server drops its row and its override, keeping the header', async () => {
  const app = await boot();
  try {
    await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: false });
    const removed = await app.request('POST', '/remove', { id: 'mcp-dbx' });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.action, 'removed');
    const text = app.read();
    assert.doesNotMatch(text, /mcp-dbx/);
    assert.match(text, /# Your patch layer/);
    assert.match(text, /^\[\]$/mu, 'an emptied file keeps a valid placeholder');
  } finally {
    app.dispose();
  }
});

test('a built-in provider service is listed read-only beside the servers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-builtin-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  writeFileSync(patchPath, '# header\n[]\n');
  const routes = [];
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          schemas: () => [
            { name: 'computer_use_get_app_state', description: 'Read the app state' },
            { name: 'computer_use_click', description: 'Click a point' },
            { name: 'unrelated_tool', description: 'Not part of the provider' },
          ],
        };
      }
      if (name === 'computerUse') return { register: () => async () => {} };
      if (name === 'loader') {
        return {
          entries: () => [
            { options: { id: 'include', name: 'cordis:include', config: { path: join(dir, 'cordis.yml') } } },
            { options: { id: 'computer-use' }, disabled: false },
          ],
        };
      }
      return undefined;
    },
    effect(factory) {
      return factory();
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
  try {
    let payload = '';
    await route.handler(
      {
        method: 'GET',
        url: '/mcp-manager-plus/servers',
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {},
      },
      {
        writeHead() {},
        end(text) {
          payload = text ?? '';
        },
      },
    );
    const builtin = JSON.parse(payload).servers.find((s) => s.source === 'builtin');
    assert.ok(builtin, 'the built-in provider must be listed');
    assert.equal(builtin.editable, false);
    assert.equal(builtin.removable, false);
    assert.deepEqual(
      builtin.live.tools.map((t) => t.name),
      ['click', 'get_app_state'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an MCP-backed built-in provider lists the tools under its registered name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-builtin-mcp-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  writeFileSync(patchPath, '# header\n[]\n');
  const routes = [];
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          schemas: () => [
            { name: 'mcp__cua-driver-mcp__click', description: 'Click a point' },
            { name: 'mcp__cua-driver-mcp__get_window_state', description: 'Snapshot a window' },
            { name: 'mcp__dbx__query', description: 'Another MCP server' },
          ],
        };
      }
      // The regression this covers: the provider registers under its own name
      // and the MCP bridge namespaces every tool with it, so the built-in row
      // cannot be enumerated from the service key's snake_case prefix.
      if (name === 'computerUse') return { providerName: 'cua-driver-mcp' };
      if (name === 'loader') {
        return {
          entries: () => [
            { options: { id: 'include', name: 'cordis:include', config: { path: join(dir, 'cordis.yml') } } },
            { options: { id: 'computer-use' }, disabled: false },
          ],
        };
      }
      return undefined;
    },
    effect(factory) {
      return factory();
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
  try {
    let payload = '';
    await route.handler(
      {
        method: 'GET',
        url: '/mcp-manager-plus/servers',
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {},
      },
      {
        writeHead() {},
        end(text) {
          payload = text ?? '';
        },
      },
    );
    const builtin = JSON.parse(payload).servers.find((s) => s.source === 'builtin');
    assert.ok(builtin, 'the built-in provider must be listed');
    assert.equal(builtin.provider, 'cua-driver-mcp', 'the data still names the active provider');
    assert.doesNotMatch(
      builtin.displayName,
      /·/u,
      'the label carries no provider suffix: the expanded children show which one is on',
    );
    assert.deepEqual(
      builtin.live.tools.map((t) => t.name),
      ['click', 'get_window_state'],
      'the row lists the provider’s own tool names, as an MCP server row does',
    );
    assert.deepEqual(
      builtin.live.tools.map((t) => t.fullName),
      ['mcp__cua-driver-mcp__click', 'mcp__cua-driver-mcp__get_window_state'],
      'the qualified name is kept for the tooltip',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Session-scoped built-in provider is listed from the live Agent scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-builtin-session-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  writeFileSync(patchPath, '# header\n[]\n');
  const routes = [];
  const agent = { id: 'agent-1' };
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          // The root scope holds no browser tools: the provider mounts them in
          // the Agent's scope, which only a per-Agent read can see.
          schemas: (scope) =>
            scope === undefined
              ? [{ name: 'root_only_tool', description: 'Root scope' }]
              : [
                  { name: 'mcp__playwright-mcp__browser_navigate', description: 'Navigate' },
                  { name: 'mcp__playwright-mcp__browser_click', description: 'Click' },
                  { name: 'mcp__dbx__query', description: 'Another MCP server' },
                ],
        };
      }
      if (name === 'browserUse') return { providerName: 'playwright-mcp' };
      if (name === 'agents') return { list: () => [agent] };
      if (name === 'loader') {
        return {
          entries: () => [
            { options: { id: 'include', name: 'cordis:include', config: { path: join(dir, 'cordis.yml') } } },
            { options: { id: 'browser-use' }, disabled: false },
          ],
        };
      }
      return undefined;
    },
    effect(factory) {
      return factory();
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
  try {
    let payload = '';
    await route.handler(
      {
        method: 'GET',
        url: '/mcp-manager-plus/servers',
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {},
      },
      {
        writeHead() {},
        end(text) {
          payload = text ?? '';
        },
      },
    );
    const builtin = JSON.parse(payload).servers.find((s) => s.source === 'builtin');
    assert.ok(builtin, 'the built-in provider must be listed');
    assert.equal(builtin.provider, 'playwright-mcp');
    assert.deepEqual(
      builtin.live.tools.map((t) => t.name),
      ['browser_click', 'browser_navigate'],
      'tools mounted in a live Agent scope are listed, and no other server’s are',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty built-in row is explained instead of silently empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-builtin-empty-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  writeFileSync(patchPath, '# header\n[]\n');
  const routes = [];
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return { schemas: () => [{ name: 'qwsh', description: 'Unrelated tool' }] };
      }
      if (name === 'browserUse') return { providerName: 'playwright-mcp' };
      // No live Session: a per-Session provider has published nothing yet.
      if (name === 'agents') return { list: () => [] };
      if (name === 'loader') {
        return {
          entries: () => [
            { options: { id: 'include', name: 'cordis:include', config: { path: join(dir, 'cordis.yml') } } },
            { options: { id: 'browser-use' }, disabled: false },
          ],
        };
      }
      return undefined;
    },
    effect(factory) {
      return factory();
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
  try {
    let payload = '';
    await route.handler(
      {
        method: 'GET',
        url: '/mcp-manager-plus/servers',
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {},
      },
      {
        writeHead() {},
        end(text) {
          payload = text ?? '';
        },
      },
    );
    const data = JSON.parse(payload);
    const builtin = data.servers.find((s) => s.source === 'builtin');
    assert.equal(builtin.live.tools.length, 0);
    assert.match(builtin.note, /会话|Session/u, 'the row itself explains its empty list');
    assert.deepEqual(data.issues, [], 'the explanation belongs to the row, not the page');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the native built-in provider lists its own underscore namespace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-builtin-native-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  writeFileSync(patchPath, '# header\n[]\n');
  const routes = [];
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          schemas: () => [
            { name: 'cua_driver_native__check_permissions', description: 'Permissions' },
            { name: 'cua_driver_native__list_apps', description: 'List apps' },
            // Decoys: the MCP-backed provider's namespace, and another server.
            { name: 'mcp__cua-driver-mcp__click', description: 'MCP-backed provider' },
            { name: 'mcp__dbx__query', description: 'Another MCP server' },
          ],
        };
      }
      // The native provider registers as `cua-driver-native` and publishes its
      // catalog under `cua_driver_native__` — same service slot, different
      // namespace, and it mounts at root rather than inside each Agent.
      if (name === 'computerUse') return { providerName: 'cua-driver-native' };
      if (name === 'loader') {
        return {
          entries: () => [
            { options: { id: 'include', name: 'cordis:include', config: { path: join(dir, 'cordis.yml') } } },
            { options: { id: 'computer-use' }, disabled: false },
          ],
        };
      }
      return undefined;
    },
    effect(factory) {
      return factory();
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
  try {
    let payload = '';
    await route.handler(
      {
        method: 'GET',
        url: '/mcp-manager-plus/servers',
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {},
      },
      {
        writeHead() {},
        end(text) {
          payload = text ?? '';
        },
      },
    );
    const builtin = JSON.parse(payload).servers.find((s) => s.source === 'builtin');
    assert.equal(builtin.provider, 'cua-driver-native');
    assert.deepEqual(
      builtin.live.tools.map((t) => t.name),
      ['check_permissions', 'list_apps'],
      'the native namespace is matched without picking up the MCP provider’s tools',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restarting a built-in row re-applies the provider row through the patch layer', async () => {
  const native = {
    options: {
      id: 'computer-use-cua-driver-native',
      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
    },
    disabled: false,
    fiber: { state: 2 },
  };
  const app = await boot('# header\n[]\n', {
    services: { computerUse: { providerName: 'cua-driver-native' } },
    entries: [
      { options: { id: 'computer-use' }, disabled: false, fiber: { state: 2 } },
      native,
    ],
  });
  // The loader rebuilds the entry when the patch generation is re-applied, so the
  // stub follows the same off/on timeline the real one does.
  setTimeout(() => {
    native.disabled = true;
    native.fiber = undefined;
  }, 400);
  setTimeout(() => {
    native.disabled = false;
    native.fiber = { state: 2 };
  }, 1100);
  try {
    const cu = await app.request('POST', '/restart', { id: 'builtin-computer-use' });
    assert.equal(cu.status, 200, JSON.stringify(cu.body));
    // The label is the capability alone now, so the message names it; the child
    // rows are what say which provider ran.
    assert.match(cu.body.message, /Computer Use/u);
    assert.match(
      app.read(),
      /- id: computer-use-cua-driver-native[\s\S]*?disabled: false/u,
      'the row ends up switched on through the patch layer',
    );
  } finally {
    app.dispose();
  }
});

test('restart recovers a built-in capability whose provider never registered', async () => {
  // The state a lost single-slot race leaves behind: the service exists, the
  // provider does not, so there is no registered name to match on.
  const browserUse = { providerName: '' };
  const playwright = {
    options: { id: 'browser-use-playwright-mcp' },
    disabled: true,
  };
  const chrome = {
    options: { id: 'browser-use-chrome-devtools-mcp' },
    disabled: false,
    fiber: { state: 2 },
  };
  const app = await boot('# header\n[]\n', {
    services: { browserUse },
    entries: [{ options: { id: 'browser-use' }, disabled: false, fiber: { state: 2 } }, playwright, chrome],
  });
  setTimeout(() => {
    chrome.disabled = true;
    chrome.fiber = undefined;
  }, 400);
  setTimeout(() => {
    chrome.disabled = false;
    chrome.fiber = { state: 2 };
    browserUse.providerName = 'chrome-devtools-mcp';
  }, 1100);
  try {
    const { status, body } = await app.request('POST', '/restart', { id: 'builtin-browser-use' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.match(body.message, /Browser Use/u);
    // The seed has no insert block, so the row is switched by a trailing override.
    const rows = app.parse();
    assert.equal(rows.find((row) => row.id === 'browser-use-chrome-devtools-mcp').disabled, false);
    assert.equal(rows.find((row) => row.id === 'browser-use-playwright-mcp'), undefined);
  } finally {
    app.dispose();
  }
});

test('a restart that does not restore the provider fails loudly', async () => {
  const chrome = {
    options: { id: 'browser-use-chrome-devtools-mcp' },
    disabled: false,
    fiber: { state: 2 },
  };
  const app = await boot('# header\n[]\n', {
    services: { browserUse: { providerName: '' } },
    entries: [{ options: { id: 'browser-use' }, disabled: false, fiber: { state: 2 } }, chrome],
  });
  // The row settles, but activation swallows its own failure: the provider never
  // appears, so the capability is unusable and the restart must say so.
  setTimeout(() => {
    chrome.disabled = true;
    chrome.fiber = undefined;
  }, 400);
  setTimeout(() => {
    chrome.disabled = false;
    chrome.fiber = { state: 2 };
  }, 1100);
  try {
    const { status, body } = await app.request('POST', '/restart', { id: 'builtin-browser-use' });
    assert.equal(status, 400, 'a restart that leaves the capability unusable is not a success');
    assert.match(body.error, /仍未注册|has not registered/u);
  } finally {
    app.dispose();
  }
});

test('an ordinary row restarts through the patch layer too', async () => {
  const row = {
    options: {
      id: 'mcp-dbx',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'dbx' },
    },
    disabled: false,
    fiber: { state: 2 },
  };
  const app = await boot(undefined, { entries: [row] });
  setTimeout(() => {
    row.disabled = true;
    row.fiber = undefined;
  }, 500);
  setTimeout(() => {
    row.disabled = false;
    row.fiber = { state: 2 };
  }, 1200);
  try {
    const { status, body } = await app.request('POST', '/restart', { id: 'mcp-dbx' });
    assert.equal(status, 200, JSON.stringify(body));
    const rows = app.parse()[0].insert;
    assert.equal(rows.find((entry) => entry.id === 'mcp-dbx').disabled, false);
  } finally {
    app.dispose();
  }
});
test('a provider child restarts through the patch layer, not by disposing its fiber', async () => {
  const seed = [
    '# header',
    '- insert:',
    '    - id: computer-use',
    "      name: '@deepseek-ai/dsh-computer-use'",
    '',
    '    - id: computer-use-cua-driver-mcp',
    "      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'",
    '      disabled: false',
    '',
    '',
  ].join('\n');
  const child = {
    options: {
      id: 'computer-use-cua-driver-mcp',
      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp',
    },
    disabled: false,
    fiber: { state: 2 },
  };
  const app = await boot(seed, {
    services: { computerUse: { providerName: 'cua-driver-mcp' } },
    entries: [
      {
        options: { id: 'computer-use', name: '@deepseek-ai/dsh-computer-use' },
        disabled: false,
        fiber: { state: 2 },
      },
      child,
    ],
  });
  // The loader rebuilds the entry when its patch generation is re-applied, so the
  // restart is an off/on pair; disposing the fiber directly instead re-patches the
  // entry context and leaves an ancestor expression reporting it disabled.
  setTimeout(() => {
    child.disabled = true;
    child.fiber = undefined;
  }, 500);
  setTimeout(() => {
    child.disabled = false;
    child.fiber = { state: 2 };
  }, 1200);
  try {
    const { status, body } = await app.request('POST', '/restart', {
      id: 'computer-use-cua-driver-mcp',
    });
    assert.equal(status, 200, JSON.stringify(body));
    const rows = app.parse()[0].insert;
    const at = (id) => rows.find((row) => row.id === id);
    assert.equal(at('computer-use-cua-driver-mcp').disabled, false, 'the row ends up switched on');
    assert.equal(at('computer-use').disabled, undefined, 'the service row is left alone');
  } finally {
    app.dispose();
  }
});

test('a disabled provider child refuses to restart', async () => {
  const app = await boot(undefined, {
    services: { browserUse: { providerName: 'chrome-devtools-mcp' } },
    entries: [
      {
        options: { id: 'browser-use', name: '@deepseek-ai/dsh-browser-use' },
        disabled: false,
        fiber: { state: 2 },
      },
      {
        options: {
          id: 'browser-use-playwright-mcp',
          name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
        },
        disabled: true,
      },
    ],
  });
  try {
    const { status, body } = await app.request('POST', '/restart', {
      id: 'browser-use-playwright-mcp',
    });
    assert.equal(status, 400);
    assert.match(body.error, /已停用/u);
  } finally {
    app.dispose();
  }
});
test('selecting a provider switches its siblings off in the same write', async () => {
  const seed = [
    '# header',
    '- insert:',
    '    - id: browser-use',
    "      name: '@deepseek-ai/dsh-browser-use'",
    '',
    '    - id: browser-use-playwright-mcp',
    "      name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'",
    '      disabled: true',
    '',
    '    - id: browser-use-chrome-devtools-mcp',
    "      name: '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp'",
    '      disabled: false',
    '',
    '',
  ].join('\n');
  const playwright = {
    options: {
      id: 'browser-use-playwright-mcp',
      name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
    },
    disabled: true,
  };
  const chrome = {
    options: {
      id: 'browser-use-chrome-devtools-mcp',
      name: '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp',
    },
    disabled: false,
    fiber: { state: 2 },
  };
  const app = await boot(seed, {
    services: { browserUse: { providerName: 'chrome-devtools-mcp' } },
    entries: [
      {
        options: { id: 'browser-use', name: '@deepseek-ai/dsh-browser-use' },
        disabled: false,
        fiber: { state: 2 },
      },
      playwright,
      chrome,
    ],
  });
  // The loader catches up a moment later, as it does in the real app.
  setTimeout(() => {
    playwright.disabled = false;
    playwright.fiber = { state: 2 };
    chrome.disabled = true;
    chrome.fiber = undefined;
  }, 1400);
  try {
    const { status, body } = await app.request('POST', '/toggle', {
      id: 'browser-use-playwright-mcp',
      enabled: true,
    });
    assert.equal(status, 200, JSON.stringify(body));
    // The slot is freed first, then claimed: one write would let the loader
    // activate the new provider before the old one released the slot.
    assert.equal(body.steps, 2, 'a switch frees the slot before claiming it');
    const rows = app.parse()[0].insert;
    const at = (id) => rows.find((row) => row.id === id);
    assert.equal(at('browser-use-playwright-mcp').disabled, false, 'the chosen provider is on');
    assert.equal(at('browser-use-chrome-devtools-mcp').disabled, true, 'its sibling is off');
    assert.equal(at('browser-use').disabled, undefined, 'the service row is left alone');
  } finally {
    app.dispose();
  }
});
test('a built-in row lists its provider children with their own state', async () => {
  const app = await boot(undefined, {
    services: { browserUse: { providerName: 'chrome-devtools-mcp' } },
    entries: [
      { options: { id: 'browser-use', name: '@deepseek-ai/dsh-browser-use' }, disabled: false, fiber: { state: 2 } },
      {
        options: {
          id: 'browser-use-playwright-mcp',
          name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
        },
        disabled: true,
      },
      {
        options: {
          id: 'browser-use-chrome-devtools-mcp',
          name: '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp',
        },
        disabled: false,
        fiber: { state: 2 },
      },
      {
        options: {
          id: 'browser-use-stagehand-native',
          name: '@deepseek-ai/dsh-experimental-browser-use-stagehand-native',
        },
        disabled: false,
      },
      {
        options: { id: 'browser-use-waiting-mcp', name: '@deepseek-ai/dsh-experimental-browser-use-waiting-mcp' },
        disabled: false,
        fiber: { state: 0, inject: { browserUse: true }, ctx: { get: () => undefined } },
      },
    ],
  });
  try {
    const { status, body } = await app.request('GET', '/servers');
    assert.equal(status, 200);
    const row = body.servers.find((server) => server.id === 'builtin-browser-use');
    assert.ok(row, 'the built-in row is listed');
    // Only the providers are children: the service's own state is the header's.
    assert.equal(row.children.length, 4);
    assert.equal(row.live.phase, 'active', 'the header carries the service state');
    const byId = Object.fromEntries(row.children.map((child) => [child.id, child]));
    for (const id of ['browser-use-playwright-mcp', 'browser-use-chrome-devtools-mcp', 'browser-use-stagehand-native', 'browser-use-waiting-mcp']) {
      assert.equal(byId[id].kind, 'provider', `${id} is a provider row`);
    }
    assert.equal(byId['browser-use-chrome-devtools-mcp'].phase, 'active');
    assert.equal(byId['browser-use-chrome-devtools-mcp'].enabled, true);
    assert.equal(byId['browser-use-playwright-mcp'].phase, 'disabled');
    assert.equal(byId['browser-use-playwright-mcp'].enabled, false);
    // No fiber means the package could not be imported at all.
    assert.equal(byId['browser-use-stagehand-native'].phase, 'failed');
    assert.match(byId['browser-use-stagehand-native'].diagnostic, /载入|import/u);
    // A pending row names the service it is waiting for.
    assert.equal(byId['browser-use-waiting-mcp'].phase, 'pending');
    assert.deepEqual(byId['browser-use-waiting-mcp'].missing, ['browserUse']);
  } finally {
    app.dispose();
  }
});
test('no diagnostic route ships with the plugin', async () => {
  const app = await boot();
  try {
    const { status } = await app.request('GET', '/entries');
    assert.equal(status, 404, 'the temporary plugin-tree dump must not ship');
  } finally {
    app.dispose();
  }
});
test('a switched-off built-in capability stays listed as disabled', async () => {
  const app = await boot('# header\n[]\n', {
    // No computerUse/browserUse service at all: only the capability's own loader
    // row survives, which is exactly the state a disabled service leaves.
    entries: [{ options: { id: 'browser-use' }, disabled: true }],
  });
  try {
    const { status, body } = await app.request('GET', '/servers');
    assert.equal(status, 200);
    const row = body.servers.find((server) => server.id === 'builtin-browser-use');
    assert.ok(row, 'a disabled capability must stay on the page, or its switch is unreachable');
    assert.equal(row.enabled, false);
    assert.equal(row.live.phase, 'disabled');
    assert.equal(row.live.mounted, false);
    assert.equal(row.live.tools.length, 0);
    assert.match(row.note, /停用/u, 'the row says why it is empty');
  } finally {
    app.dispose();
  }
});

test('the built-in switch toggles the capability row, not a synthetic id', async () => {
  const app = await boot();
  try {
    const { status, body } = await app.request('POST', '/toggle', {
      id: 'builtin-browser-use',
      enabled: false,
      source: 'builtin',
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.target, 'browser-use');
    const text = app.read();
    assert.match(text, /id: browser-use/u, 'the capability row is what gets switched off');
    assert.doesNotMatch(text, /builtin-browser-use/u, 'the synthetic id must not reach the file');
  } finally {
    app.dispose();
  }
});
test('a toggle retries the whole-patch re-apply until the tree follows', async () => {
  const capability = {
    options: {
      id: 'mcp-dbx',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'dbx' },
    },
    disabled: false,
  };
  const app = await boot(undefined, { entries: [capability] });
  // The loader is busy applying the targeted update at first and only follows the
  // whole-patch re-apply a moment later, which is exactly what the retry is for.
  setTimeout(() => { capability.disabled = true; }, 1400);
  try {
    const header = app.read().split(/\r?\n/u)[0];
    const { status, body } = await app.request('POST', '/toggle', {
      id: 'mcp-dbx',
      enabled: false,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.effective, true, 'the retry recovered the tree');
    assert.equal(body.nudged, true, 'a whole-patch re-apply was forced');
    const text = app.read();
    assert.match(text, /disabled: true/u, 'the write itself landed');
    assert.notEqual(text.split(/\r?\n/u)[0], header, 'the nudge changed a byte');
  } finally {
    app.dispose();
  }
});
test('a built-in toggle writes the flag on the row itself, keeping the block intact', async () => {
  const seed = [
    '# header',
    '- insert:',
    '    - id: browser-use',
    "      name: '@deepseek-ai/dsh-browser-use'",
    '',
    '    # a comment that must survive the toggle',
    '    - id: browser-use-chrome-devtools-mcp',
    "      name: '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp'",
    '      disabled: false',
    '',
    '',
  ].join('\n');
  const capability = {
    options: { id: 'browser-use', name: '@deepseek-ai/dsh-browser-use' },
    disabled: false,
  };
  const app = await boot(seed, { entries: [capability] });
  const flip = (value) => setTimeout(() => { capability.disabled = value; }, 150);
  try {
    flip(true);
    const off = await app.request('POST', '/toggle', {
      id: 'builtin-browser-use',
      enabled: false,
      source: 'builtin',
    });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.inline, true, 'the flag is written in place');
    let text = app.read();
    assert.match(
      text,
      /- id: browser-use\r?\n\s+name: '@deepseek-ai\/dsh-browser-use'\r?\n\s+disabled: true/u,
      'the flag lands on the capability row itself',
    );
    assert.match(text, /# a comment that must survive the toggle/u, 'the block keeps its comments');
    assert.doesNotMatch(text, /^- id: browser-use$/mu, 'no trailing override block');

    flip(false);
    const on = await app.request('POST', '/toggle', {
      id: 'builtin-browser-use',
      enabled: true,
      source: 'builtin',
    });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    text = app.read();
    assert.match(
      text,
      /- id: browser-use\r?\n\s+name: '@deepseek-ai\/dsh-browser-use'\r?\n\s+disabled: false/u,
      'the flag flips to the other state instead of disappearing',
    );
    assert.match(text, /# a comment that must survive the toggle/u, 'comments still there');
  } finally {
    app.dispose();
  }
});
test('a bundle-provided row is listed read-only and togglable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-bundle-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  writeFileSync(patchPath, '# header\n[]\n');
  const routes = [];
  const cleanups = [];
  // Mutable, so the stub can let the loader catch up after a write the way the
  // real one does — the toggle verifies the tree, it does not assume it.
  const bundleRow = {
    options: {
      id: 'mcp-shared',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'shared', transport: 'stdio', command: 'npx' },
    },
    fiber: { state: 2 },
    disabled: false,
  };
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          schemas: () => [
            { name: 'mcp__shared__ping', description: 'Ping' },
            { name: 'mcp__shared__pong', description: 'Pong' },
          ],
        };
      }
      if (name === 'loader') {
        return {
          entries: () => [
            {
              options: {
                id: 'include',
                name: 'cordis:include',
                config: { path: join(dir, 'cordis.yml') },
              },
              fiber: { state: 2 },
              disabled: false,
            },
            bundleRow,
          ],
        };
      }
      return undefined;
    },
    effect(factory) {
      const dispose = factory();
      cleanups.push(dispose);
      return dispose;
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
  async function request(method, path, body) {
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
  }

  try {
    const listing = await request('GET', '/servers');
    const shared = listing.body.servers.find((s) => s.serverName === 'shared');
    assert.ok(shared, 'the bundle row must appear');
    assert.equal(shared.source, 'bundle');
    assert.equal(shared.editable, false);
    assert.equal(shared.removable, false);
    assert.equal(shared.live.toolCount, 2);
    assert.deepEqual(
      shared.live.tools.map((t) => t.name),
      ['ping', 'pong'],
    );

    setTimeout(() => {
      bundleRow.disabled = true;
    }, 1400);
    const toggled = await request('POST', '/toggle', { id: 'mcp-shared', enabled: false });
    assert.equal(toggled.status, 200);
    assert.equal(toggled.body.state.servers.find((s) => s.serverName === 'shared').enabled, false);
    assert.match(readFileSync(patchPath, 'utf8'), /- id: mcp-shared\n  disabled: true/);

    const remove = await request('POST', '/remove', { id: 'mcp-shared' });
    assert.equal(remove.status, 400);
    assert.match(remove.body.error, /不能删除|只能停用/);
  } finally {
    for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importing an mcpServers document adds each entry', async () => {
  const app = await boot('# header\n[]\n');
  try {
    const result = await app.request('POST', '/import', {
      json: JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
          'web-http': { url: 'http://localhost:3000/mcp', headers: { Authorization: 'Bearer t' } },
        },
      }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.created.sort(), ['github', 'web-http']);

    const listing = await app.request('GET', '/servers');
    const byName = Object.fromEntries(listing.body.servers.map((s) => [s.serverName, s]));
    assert.equal(byName.github.transport, 'stdio');
    assert.equal(byName['web-http'].transport, 'streamable-http');
    assert.equal(byName['web-http'].url, 'http://localhost:3000/mcp');
  } finally {
    app.dispose();
  }
});

test('re-importing an existing server updates it instead of failing', async () => {
  const app = await boot();
  try {
    const result = await app.request('POST', '/import', {
      json: JSON.stringify({
        mcpServers: { dbx: { command: 'node3.exe', args: ['new.js'] } },
      }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.updated, ['dbx']);
    assert.deepEqual(result.body.created, []);
    const row = app.parse()[0].insert[0];
    assert.equal(row.id, 'mcp-dbx', 'the edit keeps the row id');
    assert.equal(row.config.command, 'node3.exe');
    assert.deepEqual(row.config.args, ['new.js']);
  } finally {
    app.dispose();
  }
});

test('importing rejects a malformed document with an actionable message', async () => {
  const app = await boot('# header\n[]\n');
  try {
    const bad = await app.request('POST', '/import', { json: '{ not json' });
    assert.equal(bad.status, 400);
    // The message names the position the parser choked on, and says "配置"
    // rather than "JSON" because a TOML paste is a supported input too.
    assert.match(bad.body.error, /配置解析失败/);
    assert.match(bad.body.error, /position|line/u);

    const empty = await app.request('POST', '/import', { json: '{"mcpServers":{}}' });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /未在配置中找到/);
  } finally {
    app.dispose();
  }
});

test('validation rejects an invalid server name and a duplicate', async () => {
  const app = await boot();
  try {
    const bad = await app.request('POST', '/save', { serverName: 'has space', transport: 'stdio', command: 'npx' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /服务名/);

    const dup = await app.request('POST', '/save', { serverName: 'dbx', transport: 'stdio', command: 'npx' });
    assert.equal(dup.status, 400);
    assert.match(dup.body.error, /已存在/);
  } finally {
    app.dispose();
  }
});

test('lang=en asks the host for English messages', async () => {
  const app = await boot();
  try {
    const bad = await app.request('POST', '/save?lang=en', { serverName: 'dbx', transport: 'stdio', command: 'npx' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /already exists/u);

    const saved = await app.request('POST', '/save?lang=en', {
      serverName: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    });
    assert.equal(saved.status, 200);
    const imported = await app.request('POST', '/import?lang=en', {
      json: JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'x'] } } }),
    });
    assert.equal(imported.status, 200);
    assert.match(imported.body.message, /Recognized .* configuration; Updated github/u);

    const unknown = await app.request('GET', '/nope?lang=en');
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error, /Unknown endpoint/u);
  } finally {
    app.dispose();
  }
});

test('the default language stays Chinese when no lang is asked for', async () => {
  const app = await boot();
  try {
    const unknown = await app.request('GET', '/nope');
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error, /未知接口/u);
  } finally {
    app.dispose();
  }
});

test('a save never leaves the document unparseable, even under odd input', async () => {
  const app = await boot();
  try {
    const cases = [
      { serverName: 'a', transport: 'stdio', command: 'npx', args: ['x', '', 'y'] },
      { serverName: 'b', transport: 'streamable-http', url: 'http://x/mcp', headers: { A: '1', B: '2' } },
      { serverName: 'c', transport: 'stdio', command: 'npx', env: { 'WEIRD KEY': 'v' } },
    ];
    for (const body of cases) {
      const result = await app.request('POST', '/save', body);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(yaml.load(app.read(), { schema }) instanceof Array, true);
    }
  } finally {
    app.dispose();
  }
});

test('the reported patch path follows the loader include entry', async () => {
  const app = await boot();
  try {
    const { body } = await app.request('GET', '/servers');
    assert.equal(body.patchPath, app.patchPath);
    assert.equal(body.profileDir, app.dir);
  } finally {
    app.dispose();
  }
});

test('a read-only patch file is reported instead of failing on write', async () => {
  const app = await boot();
  try {
    const { body } = await app.request('GET', '/servers');
    assert.equal(body.writable, true);
  } finally {
    app.dispose();
  }
});
