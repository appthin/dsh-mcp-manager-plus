/**
 * Parsing pasted MCP configuration from other tools into this plugin's own
 * server shape.
 *
 * Every tool in the ecosystem ships the same idea — a named map of servers,
 * each either a local command or a remote URL — under a different wrapper,
 * different key names, and sometimes a different file syntax. This module
 * absorbs that variety so the settings page can accept a paste from any of
 * them without the user reformatting anything.
 *
 * The shapes handled, and their tell-tale keys:
 *
 * | Source                                   | Container       | stdio                       | remote                          |
 * | ---------------------------------------- | --------------- | --------------------------- | ------------------------------- |
 * | Claude Code, Cursor, Windsurf, Qoder,    | `mcpServers`    | `command`/`args`            | `url`/`headers`                 |
 * | CodeBuddy, TRAE, Cherry Studio, ZCode    |                 |                             |                                 |
 * | DeepSeek Harness (this plugin)           | `mcpServers`    | `command`/`args`            | `url`/`headers`                 |
 * | VS Code                                  | `servers`       | `command`/`args`            | `type:"http"` + `url`           |
 * | Codex                                    | `mcp_servers`   | `command`/`args`            | `url`                           |
 * | OpenCode                                 | `mcp`           | `type:"local"`, command LIST | `type:"remote"` + `url`         |
 * | Continue                                 | `mcpServers` ARRAY with `name`                            | —                               |
 * | Pi                                       | `mcpServers` + `settings` | `command`/`args`  | `transport:"streamable-http"`   |
 *
 * Codex's file is TOML, not JSON, so a TOML document is converted first; the
 * rest arrive as JSON (comments and trailing commas are tolerated, because
 * several tools ship `.jsonc`-style examples).
 *
 * @module dsh-mcp-manager-plus/import
 */

/** Container keys that hold a name → server map, in the order we prefer them. */
const MAP_CONTAINERS = ['mcpServers', 'mcp_servers', 'servers', 'mcp', 'mcpServersList'];

/** Keys that identify a container rather than a server. */
const CONTAINER_KEYS = new Set([...MAP_CONTAINERS, 'settings', 'projects', '$schema']);

/** Transport words meaning "remote HTTP", across every dialect. */
const HTTP_TYPES = new Set(['http', 'streamable-http', 'streamablehttp', 'sse', 'remote', 'streamable_http']);

/** Transport words meaning "local subprocess". */
const STDIO_TYPES = new Set(['stdio', 'local', 'command', 'process']);

/**
 * Strip `//` and `/* *\/` comments plus trailing commas from a JSON-ish
 * document, leaving string contents untouched.
 *
 * Several of these tools document their config with comments, and users paste
 * those examples verbatim, so parsing must tolerate them.
 * @param text - candidate document.
 * @returns the same document with comments and trailing commas removed.
 */
export function stripJsonNoise(text) {
  let out = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    out += ch;
  }
  // Trailing commas: `,` followed only by whitespace and a closer.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Whether a document looks like TOML rather than JSON.
 *
 * A Codex `config.toml` paste carries `[mcp_servers.name]` tables; JSON never
 * opens a line with `[` followed by a bare key.
 * @param text - candidate document.
 * @returns true when the text is better read as TOML.
 */
export function looksLikeToml(text) {
  return /^\s*\[(mcp_servers|mcpServers|servers)\./m.test(text) || /^\s*\[mcp_servers\]/m.test(text);
}

/**
 * Parse the small TOML subset these configs use: `[table.path]` sections with
 * `key = value` pairs, where values are strings, numbers, booleans, or arrays
 * of strings.
 *
 * A full TOML parser is deliberately not pulled in: the input is a
 * configuration file a user pasted, the grammar actually used is tiny, and a
 * dependency here would have to be resolvable from the profile.
 * @param text - TOML document.
 * @returns the parsed object.
 * @throws when a line is not part of that subset.
 */
export function parseToml(text) {
  const root = {};
  let current = root;
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/(^|\s)#.*$/, '').trim();
    if (line === '') continue;

    const table = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (table !== null) {
      const path = table[1].split('.').map((part) => part.trim().replace(/^"|"$/g, ''));
      current = root;
      for (const part of path) {
        if (current[part] === undefined || typeof current[part] !== 'object' || current[part] === null) {
          current[part] = {};
        }
        current = current[part];
      }
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) throw new Error(`TOML 第 ${index + 1} 行无法解析：${line}`);
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, '');
    const raw = line.slice(eq + 1).trim();
    current[key] = parseTomlValue(raw, index + 1);
  }
  return root;
}

