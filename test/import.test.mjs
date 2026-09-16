/**
 * Import-parser check: every supported tool's documented configuration shape
 * must reduce to the same normalized server list.
 *
 * The fixtures below are the shapes those tools actually ship, because the
 * whole point of the parser is that a user pastes what their other tool gave
 * them and it simply works.
 *
 * Run with:  node test/import.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeDocument,
  looksLikeToml,
  normalizeEntry,
  parseMcpConfig,
  parseToml,
  stripJsonNoise,
} from '../lib/import.js';

/** The one server a fixture describes, for terse assertions. */
function only(input) {
  const { servers } = parseMcpConfig(input);
  assert.equal(servers.length, 1, 'the fixture must describe exactly one server');
  return servers[0];
}

// ── the standard `mcpServers` family ────────────────────────────────────────

test('Claude Code / Cursor / Windsurf / Qoder stdio config parses', () => {
  const server = only(
    JSON.stringify({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' },
        },
      },
    }),
  );
  assert.equal(server.serverName, 'github');
  assert.equal(server.transport, 'stdio');
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.deepEqual(server.env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' });
});

test('a standard remote config maps onto streamable HTTP', () => {
  const server = only(
    JSON.stringify({
      mcpServers: {
        remote: { url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer t' } },
      },
    }),
  );
  assert.equal(server.transport, 'streamable-http');
  assert.equal(server.url, 'https://api.example.com/mcp');
  assert.deepEqual(server.headers, { Authorization: 'Bearer t' });
});

test('Windsurf remote form uses serverUrl, which still reads as remote', () => {
  const server = only(
    JSON.stringify({
      mcpServers: { remote: { serverUrl: 'https://x.example.com/mcp', headers: { API_KEY: 'k' } } },
    }),
  );
  assert.equal(server.transport, 'streamable-http');
  assert.equal(server.url, 'https://x.example.com/mcp');
});

test('Cherry Studio style config with a type field parses', () => {
  const server = only(
    JSON.stringify({
      mcpServers: {
        filesystem: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
      },
    }),
  );
  assert.equal(server.transport, 'stdio');
  assert.equal(server.command, 'npx');
  assert.equal(server.args.length, 3);
});

test('CodeBuddy SSE config is accepted as a remote server', () => {
  const server = only(
    JSON.stringify({
      mcpServers: { sse: { type: 'sse', url: 'https://api.example.com/sse', headers: { 'X-API-Key': 'k' } } },
    }),
  );
  assert.equal(server.transport, 'streamable-http');
  assert.equal(server.url, 'https://api.example.com/sse');
});

test('ZCode / TRAE style config with a description passes through', () => {
  const server = only(
    JSON.stringify({
      mcpServers: {
        'python-tools': {
          type: 'stdio',
          command: 'python',
          args: ['-m', 'my_mcp_server'],
          env: { PYTHONPATH: '/tools' },
          description: 'Python toolset',
        },
      },
    }),
  );
  assert.equal(server.serverName, 'python-tools');
  assert.equal(server.command, 'python');
});

// ── VS Code ────────────────────────────────────────────────────────────────

test('VS Code uses `servers`, and its type:"http" entry is remote', () => {
  const { servers, source } = parseMcpConfig(
    JSON.stringify({
      servers: {
        slack: { type: 'http', url: 'https://mcp.slack.com/mcp' },
        playwright: { command: 'npx', args: ['-y', '@microsoft/mcp-server-playwright'] },
      },
    }),
  );
  assert.equal(source, 'VS Code');
  assert.equal(servers.length, 2);
  const slack = servers.find((s) => s.serverName === 'slack');
  const playwright = servers.find((s) => s.serverName === 'playwright');
  assert.equal(slack.transport, 'streamable-http');
  assert.equal(slack.url, 'https://mcp.slack.com/mcp');
  assert.equal(playwright.transport, 'stdio');
  assert.equal(playwright.command, 'npx');
});

// ── Codex (TOML) ───────────────────────────────────────────────────────────

test('a Codex config.toml paste is detected as TOML', () => {
  assert.equal(looksLikeToml('[mcp_servers.brave]\ncommand = "docker"\n'), true);
  assert.equal(looksLikeToml('{"mcpServers":{}}'), false);
});

test('Codex TOML with args, env and a nested env table parses', () => {
  const toml = [
    '[mcp_servers.brave-search]',
    'command = "docker"',
    'args = ["run", "-i", "--rm", "mcp/brave-search"]',
    '',
    '[mcp_servers.brave-search.env]',
    'BRAVE_API_KEY = "XXXX"',
  ].join('\n');

  const server = only(toml);
  assert.equal(server.serverName, 'brave-search');
  assert.equal(server.transport, 'stdio');
  assert.equal(server.command, 'docker');
  assert.deepEqual(server.args, ['run', '-i', '--rm', 'mcp/brave-search']);
  assert.deepEqual(server.env, { BRAVE_API_KEY: 'XXXX' });
});

test('Codex TOML names the dialect in the reported source', () => {
  const parsed = parseMcpConfig('[mcp_servers.x]\ncommand = "uvx"\n');
  assert.equal(parsed.source, 'Codex');
});

test('the older camelCase mcpServers TOML table also parses', () => {
  const server = only('[mcpServers.zen]\ncommand = "npx"\nargs = ["zen-mcp-server"]\n');
  assert.equal(server.serverName, 'zen');
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['zen-mcp-server']);
});

