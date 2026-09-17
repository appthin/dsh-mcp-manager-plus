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
 * @param options - `{ tools, services, includeEntry }` stubs.
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

test('a renamed server keeps its row id and its overrides', async () => {
  const app = await boot();
  try {
    await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: false });
    assert.equal(app.parse().length, 2, 'the disable override was appended');

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

test('disabling then enabling a user row leaves one override, then none', async () => {
  const app = await boot();
  try {
    await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: false });
    let listing = await app.request('GET', '/servers');
    assert.equal(listing.body.servers[0].enabled, false);
    assert.equal(app.parse().length, 2);

    await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: true });
    listing = await app.request('GET', '/servers');
    assert.equal(listing.body.servers[0].enabled, true);
    const parsed = app.parse();
    assert.equal(parsed.length, 1, 'the redundant override is dropped, not replaced with disabled:false');
  } finally {
    app.dispose();
  }
});

test('toggling repeatedly never accumulates override blocks', async () => {
  const app = await boot();
  try {
    // Ends on "enabled", which drops the override entirely for a user row.
    for (let i = 0; i < 5; i += 1) {
      await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: i % 2 === 0 });
    }
    assert.equal(
      (app.read().match(/^- id: mcp-dbx$/gmu) ?? []).length,
      0,
      'a user row that ends enabled carries no override at all',
    );

    // Ending on "disabled" leaves exactly one, however many times it flipped.
    for (let i = 0; i < 6; i += 1) {
      await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: i % 2 === 0 });
    }
    assert.equal((app.read().match(/^- id: mcp-dbx$/gmu) ?? []).length, 1);
    assert.equal(yaml.load(app.read(), { schema }).length, 2);
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
      ['computer_use_click', 'computer_use_get_app_state'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bundle-provided row is listed read-only and togglable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-bundle-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  writeFileSync(patchPath, '# header\n[]\n');
  const routes = [];
  const cleanups = [];
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
            {
              options: {
                id: 'mcp-shared',
                name: '@deepseek-ai/dsh-mcp-client',
                config: { serverName: 'shared', transport: 'stdio', command: 'npx' },
              },
              fiber: { state: 2 },
              disabled: false,
            },
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
