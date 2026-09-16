/**
 * End-to-end import check against a real host: boot the plugin's `apply()`
 * with a fake Cordis context, POST each tool's documented configuration to
 * `/import`, and confirm the servers land in the patch file in this plugin's
 * own shape.
 *
 * Run with:  node tools/e2e-import.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { apply, name, inject } = await import('../lib/index.js');

const realHome = process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh') : null;
if (realHome === null) throw new Error('USERPROFILE is not set; cannot locate the profile that ships js-yaml');

const home = mkdtempSync(join(tmpdir(), 'mcpmp-e2e-'));
const profileDir = join(home, 'profiles', 'web');
mkdirSync(profileDir, { recursive: true });
const patchPath = join(profileDir, 'cordis.patch.yml');
writeFileSync(patchPath, '[]\n');
// `js-yaml` is resolved from the profile rather than bundled with the plugin,
// so the scratch profile needs a packages directory that can resolve it. A
// plain directory symlink is enough — the resolver walks up from the anchor.
try {
  symlinkSync(join(realHome, 'profiles', 'node_modules'), join(home, 'profiles', 'node_modules'), 'junction');
} catch (error) {
  throw new Error(`could not link the real profile's node_modules for js-yaml: ${error.message}`);
}
process.env.DSH_HOME = home;

/** A minimal Cordis context: one route, one effect, one cached loader. */
function makeContext() {
  let handler = null;
  const webServer = {
    register(route) {
      handler = route.handler;
      return () => {};
    },
  };
  const ctx = {
    // `webServer` is a DECLARED dependency, so the plugin reads it as a
    // property; `get()` is only for optional lookups.
    webServer,
    get(key) {
      if (key === 'loader') {
        return {
          entries: () => [],
          // The patch path is derived from the loader's include entry; with none
          // present the plugin falls back to the profile's own patch file.
          internal: { resolveSync: () => ({ url: '' }) },
        };
      }
      return undefined;
    },
    effect(factory) {
      const dispose = factory();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };
  apply(ctx);
  return {
    async request(method, path, body) {
      const chunks = [];
      const req = {
        method,
        url: `/mcp-manager-plus${path}`,
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
          for (const chunk of chunks) yield chunk;
        },
      };
      let status = 0;
      let text = '';
      const res = {
        writeHead(code) { status = code; },
        end(payload) { if (payload !== undefined) text += payload; },
      };
      await handler(req, res);
      return { status, body: text === '' ? null : JSON.parse(text) };
    },
  };
}

const app = makeContext();
const servers = {};

// One fixture per tool, each in that tool's own documented shape.
const fixtures = {
  'Claude Code': JSON.stringify({
    mcpServers: { 'cc-github': { command: 'npx', args: ['-y', 'pkg'], env: { GITHUB_TOKEN: 'x' } } },
  }),
  Cursor: JSON.stringify({
    mcpServers: { 'cursor-http': { url: 'https://cur.example.com/mcp', headers: { 'X-Key': 'k' } } },
  }),
  'VS Code': JSON.stringify({
    servers: {
      'vscode-playwright': { command: 'npx', args: ['-y', '@microsoft/mcp-server-playwright'] },
      'vscode-slack': { type: 'http', url: 'https://mcp.slack.com/mcp' },
    },
  }),
  Codex: ['[mcp_servers.codex-brave]', 'command = "docker"', 'args = ["run", "-i", "mcp/brave"]', '', '[mcp_servers.codex-brave.env]', 'BRAVE_API_KEY = "XXXX"'].join('\n'),
  OpenCode: JSON.stringify({
    mcp: {
      'oc-remote': { type: 'remote', url: 'https://jira.example.com/mcp' },
      'oc-local': { type: 'local', command: ['bunx', '@playwright/mcp'] },
    },
  }),
  Continue: JSON.stringify({
    mcpServers: [{ name: 'continue-sqlite', command: 'npx', args: ['-y', 'mcp-sqlite', '/db.sqlite'] }],
  }),
  Pi: JSON.stringify({
    settings: { toolPrefix: 'mcp' },
    mcpServers: { 'pi-fs': { command: 'npx', args: ['-y', 'fs-server', '/ws'], transport: 'stdio' } },
  }),
  'Cherry Studio': JSON.stringify({
    mcpServers: { 'cherry-fs': { type: 'stdio', command: 'npx', args: ['-y', 'fs'] } },
  }),
  Windsurf: JSON.stringify({
    mcpServers: { 'windsurf-remote': { serverUrl: 'https://w.example.com/mcp', headers: { API_KEY: 'k' } } },
  }),
  Qoder: JSON.stringify({ mcpServers: { 'qoder-github': { command: 'npx', args: ['-y', 'gh'] } } }),
  CodeBuddy: JSON.stringify({
    mcpServers: { 'cb-sse': { type: 'sse', url: 'https://api.example.com/sse', headers: { 'X-API-Key': 'k' } } },
  }),
  TRAE: JSON.stringify({ mcpServers: { 'trae-py': { type: 'stdio', command: 'python', args: ['-m', 'srv'] } } }),
  ZCode: JSON.stringify({ mcpServers: { 'zcode-x': { type: 'stdio', command: 'uvx', args: ['mcp-x'] } } }),
  'DeepSeek Harness': JSON.stringify({
    mcpServers: { 'dsh-native': { transport: 'streamable-http', url: 'https://dsh.example.com/mcp' } },
  }),
};