test('TOML comments and quoted keys survive', () => {
  const toml = ['# a comment', '[mcp_servers."@21st-dev/magic"]', 'command = "npx" # trailing'].join('\n');
  const server = only(toml);
  assert.equal(server.serverName, '@21st-dev/magic');
  assert.equal(server.command, 'npx');
});

// ── OpenCode ───────────────────────────────────────────────────────────────

test('OpenCode remote form uses type:"remote" under the `mcp` key', () => {
  const { servers, source } = parseMcpConfig(
    JSON.stringify({ mcp: { jira: { type: 'remote', url: 'https://jira.example.com/mcp', enabled: false } } }),
  );
  assert.equal(source, 'OpenCode');
  assert.equal(servers[0].transport, 'streamable-http');
  assert.equal(servers[0].url, 'https://jira.example.com/mcp');
});

test('an OpenCode local command ARRAY splits into command plus args', () => {
  const server = only(
    JSON.stringify({ mcp: { playwright: { type: 'local', command: ['bunx', '@playwright/mcp'] } } }),
  );
  assert.equal(server.transport, 'stdio');
  assert.equal(server.command, 'bunx');
  assert.deepEqual(server.args, ['@playwright/mcp']);
});

test('OpenCode v2 nesting under mcp.servers parses', () => {
  const server = only(JSON.stringify({ mcp: { servers: { x: { type: 'local', command: ['npx', 'pkg'] } } } }));
  assert.equal(server.serverName, 'x');
  assert.equal(server.command, 'npx');
});

// ── Continue ───────────────────────────────────────────────────────────────

test('Continue array form takes its name from the entry', () => {
  const { servers, source } = parseMcpConfig(
    JSON.stringify({
      mcpServers: [{ name: 'SQLite MCP', command: 'npx', args: ['-y', 'mcp-sqlite', '/db.sqlite'] }],
    }),
  );
  assert.equal(source, 'Continue');
  assert.equal(servers[0].serverName, 'SQLite MCP');
  assert.equal(servers[0].command, 'npx');
  assert.deepEqual(servers[0].args, ['-y', 'mcp-sqlite', '/db.sqlite']);
});

// ── Pi ─────────────────────────────────────────────────────────────────────