/** Parse one TOML scalar or array value. */
function parseTomlValue(raw, lineNumber) {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quote = raw[0];
    if (!raw.endsWith(quote) || raw.length < 2) throw new Error(`TOML 第 ${lineNumber} 行字符串未闭合`);
    return raw.slice(1, -1);
  }
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) throw new Error(`TOML 第 ${lineNumber} 行数组未闭合`);
    return splitTopLevelList(raw.slice(1, -1)).map((item) => parseTomlValue(item.trim(), lineNumber));
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const num = Number(raw);
  return Number.isFinite(num) && raw !== '' ? num : raw;
}

/** Split an inline TOML/JSON array body on commas that are not inside quotes. */
function splitTopLevelList(body) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let quote = '';
  let buffer = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      buffer += ch;
      if (ch === '\\') {
        buffer += body[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(buffer);
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  if (buffer.trim() !== '') parts.push(buffer);
  return parts;
}

/**
 * Decode a pasted document into an object.
 * @param input - the raw text, or an already-decoded object.
 * @returns the decoded object.
 * @throws when the text is neither valid TOML nor valid JSON.
 */
export function decodeDocument(input) {
  if (input !== null && typeof input === 'object') return input;
  const text = String(input ?? '').trim();
  if (text === '') throw new Error('配置内容为空');

  if (looksLikeToml(text)) return parseToml(text);

  try {
    return JSON.parse(stripJsonNoise(text));
  } catch (jsonError) {
    // A TOML document without a recognisable MCP table still deserves a TOML
    // error rather than a JSON one, since that is what the user pasted.
    if (/^\s*\[/m.test(text)) {
      try {
        return parseToml(text);
      } catch {
        /* fall through to the JSON error below */
      }
    }
    throw new Error(`配置解析失败：${String(jsonError?.message ?? jsonError)}`);
  }
}

/**
 * Find the name → server map inside a decoded document.
 *
 * The container key differs per tool, so every known one is tried before
 * falling back to treating the whole document as the map (which is what a
 * snippet copied from a single server's docs usually is).
 * @param decoded - the decoded document.
 * @returns the container object.
 */
function findContainer(decoded) {
  for (const key of MAP_CONTAINERS) {
    const value = decoded[key];
    if (value === null || typeof value !== 'object') continue;
    if (Array.isArray(value)) return { container: value, key };
    // `mcp` in OpenCode v2 nests one level further (`mcp.servers`).
    if (key === 'mcp' && value.servers !== null && typeof value.servers === 'object' && !Array.isArray(value.servers)) {
      return { container: value.servers, key };
    }
    return { container: value, key };
  }
  return { container: decoded, key: null };
}

/**
 * Whether a value looks like a server entry rather than a nested container.
 * @param value - candidate entry.
 * @returns true when the object carries any transport-bearing key.
 */
function isServerEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    value.command !== undefined ||
    value.url !== undefined ||
    value.serverUrl !== undefined ||
    value.serverName !== undefined ||
    value.type !== undefined ||
    value.transport !== undefined
  );
}

/**
 * Flatten one server entry into the fields this plugin stores.
 *
 * Handles the field-name variance across dialects: OpenCode's command array,
 * Codex's `http_headers`, Pi's `transport`, Windsurf's `serverUrl`, and the
 * `sse` type that maps onto this plugin's streamable-HTTP transport.
 * @param raw - one entry from a pasted document.
 * @returns the normalized `{ serverName, transport, … }` fields.
 */
