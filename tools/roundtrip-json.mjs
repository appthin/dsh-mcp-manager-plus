/**
 * Round-trip check: the JSON the edit dialog seeds must be accepted by the
 * host parser unchanged.
 *
 * The dialog serializes a server row into `mcpServers` text, and the host
 * parses that text back into the same row. If those two ever disagree — a
 * field the serializer emits that the parser ignores, or vice versa — the user
 * would open the JSON editor and lose configuration by pressing Confirm
 * without editing anything. This test is that guarantee.
 *
 * Run with:  node tools/roundtrip-json.mjs
 */
import { normalizeEntry } from '../lib/import.js';
// The real serializer, lifted from the bundle — see the helper for why.
import { serverToJson } from '../test/helpers/serializer.mjs';

/** Compare only the fields this plugin models; the rest are not its business. */
function canonical(server) {
  const http = server.transport === 'streamable-http';
  const out = { serverName: server.serverName, transport: http ? 'streamable-http' : 'stdio' };
  if (http) {
    out.url = server.url ?? '';
    if (server.headers && Object.keys(server.headers).length > 0) out.headers = server.headers;
  } else {
    out.command = server.command ?? '';
    if (server.args && server.args.length > 0) out.args = server.args;
    if (server.env && Object.keys(server.env).length > 0) out.env = server.env;
    if (server.cwd) out.cwd = server.cwd;
  }
  return out;
}

const cases = [
  { serverName: 'stdio-full', transport: 'stdio', command: 'npx', args: ['-y', 'pkg', '/path with space'], env: { TOKEN: 'x', N: '1' }, cwd: '/work' },
  { serverName: 'stdio-min', transport: 'stdio', command: 'uvx' },
  { serverName: 'http-full', transport: 'streamable-http', url: 'https://a.example.com/mcp', headers: { Authorization: 'Bearer t' } },
  { serverName: 'http-min', transport: 'streamable-http', url: 'http://localhost:3000/mcp' },
  { serverName: 'dotted.name', transport: 'stdio', command: 'node', args: ['./srv.js'] },
  { serverName: 'with ünicode', transport: 'stdio', command: 'x', env: { 'KEY ONE': 'v' } },
];

let failures = 0;
for (const original of cases) {
  const text = serverToJson(original);
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    console.log(`FAIL ${original.serverName}: serializer produced invalid JSON — ${error.message}`);
    failures += 1;
    continue;
  }

  const names = Object.keys(decoded.mcpServers ?? {});
  if (names.length !== 1 || names[0] !== original.serverName) {
    console.log(`FAIL ${original.serverName}: serialized under ${JSON.stringify(names)}`);
    failures += 1;
    continue;
  }

  const parsed = normalizeEntry(decoded.mcpServers[names[0]]);
  const before = canonical(original);
  const after = canonical({ ...parsed, serverName: names[0] });
  const same = JSON.stringify(before) === JSON.stringify(after);
  if (!same) {
    console.log(`FAIL ${original.serverName}:\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`);
    failures += 1;
    continue;
  }
  console.log(`ok   ${original.serverName.padEnd(16)} round-trips unchanged`);
}

console.log(failures === 0 ? '\nALL OK: seed JSON survives a Confirm with no edits' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