test('Pi config with a settings block ignores settings and reads transport', () => {
  const { servers } = parseMcpConfig(
    JSON.stringify({
      settings: { toolPrefix: 'mcp', requestTimeoutMs: 30000 },
      mcpServers: {
        supabase: { transport: 'streamable-http', url: 'https://mcp.supabase.com/mcp', lifecycle: 'eager' },
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
          transport: 'stdio',
          env: { NODE_ENV: 'production' },
        },
      },
    }),
  );
  assert.equal(servers.length, 2);
  const supabase = servers.find((s) => s.serverName === 'supabase');
  const filesystem = servers.find((s) => s.serverName === 'filesystem');
  assert.equal(supabase.transport, 'streamable-http');
  assert.deepEqual(filesystem.env, { NODE_ENV: 'production' });
});

// ── lenient JSON ───────────────────────────────────────────────────────────

test('comments and trailing commas are tolerated (documented examples carry them)', () => {
  const text = `{
    // MCP servers for this project
    "mcpServers": {
      /* the filesystem server */
      "fs": {
        "command": "npx",
        "args": ["-y", "pkg",],
      },
    },
  }`;
  const server = only(text);
  assert.equal(server.serverName, 'fs');
  assert.deepEqual(server.args, ['-y', 'pkg']);
});

test('a // inside a string is not mistaken for a comment', () => {
  const server = only(JSON.stringify({ mcpServers: { x: { url: 'https://a.example.com//mcp' } } }));
  assert.equal(server.url, 'https://a.example.com//mcp');
});

test('stripJsonNoise leaves string contents alone', () => {
  assert.equal(stripJsonNoise('{"a":"b//c"}'), '{"a":"b//c"}');
  assert.equal(stripJsonNoise('{"a":1,}'), '{"a":1}');
});

// ── a bare single-server snippet ───────────────────────────────────────────

test('a snippet with no container key is read as the server map itself', () => {
  const { servers, source } = parseMcpConfig(
    JSON.stringify({ myserver: { command: 'uvx', args: ['mcp-server'] } }),
  );
  assert.equal(source, '单服务器片段');
  assert.equal(servers[0].serverName, 'myserver');
});

// ── failures are actionable ────────────────────────────────────────────────

test('an empty document is refused with a clear message', () => {
  assert.throws(() => parseMcpConfig('   '), /配置内容为空/);
});

test('a document with no server-looking entries is refused', () => {
  assert.throws(() => parseMcpConfig(JSON.stringify({ mcpServers: { a: { nope: 1 } } })), /未在配置中找到任何 MCP 服务器条目/);
});

test('malformed JSON reports a parse failure rather than crashing', () => {
  assert.throws(() => parseMcpConfig('{"mcpServers": '), /配置解析失败/);
});

test('a TOML typo names the offending line', () => {
  assert.throws(() => parseToml('[mcp_servers.x]\ncommand "npx"\n'), /TOML 第 2 行/);
});

// ── directly asserted helpers ──────────────────────────────────────────────

test('normalizeEntry prefers a declared stdio type when both fields exist', () => {
  const entry = normalizeEntry({ type: 'stdio', command: 'npx', url: 'https://ignored.example.com' });
  assert.equal(entry.transport, 'stdio');
  assert.equal(entry.command, 'npx');
});

test('normalizeEntry reads Codex http_headers', () => {
  const entry = normalizeEntry({ url: 'https://x/mcp', http_headers: { Authorization: 'Bearer t' } });
  assert.equal(entry.transport, 'streamable-http');
  assert.deepEqual(entry.headers, { Authorization: 'Bearer t' });
});

test('non-string env values are stringified rather than dropped silently', () => {
  const entry = normalizeEntry({ command: 'x', env: { PORT: 8080, DEBUG: true, nested: { a: 1 } } });
  assert.equal(entry.env.PORT, '8080');
  assert.equal(entry.env.DEBUG, 'true');
  assert.equal(entry.env.nested, undefined);
});

test('decodeDocument accepts an already-decoded object', () => {
  assert.deepEqual(decodeDocument({ mcpServers: {} }), { mcpServers: {} });
});