export function normalizeEntry(raw) {
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
  const declared = typeof raw.transport === 'string' ? raw.transport.toLowerCase() : '';
  const remote = HTTP_TYPES.has(type) || HTTP_TYPES.has(declared);
  const stdio = STDIO_TYPES.has(type) || STDIO_TYPES.has(declared);

  // A URL with no command is remote whatever the entry says; a command with no
  // URL is local. Only an entry carrying both is decided by its declared type.
  const url = firstString(raw.url, raw.serverUrl, raw.server_url, raw.endpoint);
  const commandValue = raw.command;
  const commandList = Array.isArray(commandValue) ? commandValue.filter((part) => typeof part === 'string') : null;
  const command =
    typeof commandValue === 'string'
      ? commandValue
      : commandList !== null && commandList.length > 0
        ? commandList[0]
        : '';

  const isRemote = remote || (!stdio && command === '' && url !== '');

  if (isRemote) {
    return {
      transport: 'streamable-http',
      url,
      headers: firstMap(raw.headers, raw.http_headers, raw.httpHeaders, raw.requestHeaders),
    };
  }

  return {
    transport: 'stdio',
    command,
    // An array command carries its own arguments; otherwise take `args`.
    args: commandList !== null && commandList.length > 1
      ? commandList.slice(1)
      : Array.isArray(raw.args)
        ? raw.args.filter((part) => typeof part === 'string')
        : [],
    env: firstMap(raw.env, raw.environment, raw.envVars),
    cwd: firstString(raw.cwd, raw.workingDirectory, raw.workdir),
  };
}

/** The first argument that is a string, or ''. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/** The first argument that is a plain string→string map, or {}. */
function firstMap(...values) {
  for (const value of values) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      // Codex and some others allow a non-string here (a number, or a nested
      // object for `env_http_headers`); those are not env vars we can pass on.
      if (typeof inner === 'string') out[key] = inner;
      else if (typeof inner === 'number' || typeof inner === 'boolean') out[key] = String(inner);
    }
    if (Object.keys(out).length > 0) return out;
  }
  return {};
}

/**
 * Parse a pasted configuration from any supported tool.
 *
 * Every dialect ends up as the same list, so the caller never needs to know
 * which tool the paste came from.
 * @param input - the pasted text (or an object).
 * @returns `{ servers, source }`, where `source` names the detected dialect.
 * @throws when nothing that looks like a server can be found.
 */
export function parseMcpConfig(input) {
  const decoded = decodeDocument(input);

  // OpenCode v2 nests the map one level down.
  const { container, key } = findContainer(decoded);
  const entries = [];

  if (Array.isArray(container)) {
    // Continue's form: an array whose entries carry their own `name`.
    for (const item of container) {
      if (!isServerEntry(item)) continue;
      const name = firstString(item.name, item.serverName, item.id);
      if (name === '') continue;
      entries.push([name, item]);
    }
  } else {
    for (const [name, item] of Object.entries(container)) {
      if (CONTAINER_KEYS.has(name)) continue;
      if (!isServerEntry(item)) continue;
      entries.push([name, item]);
    }
  }

  if (entries.length === 0) throw new Error('未在配置中找到任何 MCP 服务器条目');

  return {
    source: describeSource(key, decoded),
    servers: entries.map(([name, raw]) => {
      const normalized = normalizeEntry(raw);
      const serverName = firstString(raw.serverName, name);
      return { serverName, raw, ...normalized };
    }),
  };
}

/** Name the detected dialect, for the message the user sees. */
function describeSource(key, decoded) {
  if (key === 'servers') return 'VS Code';
  if (key === 'mcp_servers') return 'Codex';
  if (key === 'mcp') return 'OpenCode';
  if (key === null) return '单服务器片段';
  if (Array.isArray(decoded[key])) return 'Continue';
  return '标准 mcpServers';
}