let failures = 0;
for (const [tool, payload] of Object.entries(fixtures)) {
  const result = await app.request('POST', '/import', { json: payload });
  if (result.status !== 200) {
    console.log(`FAIL ${tool.padEnd(20)} status=${result.status} ${result.body?.error ?? ''}`);
    failures += 1;
    continue;
  }
  for (const created of result.body.created) servers[created] = tool;
  console.log(`ok   ${tool.padEnd(20)} -> ${result.body.message}`);
}

// Confirm what was actually written is this plugin's own shape. Values are
// quoted by the emitter, so the patterns tolerate the surrounding quotes.
const written = readFileSync(patchPath, 'utf8');
console.log(`\ncreated ${Object.keys(servers).length} servers, patch file ${written.length} bytes`);

const q = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const checks = [
  ['cc-github', new RegExp(`serverName:\\s*"?cc-github"?`), 'named stdio row'],
  ['cc-github', /transport:\s*"?stdio"?/, 'stdio transport'],
  ['cursor-http', /transport:\s*"?streamable-http"?/, 'remote transport'],
  ['cursor-http', /cur\.example\.com\/mcp/, 'remote url'],
  ['vscode-slack', /serverName:\s*"?vscode-slack"?/, 'VS Code servers container'],
  ['vscode-slack', /mcp\.slack\.com\/mcp/, 'VS Code http entry'],
  ['codex-brave', /BRAVE_API_KEY/, 'env from a nested TOML table'],
  ['codex-brave', /"\s*run",?\s*$/m, 'args split from TOML array'],
  ['oc-local', /@playwright\/mcp/, 'array command split into args'],
  ['oc-local', /command:\s*"?bunx"?/, 'array command head'],
  ['continue-sqlite', /serverName:\s*"?continue-sqlite"?/, 'Continue array form'],
  ['pi-fs', /serverName:\s*"?pi-fs"?/, 'Pi settings block ignored'],
  ['windsurf-remote', /w\.example\.com\/mcp/, 'serverUrl read'],
  ['cb-sse', /api\.example\.com\/sse/, 'sse mapped to remote'],
  ['trae-py', /command:\s*"?python"?/, 'TRAE python server'],
  ['zcode-x', /command:\s*"?uvx"?/, 'ZCode uvx server'],
  ['dsh-native', /dsh\.example\.com\/mcp/, 'native Harness config'],
];
for (const [id, pattern, why] of checks) {
  const ok = pattern.test(written);
  if (!ok) { failures += 1; console.log(`FAIL ${id}: missing ${why} (${pattern})`); }
  else console.log(`ok   ${id.padEnd(20)} ${why}`);
}

// Every row must use this plugin's own loader shape.
const rowCount = (written.match(/id:\s*"?mcp-/g) ?? []).length;
const clientRows = (written.match(/@deepseek-ai\/dsh-mcp-client/g) ?? []).length;
if (rowCount !== clientRows) { failures += 1; console.log(`FAIL ${rowCount} rows but ${clientRows} mcp-client names`); }
else console.log(`ok   all ${rowCount} rows use @deepseek-ai/dsh-mcp-client`);

// No unexpected config key should have leaked into a written row. Keys sit at
// 8-space indent inside `config:`; `name`/`id` belong to the loader row above.
const allowed = new Set(['serverName', 'transport', 'command', 'args', 'env', 'cwd', 'url', 'headers']);
const strayKeys = [...written.matchAll(/^ {8}([A-Za-z_][A-Za-z0-9_]*):/gm)]
  .map((m) => m[1])
  .filter((k) => !allowed.has(k));
if (strayKeys.length > 0) { failures += 1; console.log(`FAIL unknown config keys written: ${[...new Set(strayKeys)].join(', ')}`); }
else console.log('ok   no unexpected config keys');

rmSync(home, { recursive: true, force: true });
console.log(`\nplugin: ${name} inject=${JSON.stringify(inject)}`);
console.log(failures === 0 ? 'ALL OK' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
