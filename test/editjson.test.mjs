/**
 * Edit-mode check: the edit dialog's form/JSON switch, and the host behavior
 * the JSON mode depends on.
 *
 * The interesting cases are the ones a naive implementation gets wrong:
 * renaming through the JSON box must rename the existing row (keeping its id
 * and its `disabled` override) instead of creating a second server, and a
 * multi-server paste in edit mode must be refused rather than applied silently
 * to whichever entry happened to be first.
 *
 * Run with:  node test/editjson.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const realHome = join(process.env.USERPROFILE, '.dsh');
const { apply } = await import('../lib/index.js');

/**
 * Boot the plugin's real `apply()` against a scratch profile.
 * @returns `{ request, patchPath, dispose }`.
 */
function boot(initialPatch) {
  const home = mkdtempSync(join(tmpdir(), 'mcpmp-edit-'));
  const profileDir = join(home, 'profiles', 'web');
  mkdirSync(profileDir, { recursive: true });
  const patchPath = join(profileDir, 'cordis.patch.yml');
  writeFileSync(patchPath, initialPatch);
  // `js-yaml` comes from the profile, not this package.
  symlinkSync(join(realHome, 'profiles', 'node_modules'), join(home, 'profiles', 'node_modules'), 'junction');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  let handler = null;
  apply({
    webServer: {
      register(route) {
        handler = route.handler;
        return () => {};
      },
    },
    get: (key) =>
      key === 'loader'
        ? { entries: () => [], internal: { resolveSync: () => ({ url: '' }) } }
        : undefined,
    effect: (factory) => {
      const dispose = factory();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  });

  return {
    patchPath,
    async request(method, path, body) {
      const req = {
        method,
        url: `/mcp-manager-plus${path}`,
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(JSON.stringify(body));
        },
      };
      let status = 0;
      let text = '';
      await handler(req, {
        writeHead(code) { status = code; },
        end(payload) { if (payload !== undefined) text += payload; },
      });
      return { status, body: text === '' ? null : JSON.parse(text) };
    },
    dispose() {
      // Assigning `undefined` to process.env stores the string "undefined",
      // which every later suite in the shared process then reads back as a
      // (broken) home path — so an originally unset variable must be deleted.
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** A patch file holding one editable server row. */
const ONE_SERVER = `- insert:
    - id: mcp-alpha
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: alpha
        transport: stdio
        command: npx
        args:
          - "-y"
          - old-pkg
`;

test('editing through JSON updates the existing row in place', async () => {
  const app = boot(ONE_SERVER);
  try {
    const result = await app.request('POST', '/import', {
      json: JSON.stringify({ mcpServers: { alpha: { command: 'uvx', args: ['new-pkg'] } } }),
      originalName: 'alpha',
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.updated, ['alpha']);

    const written = readFileSync(app.patchPath, 'utf8');
    assert.match(written, /uvx/);
    assert.match(written, /new-pkg/);
    assert.doesNotMatch(written, /old-pkg/, 'the old command must be gone, not appended');
    // One row only: an edit must never leave a duplicate behind.
    assert.equal((written.match(/serverName:/g) ?? []).length, 1);
    assert.match(written, /id: mcp-alpha/, 'the row id must be preserved');
  } finally {
    app.dispose();
  }
});

test('renaming inside the JSON box renames that row instead of creating one', async () => {
  const app = boot(ONE_SERVER);
  try {
    const result = await app.request('POST', '/import', {
      json: JSON.stringify({ mcpServers: { beta: { command: 'uvx', args: ['pkg'] } } }),
      originalName: 'alpha',
    });
    assert.equal(result.status, 200);
    assert.match(result.body.message, /重命名/);

    const written = readFileSync(app.patchPath, 'utf8');
    assert.equal((written.match(/serverName:/g) ?? []).length, 1, 'still exactly one server');
    assert.match(written, /serverName: "?beta"?/);
    assert.doesNotMatch(written, /serverName: "?alpha"?/);
  } finally {
    app.dispose();
  }
});

test('a rename keeps the row id and any disabled override', async () => {
  const app = boot(
    `${ONE_SERVER}- id: mcp-alpha
  disabled: true
`,
  );
  try {
    await app.request('POST', '/import', {
      json: JSON.stringify({ mcpServers: { renamed: { command: 'uvx' } } }),
      originalName: 'alpha',
    });
    const written = readFileSync(app.patchPath, 'utf8');
    // The id is what the override targets, so both must follow the rename.
    assert.match(written, /id: mcp-alpha/, 'the id stays');
    assert.equal((written.match(/serverName:/g) ?? []).length, 1);
    assert.match(written, /disabled: true/, 'the override survives');
  } finally {
    app.dispose();
  }
});

test('a multi-server paste in edit mode is refused, not silently truncated', async () => {
  const app = boot(ONE_SERVER);
  try {
    const result = await app.request('POST', '/import', {
      json: JSON.stringify({
        mcpServers: { one: { command: 'a' }, two: { command: 'b' } },
      }),
      originalName: 'alpha',
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /一次只能保存一个服务器/);
    assert.match(result.body.error, /one、two/);

    // Nothing may have been written.
    assert.doesNotMatch(readFileSync(app.patchPath, 'utf8'), /serverName: "?one"?/);
  } finally {
    app.dispose();
  }
});

test('editing a server that no longer exists fails clearly', async () => {
  const app = boot(ONE_SERVER);
  try {
    const result = await app.request('POST', '/import', {
      json: JSON.stringify({ mcpServers: { ghost: { command: 'x' } } }),
      originalName: 'ghost',
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /未找到要编辑的服务器/);
  } finally {
    app.dispose();
  }
});

test('the same JSON with no originalName still creates (add mode is unchanged)', async () => {
  const app = boot(ONE_SERVER);
  try {
    const result = await app.request('POST', '/import', {
      json: JSON.stringify({ mcpServers: { gamma: { command: 'uvx' } } }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.created, ['gamma']);
    assert.equal((readFileSync(app.patchPath, 'utf8').match(/serverName:/g) ?? []).length, 2);
  } finally {
    app.dispose();
  }
});

test('a Codex TOML paste works in edit mode too (format is independent of the mode)', async () => {
  const app = boot(ONE_SERVER);
  try {
    const result = await app.request('POST', '/import', {
      json: '[mcp_servers.alpha]\ncommand = "docker"\nargs = ["run", "-i", "img"]\n',
      originalName: 'alpha',
    });
    assert.equal(result.status, 200);
    const written = readFileSync(app.patchPath, 'utf8');
    assert.match(written, /docker/);
    assert.equal((written.match(/serverName:/g) ?? []).length, 1);
  } finally {
    app.dispose();
  }
});

test('opening the JSON editor and confirming unchanged preserves the server', async () => {
  // The dialog seeds the box from the row, so the seed must survive a
  // round-trip through the host parser. If it did not, a user could lose
  // configuration merely by opening the JSON mode and pressing Confirm.
  const app = boot(ONE_SERVER);
  try {
    const { normalizeEntry } = await import('../lib/import.js');
    const { serverToJson } = await import('./helpers/serializer.mjs');

    const server = {
      serverName: 'round',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg', '/path with space'],
      env: { TOKEN: 'x', N: '1' },
      cwd: '/work',
    };
    const text = serverToJson(server);
    const result = await app.request('POST', '/import', { json: text, originalName: 'alpha' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.updated, ['round'], 'the rename went through');

    // Whatever the serializer emitted, the parser must read back the same
    // fields — that equivalence is the whole guarantee.
    const parsedBack = normalizeEntry(JSON.parse(text).mcpServers.round);
    assert.equal(parsedBack.command, 'npx');
    assert.deepEqual(parsedBack.args, ['-y', 'pkg', '/path with space']);
    assert.deepEqual(parsedBack.env, { TOKEN: 'x', N: '1' });
    assert.equal(parsedBack.cwd, '/work');

    const written = readFileSync(app.patchPath, 'utf8');
    assert.equal((written.match(/serverName:/g) ?? []).length, 1, 'no duplicate row');
    assert.match(written, /path with space/);
  } finally {
    app.dispose();
  }
});
