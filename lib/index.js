/**
 * dsh-mcp-manager-plus — host half.
 *
 * Serves a small loopback HTTP API over the harness web server so the browser
 * settings page ("MCP 管理") can list, add, edit, enable/disable, restart and
 * delete MCP servers.
 *
 * Durability and live effect are the same mechanism. The profile's user patch
 * layer (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`) is the durable
 * record, and the profile runs with `patchReload: live`, so the loader
 * re-composes the tree about a second after the file changes. This plugin
 * therefore never mutates the running loader tree for a configuration change:
 * it writes the file and reports the live state the loader converges to (which
 * the browser half polls for, briefly, after a write).
 *
 * Safety rules:
 * - Only loopback requests are answered.
 * - A write is refused unless the resulting document still parses as a
 *   top-level YAML array of loader patch rows, so a bad edit can never brick
 *   the next boot.
 * - Credential-shaped config values (`KEY|PASSWORD|SECRET|TOKEN`) are masked on
 *   read and restored from the previous value when written back unchanged.
 *
 * @module dsh-mcp-manager-plus
 */

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import {
  MCP_CLIENT_PACKAGE,
  ROW_ID_PREFIX,
  appendBlock,
  dropDisabledOverrides,
  dropOverrides,
  emitDisabledBlock,
  emitInsertBlock,
  insertedIds,
  joinTopLevel,
  readDocument,
  readPatchText,
  removeRowFromBlock,
  updateRowInBlock,
  validateDocument,
} from './patch.js';
import { parseMcpConfig } from './import.js';
import { resolveEntryYaml, yamlResolutionAnchors } from './yaml.js';

/** Route prefix for this plugin's API. */
const API_PREFIX = '/mcp-manager-plus';
/** How long a listing may be reused, in ms. */
const CACHE_TTL_MS = 300;
/** Config keys whose values never travel to the browser in the clear. */
const SECRET_KEY_RE = /KEY|PASSWORD|SECRET|TOKEN/i;
/** The mask the browser receives and may echo back unchanged. */
const SECRET_MASK = '••••••••';
/** Package id; also the directory name under the profile's `plugin-data`. */
const PLUGIN_ID = 'dsh-mcp-manager-plus';
/** File name of the durable project-binding table. */
const BINDINGS_FILE = 'bindings.json';
/** How long a binding read may be reused, in ms. */
const BINDINGS_TTL_MS = 1000;
/** The bridge's namespace prefix on every MCP tool name. */
const MCP_TOOL_PREFIX = 'mcp__';
/** Config keys this plugin models explicitly; every other key passes through. */
const STRUCTURED_KEYS = new Set([
  'serverName',
  'transport',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
]);

/**
 * Built-in harness tool providers that present an MCP-shaped tool set. They
 * are shown read-only so the page accounts for every tool source, matching the
 * "Built-in" row a user sees beside their own servers.
 */
const BUILTIN_PROVIDERS = [
  { service: 'computerUse', serverName: 'computer-use', label: 'Computer Use' },
  { service: 'browserUse', serverName: 'browser-use', label: 'Browser Use' },
];

// ── response language ───────────────────────────────────────────────────────

/**
 * User-facing host strings in the two shipped languages. The browser picks one
 * per request with a `?lang=` query parameter; anything unrecognized falls
 * back to Chinese, this deployment's default. `{name}`-style placeholders are
 * filled by `tr`.
 */
const MSGS = {
  zh: {
    loopbackOnly: '仅允许本机访问',
    unknownRoute: '未知接口 {route}',
    bodyTooLarge: '请求体过大',
    badJson: '请求体不是合法 JSON：{detail}',
    rowMissingId: '缺少行 id',
    builtinMissingId: '内置行缺少 id，无法切换',
    nameRequired: '服务名不能为空',
    nameInvalid: '服务名只能包含字母、数字、下划线和连字符，长度 1–32',
    writeCancelled: '{reason}（已取消写入）',
    editTargetMissing: '未找到要编辑的服务器 {name}',
    nameTaken: '服务名 {name} 已存在',
    idTaken: '行 id {id} 已被占用，请换一个服务名',
    removeTargetMissing: '未找到受管行 {id}（部署内置的服务器不能删除，只能停用）',
    restartTargetMissing: '未找到服务器 {id}',
    restartDisabled: '服务器 {name} 已停用，请先启用',
    restartUnmounted: '服务器 {name} 未挂载，无法重启',
    restartUnsupported: '当前载入器不支持就地重启，请重启 dsh 进程',
    restarted: '已重启 {name}',
    noServerName: '行 {id} 缺少 config.serverName，已跳过管理',
    builtinSuffix: '(内置)',
    importNone: '未能导入任何服务器：{detail}',
    importRecognized: '已识别 {source} 配置',
    importCreated: '新增 {names}',
    importUpdated: '更新 {names}',
    importSkipped: '跳过 {names}',
    importUnnamed: '未命名',
    editSingleOnly: '编辑模式一次只能保存一个服务器，但配置里有 {count} 个：{names}',
    noServerEntries: '未在配置中找到任何 MCP 服务器条目',
    importEditUpdated: '已识别 {source} 配置；更新 {name}',
    renamedFrom: '（由 {name} 重命名）',
    yamlDegraded:
      '解析到的 js-yaml（{source}）不支持 !!js 自定义类型，已改用兼容解析；面板功能不受影响',
    bindSaved: '项目绑定已保存：{name}',
    bindCleared: '已解除项目绑定：{name}，改为全局可用',
    bindUnknownServer: '未找到服务器 {name}',
    bindPathsAbsolute: '项目路径必须是绝对路径：{path}',
  },
  en: {
    loopbackOnly: 'Only local (loopback) requests are allowed',
    unknownRoute: 'Unknown endpoint {route}',
    bodyTooLarge: 'Request body too large',
    badJson: 'Request body is not valid JSON: {detail}',
    rowMissingId: 'Missing row id',
    builtinMissingId: 'Built-in row has no id and cannot be toggled',
    nameRequired: 'Server name must not be empty',
    nameInvalid: 'Server name may only contain letters, digits, underscores and hyphens, 1–32 characters',
    writeCancelled: '{reason} (write cancelled)',
    editTargetMissing: 'Server to edit not found: {name}',
    nameTaken: 'Server name {name} already exists',
    idTaken: 'Row id {id} is already taken; choose another server name',
    removeTargetMissing: 'Managed row {id} not found (bundle-provided servers cannot be deleted, only disabled)',
    restartTargetMissing: 'Server not found: {id}',
    restartDisabled: 'Server {name} is disabled; enable it first',
    restartUnmounted: 'Server {name} is not mounted and cannot be restarted',
    restartUnsupported: 'The current loader does not support in-place restarts; restart the dsh process',
    restarted: 'Restarted {name}',
    noServerName: 'Row {id} lacks config.serverName; skipped from management',
    builtinSuffix: ' (built-in)',
    importNone: 'No servers could be imported: {detail}',
    importRecognized: 'Recognized {source} configuration',
    importCreated: 'Added {names}',
    importUpdated: 'Updated {names}',
    importSkipped: 'Skipped {names}',
    importUnnamed: 'Unnamed',
    editSingleOnly: 'Edit mode saves one server at a time, but the configuration contains {count}: {names}',
    noServerEntries: 'No MCP server entries found in the configuration',
    importEditUpdated: 'Recognized {source} configuration; updated {name}',
    renamedFrom: ' (renamed from {name})',
    yamlDegraded:
      'The js-yaml in use ({source}) does not support the !!js custom type; a compatible parser is active and the panel stays fully usable',
    bindSaved: 'Project binding saved: {name}',
    bindCleared: 'Project binding removed: {name}; it is available everywhere again',
    bindUnknownServer: 'Server not found: {name}',
    bindPathsAbsolute: 'A project path must be absolute: {path}',
  },
};

/**
 * Translate one message key for a request's language.
 * @param lang - `'en'` or anything else (treated as Chinese).
 * @param key - a `MSGS` key; an unknown key falls back to the key itself.
 * @param params - placeholder values for `{name}` slots.
 */
function tr(lang, key, params) {
  const table = lang === 'en' ? MSGS.en : MSGS.zh;
  let text = table[key] !== undefined ? table[key] : key;
  if (params !== undefined) {
    text = text.replace(/\{(\w+)\}/gu, (match, name) =>
      params[name] !== undefined ? String(params[name]) : match,
    );
  }
  return text;
}

/** The language a request asked for; `'en'` or the Chinese default. */
function requestLang(url) {
  return url.searchParams.get('lang') === 'en' ? 'en' : 'zh';
}

/** Join a display list the way the current language spells it. */
function joinList(lang, names) {
  return names.join(lang === 'en' ? ', ' : '、');
}

/**
 * Load `js-yaml` with the entry-list dialect — a `!!js` tag carrying an
 * expression node — which is exactly the dialect the loader's include plugin
 * parses.
 *
 * Resolution is anchored deliberately. This package is installed into a
 * profile, and `js-yaml` reaches it hoisted at the profile root; a plain
 * `import('js-yaml')` also works there, but a linked or nested install can put
 * the plugin somewhere that walk does not reach. So the profile directory is
 * tried first — that is where the loader's own include plugin resolves it from
 * — with a normal import as the fallback.
 *
 * A copy that cannot register the `!!js` type no longer takes the page down
 * with it: it is skipped in favour of the plugin's own pinned copy, and when
 * no copy at all can carry the tag the module is adapted instead of rejected.
 * See `./yaml.js` for both defences.
 *
 * @param ctx - host context, used to anchor resolution at the profile directory.
 * @returns `{ yaml, schema, degraded, source, raw }` — the module plus a
 *   schema able to round-trip `!!js` scalars.
 */
async function loadYaml(ctx) {
  const { profileDir } = resolvePatchPath(ctx);
  return resolveEntryYaml(
    yamlResolutionAnchors(profileDir, { home: dshHome(), profile: argvProfile() ?? 'web' }),
  );
}

/** The harness home, honouring a `DSH_HOME` override. */
function dshHome() {
  const override = process.env.DSH_HOME;
  return override && override.trim() !== '' ? override : join(homedir(), '.dsh');
}

/** The profile this process booted, from `--profile <name>` when present. */
function argvProfile() {
  const argv = process.argv;
  const flag = argv.indexOf('--profile');
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-')) return argv[flag + 1];
  return undefined;
}

/**
 * Resolve the user patch file. The authoritative answer is the
 * `cordis:include` entry the loader actually read — a host that owns the
 * profile directory, such as DSH Desktop, may place it elsewhere — with the
 * conventional path as the fallback.
 * @param ctx - host context holding the loader.
 * @returns `{ patchPath, profileDir }`.
 */
function resolvePatchPath(ctx) {
  const loader = ctx.get('loader');
  if (loader !== undefined && typeof loader.entries === 'function') {
    for (const entry of loader.entries()) {
      const options = entry.options ?? {};
      if (options.name !== 'cordis:include') continue;
      const config = options.config;
      if (config === null || typeof config !== 'object') continue;
      const path = config.path;
      if (typeof path !== 'string' || !path.includes('cordis.yml')) continue;
      const patchPath = fromFileUrl(path).replace(/cordis\.yml$/u, 'cordis.patch.yml');
      return { patchPath, profileDir: dirname(patchPath) };
    }
  }
  const profileDir = join(dshHome(), 'profiles', argvProfile() ?? 'web');
  return { patchPath: join(profileDir, 'cordis.patch.yml'), profileDir };
}

/**
 * Resolve a `file://` URL to a native path; a plain path is returned untouched.
 *
 * `new URL(value).pathname` keeps percent-encoding, which is what broke DSH
 * Desktop: it hands over the include path as a file URL, so an install
 * directory containing a space arrived as `DeepSeek%20Harness`, named a file
 * that does not exist, and the writability probe below then reported the patch
 * file as read-only. `fileURLToPath` decodes `%20` (and every other escape)
 * and normalizes the Windows drive-letter slash and UNC hosts.
 * @param value - a `file://` URL or a native path.
 * @returns the native path.
 */
function fromFileUrl(value) {
  if (!value.startsWith('file://')) return value;
  try {
    return fileURLToPath(value);
  } catch {
    // A malformed URL falls through to the manual parse.
  }
  try {
    const path = decodeURIComponent(new URL(value).pathname);
    // Windows file URLs carry a leading slash before the drive letter.
    return /^\/[A-Za-z]:/u.test(path) ? path.slice(1) : path;
  } catch {
    return value.replace(/^file:\/\//u, '');
  }
}

// ── secret handling ─────────────────────────────────────────────────────────

/** Mask credential-shaped values in a shallow string map. */
function maskMap(map) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return {};
  const masked = {};
  for (const [key, value] of Object.entries(map)) {
    masked[key] =
      SECRET_KEY_RE.test(key) && typeof value === 'string' && value !== '' ? SECRET_MASK : value;
  }
  return masked;
}

/** Restore masked values from the previous map so an untouched field round-trips. */
function unmaskMap(next, previous) {
  if (next === null || typeof next !== 'object' || Array.isArray(next)) return {};
  const restored = {};
  for (const [key, value] of Object.entries(next)) {
    const before = previous !== null && typeof previous === 'object' ? previous[key] : undefined;
    restored[key] = value === SECRET_MASK && typeof before === 'string' ? before : value;
  }
  return restored;
}

// ── project bindings ────────────────────────────────────────────────────────

/**
 * Where the durable project-binding table lives.
 *
 * Binding state is deliberately NOT the profile patch layer. That layer
 * composes the running tree, so writing a binding into it would remount every
 * MCP connection on every binding edit; bindings are ordinary plugin data,
 * stored beside the patch file, and they take effect in the running process the
 * moment they are written.
 *
 * `DSH_MCP_MANAGER_BINDINGS` overrides the location (tests, unusual installs).
 * @param ctx - host context.
 * @returns an absolute path.
 */
function resolveBindingsPath(ctx) {
  const override = process.env.DSH_MCP_MANAGER_BINDINGS;
  if (override !== undefined && override.trim() !== '') return override;
  const { profileDir } = resolvePatchPath(ctx);
  return join(profileDir, 'plugin-data', PLUGIN_ID, BINDINGS_FILE);
}

/**
 * The comparison key for a directory: separators normalized, trailing
 * separators dropped, and case-folded on Windows, whose filesystem is
 * case-insensitive. A leading `~` expands to the home directory.
 * @param value - a path.
 * @returns the key, or `''` for an empty path.
 */
function pathKey(value) {
  let text = String(value ?? '').trim();
  if (text === '') return '';
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
    text = join(homedir(), text.slice(1));
  }
  const trimmed = text.replace(/[\\/]+$/u, '').replace(/\\/gu, '/');
  if (trimmed === '') return '/';
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * Whether a session directory is the bound project itself or lives inside it.
 * @param candidate - the session's effective directory.
 * @param root - a bound project path.
 * @returns true when the directory is covered by the binding.
 */
function isWithin(candidate, root) {
  const a = pathKey(candidate);
  const b = pathKey(root);
  if (a === '' || b === '') return false;
  if (a === b) return true;
  return a.startsWith(b.endsWith('/') ? b : `${b}/`);
}

/**
 * Accept a submitted project path. A relative path is refused rather than
 * quietly stored: it could never match a session directory, so the binding
 * would look configured while doing nothing.
 * @param value - the submitted path.
 * @returns the trimmed path, or null when it is not absolute.
 */
function normalizeBindingPath(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) return text;
  return isAbsolute(text) ? text : null;
}

/**
 * Normalize a parsed binding table. Both the canonical shape
 * (`{ version, servers: { name: { paths: [...] } } }`) and a hand-written
 * shorthand (`{ name: ["C:\\dir"] }`) are accepted, and anything unusable is
 * dropped rather than throwing.
 * @param parsed - the decoded JSON value.
 * @returns `{ version: 1, servers }`.
 */
function normalizeBindings(parsed) {
  const servers = {};
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { version: 1, servers };
  }
  const source =
    parsed.servers !== null && typeof parsed.servers === 'object' ? parsed.servers : parsed;
  for (const [name, entry] of Object.entries(source)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(name)) continue;
    const raw = Array.isArray(entry)
      ? entry
      : entry !== null && typeof entry === 'object' && Array.isArray(entry.paths)
        ? entry.paths
        : undefined;
    if (raw === undefined) continue;
    const paths = [];
    for (const item of raw) {
      const accepted = typeof item === 'string' ? normalizeBindingPath(item) : null;
      if (accepted === null) continue;
      if (paths.some((existing) => pathKey(existing) === pathKey(accepted))) continue;
      paths.push(accepted);
    }
    if (paths.length > 0) servers[name] = { paths };
  }
  return { version: 1, servers };
}

/** Last binding snapshot; invalidated on write and refreshed when the file changes. */
let bindingsCache = null;

/**
 * Read the binding table, tolerating a missing or damaged file.
 *
 * A damaged table reads as "no bindings" — the pre-feature behaviour — so a bad
 * edit can never make a user's MCP servers unusable everywhere.
 * @param ctx - host context.
 * @returns `{ version: 1, servers }`.
 */
function readBindings(ctx) {
  const path = resolveBindingsPath(ctx);
  const now = Date.now();
  let stamp = -1;
  try {
    stamp = statSync(path).mtimeMs;
  } catch {
    stamp = -1;
  }
  if (
    bindingsCache !== null &&
    bindingsCache.path === path &&
    bindingsCache.stamp === stamp &&
    now - bindingsCache.at < BINDINGS_TTL_MS
  ) {
    return bindingsCache.value;
  }
  let value = { version: 1, servers: {} };
  if (stamp !== -1) {
    try {
      value = normalizeBindings(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      value = { version: 1, servers: {} };
    }
  }
  bindingsCache = { path, stamp, at: now, value };
  return value;
}

/**
 * Replace the binding table atomically, with sorted keys so the file diffs
 * cleanly.
 * @param ctx - host context.
 * @param servers - the `servers` map to persist.
 * @returns the absolute path written.
 */
function writeBindings(ctx, servers) {
  const path = resolveBindingsPath(ctx);
  const sorted = {};
  for (const name of Object.keys(servers).sort()) sorted[name] = servers[name];
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, servers: sorted }, null, 2)}\n`);
  renameSync(temp, path);
  bindingsCache = null;
  return path;
}

/**
 * The active binding for one server.
 * @param table - a table from {@link readBindings}.
 * @param serverName - the server namespace.
 * @returns the binding, or null when the server is global.
 */
function bindingOf(table, serverName) {
  const entry = table.servers[serverName];
  if (entry === undefined || !Array.isArray(entry.paths) || entry.paths.length === 0) return null;
  return entry;
}

/**
 * The server namespace a bridge tool belongs to. A `serverName` may itself
 * contain `_`, so the separating `__` is the LAST one — the bridge's own naming
 * contract.
 * @param name - a tool name.
 * @returns the server name, or undefined when this is not an MCP tool.
 */
function serverOfToolName(name) {
  if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const index = rest.lastIndexOf('__');
  if (index <= 0) return undefined;
  return rest.slice(0, index);
}

/** Every registered tool name a server currently contributes. */
function toolNamesOfServer(ctx, serverName) {
  const prefix = `${MCP_TOOL_PREFIX}${serverName}__`;
  const names = [];
  for (const schema of schemasOf(ctx)) {
    const name = schema?.name;
    if (typeof name === 'string' && name.startsWith(prefix)) names.push(name);
  }
  return names;
}

/**
 * The directory a session runs in.
 *
 * `workingDirectory` is the live owner of the effective directory and is
 * preferred; the session header's original `cwd` is the fallback, and the
 * deployment default is the last resort. An undeterminable directory leaves the
 * caller unenforced, so an unknown directory never locks a user out of their
 * own servers.
 * @param ctx - host context.
 * @param agent - the agent on whose behalf a call runs.
 * @returns an absolute directory, or undefined when none can be read.
 */
function cwdOfAgent(ctx, agent) {
  const session = agent !== null && typeof agent === 'object' ? agent.session : undefined;
  let wd;
  try {
    wd = ctx.get('workingDirectory');
  } catch {
    wd = undefined;
  }
  if (wd !== undefined && session !== undefined && typeof wd.get === 'function') {
    try {
      const dir = wd.get(session);
      if (typeof dir === 'string' && dir !== '') return dir;
    } catch {
      // Fall through to the session header.
    }
  }
  const header = session !== undefined ? session.header : undefined;
  if (header !== undefined && typeof header.cwd === 'string' && header.cwd !== '') return header.cwd;
  if (wd !== undefined && typeof wd.defaultDirectory === 'string' && wd.defaultDirectory !== '') {
    return wd.defaultDirectory;
  }
  return undefined;
}

/** The denial a guard returns: the model learns why, and where to change it. */
function bindingDenial(toolName, serverName, cwd, paths) {
  return (
    `MCP 项目绑定：工具 ${toolName} 在当前项目不可用（当前目录 ${cwd}）。` +
    `服务器 "${serverName}" 只绑定到：${paths.join('、')}。可在「设置 → MCP 管理 → 项目绑定」中修改。` +
    ` / Project binding: "${serverName}" is bound to ${paths.join(', ')}, so ${toolName} is unavailable in ${cwd}.`
  );
}

/** The agent-scoped restriction last applied to each live agent. */
const agentBindings = new WeakMap();

/**
 * Bring one agent's tool visibility in line with the binding table.
 *
 * A restricted server's tools are hidden from that agent with an agent-scoped
 * `tools.restrict()` — the only context in which that call is legal. The work is
 * skipped when nothing changed, so calling it on every step is cheap. Nothing
 * here may throw: a failure inside an `agent/pre-step` listener would fail the
 * step.
 * @param ctx - host context.
 * @param agent - the agent to bring up to date.
 */
function syncAgentBindings(ctx, agent) {
  try {
    if (agent === null || typeof agent !== 'object') return;
    const agentCtx = agent.ctx;
    if (agentCtx === undefined || agentCtx === null) return;
    let scoped;
    try {
      scoped = agentCtx.tools;
    } catch {
      scoped = undefined;
    }
    if (scoped === undefined && typeof agentCtx.get === 'function') {
      try {
        scoped = agentCtx.get('tools');
      } catch {
        scoped = undefined;
      }
    }
    if (scoped === undefined || typeof scoped.restrict !== 'function') return;

    const cwd = cwdOfAgent(ctx, agent);
    const known = cwd !== undefined && cwd !== '';
    const table = readBindings(ctx);
    const deny = [];
    for (const serverName of Object.keys(table.servers)) {
      const binding = bindingOf(table, serverName);
      if (binding === null) continue;
      // Fail open, exactly like the per-call guard: when this session's
      // directory cannot be determined we hide nothing, rather than locking a
      // user out of a project the plugin failed to recognize. Hiding the tools
      // while the guard still allows the call would also be self-contradictory.
      if (!known) continue;
      if (binding.paths.some((root) => isWithin(cwd, root))) continue;
      for (const name of toolNamesOfServer(ctx, serverName)) deny.push(name);
    }
    deny.sort();

    const state = agentBindings.get(agent);
    const signature = deny.join('\n');
    if (state !== undefined && state.signature === signature) return;
    if (state !== undefined) {
      for (const dispose of state.disposers) {
        try {
          dispose();
        } catch {
          // A disposer that fails must not stop the new restriction.
        }
      }
    }
    const disposers = [];
    if (deny.length > 0) {
      try {
        disposers.push(scoped.restrict({ deny }));
      } catch {
        // An empty filter, an unknown name, or a registration that vanished
        // between the listing and the call: the per-call guard still enforces
        // the binding, so losing the schema filter is not a hole.
      }
    }
    agentBindings.set(agent, { signature, disposers });
  } catch {
    // Never let enforcement break a step.
  }
}

/** Bring every live agent up to date, after a binding edit. */
function syncAllAgents(ctx) {
  let agents;
  try {
    agents = ctx.get('agents');
  } catch {
    return;
  }
  if (agents === undefined || typeof agents.list !== 'function') return;
  let list;
  try {
    list = agents.list();
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  for (const agent of list) syncAgentBindings(ctx, agent);
}

/**
 * Install project-binding enforcement.
 *
 * Two independent layers, because they cover different things:
 * - a global monotonic `tools.guard`, denying a bound server's tool call from a
 *   session outside its projects. This is the hard rule, and it also covers
 *   sessions that already existed, a directory changed mid-session, and the
 *   moment before a scope restriction is re-applied;
 * - agent-scoped `tools.restrict`, applied at `agent/created` and re-checked at
 *   every `agent/pre-step`, which keeps the tools out of the model's schema list
 *   in the first place.
 * @param ctx - host context.
 */
function applyProjectBindings(ctx) {
  let tools;
  try {
    tools = ctx.get('tools');
  } catch {
    tools = undefined;
  }
  if (tools !== undefined && typeof tools.guard === 'function') {
    ctx.effect(
      () =>
        tools.guard((exec) => {
          const serverName = serverOfToolName(exec?.name);
          if (serverName === undefined) return undefined;
          const binding = bindingOf(readBindings(ctx), serverName);
          if (binding === null) return undefined;
          const cwd = cwdOfAgent(ctx, exec.agent);
          if (cwd === undefined || cwd === '') return undefined;
          if (binding.paths.some((root) => isWithin(cwd, root))) return undefined;
          return bindingDenial(exec.name, serverName, cwd, binding.paths);
        }),
      'dsh-mcp-manager-plus: project binding guard',
    );
  }
  if (typeof ctx.on !== 'function') return;
  ctx.effect(() => {
    const offCreated = ctx.on('agent/created', (payload) => {
      syncAgentBindings(ctx, payload?.agent);
    });
    const offStep = ctx.on('agent/pre-step', (payload, next) => {
      syncAgentBindings(ctx, payload?.agent);
      return typeof next === 'function' ? next() : undefined;
    });
    return () => {
      if (typeof offCreated === 'function') offCreated();
      if (typeof offStep === 'function') offStep();
    };
  }, 'dsh-mcp-manager-plus: project binding scope');
}

// ── live-state reads ────────────────────────────────────────────────────────

/** Cordis fiber states, mirrored as the readable phase the browser shows. */
const FIBER_PHASE = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: null, 5: 'unloading' };
/** Cordis `FiberState.DISPOSED`: the fiber is gone and cannot be restarted. */
const FIBER_DISPOSED = 4;

/**
 * Find the live loader entry for one managed server. Matching is by package
 * plus `config.serverName` rather than by entry id, because a row inside an
 * include subtree carries a prefixed id this plugin cannot predict.
 * @param ctx - host context.
 * @param serverName - the `serverName` the row configured.
 * @returns the entry, or undefined.
 */
function findEntry(ctx, serverName) {
  const loader = ctx.get('loader');
  if (loader === undefined || typeof loader.entries !== 'function') return undefined;
  for (const entry of loader.entries()) {
    const options = entry.options ?? {};
    if (options.name !== MCP_CLIENT_PACKAGE) continue;
    const config = options.config;
    if (config === null || typeof config !== 'object') continue;
    if (config.serverName === serverName) return entry;
  }
  return undefined;
}

/** Read one entry's live phase. */
function phaseOf(entry, disabled) {
  if (disabled) return 'disabled';
  if (entry === undefined) return 'pending';
  const fiber = entry.fiber;
  if (fiber === undefined) return entry.disabled === true ? 'disabled' : 'pending';
  return FIBER_PHASE[fiber.state] ?? null;
}

/** Longest diagnostic string copied out of a live bridge status. */
const STATUS_TEXT_LIMIT = 600;
/**
 * Diagnostic override for the module that reports connection state. Set it to a
 * file path or `file:` URL to read a nonstandard bridge copy; tests use it to
 * inject a fake without requiring the real package.
 */
const STATUS_OVERRIDE_ENV = 'DSH_MCP_MANAGER_STATUS_MODULE';

/**
 * Resolved status readers, one promise per host context. Resolution imports
 * code (slow, and it may legitimately fail), so a listing burst must not retry
 * it; the readers themselves are stateless probes over live fibers.
 */
const STATUS_READERS = new WeakMap();

/**
 * The `connectionStatusOf` export of a bridge module, or `null` when this copy
 * predates the status API. Older bridges export no such function at all — that
 * is the case the tool-count fallback exists for.
 * @param mod - a module namespace.
 * @returns the function, or null.
 */
function connectionStatusFunction(mod) {
  if (mod === null || (typeof mod !== 'object' && typeof mod !== 'function')) return null;
  if (typeof mod.connectionStatusOf === 'function') return mod.connectionStatusOf;
  const fallback = mod.default;
  if (
    fallback !== null &&
    typeof fallback === 'object' &&
    typeof fallback.connectionStatusOf === 'function'
  ) {
    return fallback.connectionStatusOf;
  }
  return null;
}

/** Bound diagnostic text: error strings can carry a whole child-process dump. */
function statusText(value) {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : '';
  if (text === '') return '';
  return text.length > STATUS_TEXT_LIMIT ? `${text.slice(0, STATUS_TEXT_LIMIT)}…` : text;
}

/**
 * Copy a bridge status into plain data. Only known fields are copied, so a
 * future bridge state cannot smuggle an arbitrary object graph into the HTTP
 * response, and every field is validated before the browser sees it.
 * @param status - one `McpConnectionStatus` value.
 * @returns the snapshot sent as `live.connection`.
 */
function snapshotConnection(status) {
  const snapshot = { state: status.state };
  if (typeof status.toolCount === 'number' && Number.isFinite(status.toolCount)) {
    snapshot.toolCount = status.toolCount;
  }
  if (typeof status.connectedAt === 'number' && Number.isFinite(status.connectedAt)) {
    snapshot.connectedAt = status.connectedAt;
  }
  if (typeof status.attempt === 'number' && Number.isFinite(status.attempt)) {
    snapshot.attempt = status.attempt;
  }
  if (typeof status.maxAttempts === 'number' && Number.isFinite(status.maxAttempts)) {
    snapshot.maxAttempts = status.maxAttempts;
  }
  if (typeof status.nextRetryAtMs === 'number' && Number.isFinite(status.nextRetryAtMs)) {
    snapshot.nextRetryAtMs = status.nextRetryAtMs;
  }
  if (typeof status.reason === 'string' && status.reason !== '') {
    snapshot.reason = status.reason;
  }
  const lastError = statusText(status.lastError);
  if (lastError !== '') snapshot.lastError = lastError;
  if (status.result !== null && typeof status.result === 'object') {
    if (typeof status.result.closeConfirmed === 'boolean') {
      snapshot.closeConfirmed = status.result.closeConfirmed;
    }
    const cleanupError = statusText(status.result.cleanupError);
    if (cleanupError !== '') snapshot.cleanupError = cleanupError;
  }
  return snapshot;
}

/**
 * Ask every resolved bridge copy for this entry's connection status.
 *
 * The bridge keeps status cells in a `WeakMap` keyed by the live fiber, so a
 * handle exists only in the module instance that actually applied the entry.
 * Probing all copies is what makes the read independent of which copy the
 * loader picked. A fake fiber (tests) has no `ctx.fiber` and makes the probe
 * throw — that is caught and treated as "this copy does not own the entry".
 * @param entry - the live loader entry.
 * @param readers - resolved `connectionStatusOf` functions.
 * @returns a snapshot, or null when no copy owns the entry.
 */
function connectionOf(entry, readers) {
  if (!Array.isArray(readers) || readers.length === 0) return null;
  const fiber = entry?.fiber;
  if (fiber === undefined) return null;
  for (const reader of readers) {
    let handle;
    try {
      handle = reader.connectionStatusOf(fiber);
    } catch {
      continue;
    }
    if (handle === null || typeof handle !== 'object') continue;
    if (typeof handle.current !== 'function') continue;
    let status;
    try {
      status = handle.current();
    } catch {
      continue;
    }
    if (status === null || typeof status !== 'object') continue;
    if (typeof status.state !== 'string' || status.state === '') continue;
    return snapshotConnection(status);
  }
  return null;
}

/**
 * The connection projection for one row.
 *
 * A loader phase of `active` only proves the bridge plugin mounted; the MCP
 * child process starts afterwards, so a crashed handshake leaves the fiber
 * active forever. The bridge's own status is the authoritative answer when it
 * can be read. When it cannot, a mounted, enabled server exposing zero tools is
 * reported as `unknown` rather than `connected` — the two facts contradict each
 * other, and the honest reading is that the handshake was not observed.
 * @param entry - the live loader entry, when mounted.
 * @param phase - the projected loader phase.
 * @param disabled - whether the row is disabled by the patch layer.
 * @param toolCount - registered tool count for this server.
 * @param readers - resolved bridge status readers.
 * @returns `live.connection`, or null when there is nothing to say.
 */
function liveConnectionOf(entry, phase, disabled, toolCount, readers) {
  if (disabled || phase !== 'active') return null;
  const observed = connectionOf(entry, readers);
  if (observed !== null) return observed;
  return toolCount === 0 ? { state: 'unknown' } : null;
}

/** Normalize a diagnostic override into an importable URL. */
function statusOverrideUrl(specifier) {
  // An absolute path has to win over the scheme test: on Windows `C:\bridge.mjs`
  // starts with a colon-terminated run of letters, which reads as the `c:`
  // scheme, and importing it as a URL fails rather than loading the file.
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(specifier)) return specifier;
  return pathToFileURL(resolvePath(process.cwd(), specifier)).href;
}

/**
 * The anchors a bridge module is resolved through, in order.
 *
 * The profile anchor is the one that matches the loader's own view; the
 * bundled Electron tree is the copy that carries the status API when the
 * profile's hoisted copy is older; the rest cover a CLI install and a linked
 * development checkout.
 * @param profileDir - the profile directory, when known.
 * @returns candidate directories.
 */
function statusResolutionAnchors(profileDir) {
  const anchors = [];
  const add = (value) => {
    if (typeof value === 'string' && value !== '' && !anchors.includes(value)) {
      anchors.push(value);
    }
  };
  add(profileDir);
  add(process.cwd());
  const pluginLib = dirname(fileURLToPath(import.meta.url));
  add(dirname(pluginLib));
  add(pluginLib);
  const home = dshHome();
  if (home !== '') add(join(home, 'profiles'));
  const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (resources !== '') {
    add(join(resources, 'app.asar', 'dsh'));
    add(join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-mcp-client'));
  }
  const entrypoint = process.argv[1];
  if (typeof entrypoint === 'string' && entrypoint !== '') add(dirname(entrypoint));
  return anchors;
}

/**
 * Resolve every importable copy of the MCP bridge that exposes
 * `connectionStatusOf`.
 *
 * Four routes are tried because the running tree differs by deployment: a bare
 * import (a Vite-backed loader may rewrite it), the loader's own internal
 * importer (the exact module instance it applied), the profile/bundled anchors,
 * and finally nothing — in which case the tool-count fallback still keeps the
 * badge honest.
 * @param ctx - host context.
 * @param profileDir - the profile directory, when known.
 * @returns `[{ source, connectionStatusOf }]`.
 */
async function loadStatusReaders(ctx, profileDir) {
  const readers = [];
  /** @param mod - candidate module. @param source - where it came from. */
  const add = (mod, source) => {
    const fn = connectionStatusFunction(mod);
    if (fn === null) return false;
    if (readers.some((reader) => reader.connectionStatusOf === fn)) return true;
    readers.push({ source, connectionStatusOf: fn });
    return true;
  };

  // A diagnostic/test override wins outright when it works: the caller asked
  // for exactly one module, and mixing it with guessed copies would make the
  // answer non-deterministic.
  const override = process.env[STATUS_OVERRIDE_ENV];
  if (typeof override === 'string' && override.trim() !== '') {
    try {
      if (add(await import(statusOverrideUrl(override.trim())), 'override')) return readers;
    } catch {
      // Fall through to the normal resolution routes.
    }
  }

  try {
    add(await import(MCP_CLIENT_PACKAGE), 'bare');
  } catch {
    // Older Node resolution cannot see the profile's copy.
  }

  const loader = ctx.get('loader');
  const internal = loader?.internal;
  if (internal !== undefined && typeof internal.import === 'function') {
    const bases = new Set();
    if (typeof ctx.baseUrl === 'string' && ctx.baseUrl !== '') bases.add(ctx.baseUrl);
    if (loader !== undefined && typeof loader.entries === 'function') {
      try {
        for (const entry of loader.entries()) {
          const baseUrl = entry?.fiber?.ctx?.baseUrl;
          if (typeof baseUrl === 'string' && baseUrl !== '') bases.add(baseUrl);
        }
      } catch {
        // A loader that cannot enumerate entries still answers for itself.
      }
    }
    for (const baseUrl of bases) {
      try {
        add(await internal.import(MCP_CLIENT_PACKAGE, baseUrl, {}), `loader:${baseUrl}`);
      } catch {
        // The internal importer only accepts bases it can resolve from.
      }
    }
  }

  for (const anchor of statusResolutionAnchors(profileDir)) {
    let resolved;
    try {
      resolved = createRequire(join(anchor, 'package.json')).resolve(MCP_CLIENT_PACKAGE);
    } catch {
      continue;
    }
    try {
      add(await import(pathToFileURL(resolved).href), resolved);
    } catch {
      // Resolvable but not importable (a native-only or broken copy).
    }
  }

  return readers;
}

/**
 * Resolve (and cache) the status readers for one host context. Resolution is
 * asynchronous, so callers await this before projecting the inventory; later
 * projections reuse the same readers.
 * @param ctx - host context.
 * @param profileDir - the profile directory, when known.
 * @returns the reader list (possibly empty).
 */
function prepareStatusReaders(ctx, profileDir) {
  const cached = STATUS_READERS.get(ctx);
  if (cached !== undefined) return cached;
  const pending = loadStatusReaders(ctx, profileDir).catch(() => []);
  STATUS_READERS.set(ctx, pending);
  return pending;
}

/** Every model-facing tool schema, defensively read. */
function schemasOf(ctx) {
  const tools = ctx.get('tools');
  if (tools === undefined || typeof tools.schemas !== 'function') return [];
  try {
    return tools.schemas();
  } catch {
    return [];
  }
}

/**
 * The MCP tools a server currently contributes. Names are
 * `mcp__<serverName>__<rawName>`; the separating `__` is the LAST one, which is
 * the bridge's own naming contract.
 * @param ctx - host context.
 * @param serverName - the server namespace.
 * @returns `{ name, fullName, description }` rows using raw tool names.
 */
function toolsOfServer(ctx, serverName) {
  const prefix = `mcp__${serverName}__`;
  const found = [];
  for (const schema of schemasOf(ctx)) {
    const name = schema?.name;
    if (typeof name !== 'string' || !name.startsWith(prefix)) continue;
    found.push({
      name: name.slice(prefix.length),
      fullName: name,
      description: typeof schema.description === 'string' ? schema.description : '',
    });
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

/**
 * Tools a built-in provider service contributes. The service owns a
 * registration surface but publishes no catalog of its own names, so the list
 * is derived from the registry by the provider's naming convention: built-in
 * tools carry no `mcp__` namespace, and the service key maps to a snake-case
 * prefix (`computerUse` → `computer_use_`). A service with no matching tools
 * reports an empty list rather than a wrong one.
 * @param ctx - host context.
 * @param key - the service key.
 * @returns tool rows.
 */
function toolsOfBuiltin(ctx, key) {
  const snake = key.replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`);
  const found = [];
  for (const schema of schemasOf(ctx)) {
    const name = schema?.name;
    if (typeof name !== 'string' || name.startsWith('mcp__')) continue;
    if (!name.startsWith(`${snake}_`) && !name.startsWith(`${snake}-`)) continue;
    found.push({
      name,
      fullName: name,
      description: typeof schema.description === 'string' ? schema.description : '',
    });
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

// ── inventory ───────────────────────────────────────────────────────────────

/**
 * Build the server inventory the browser renders: user-managed rows from the
 * profile patch layer, deployment-provided rows from the composed tree, and the
 * harness's built-in tool providers.
 * @param ctx - host context.
 * @param document - the parsed patch document.
 * @param lang - response language for issue strings and display labels.
 * @param statusReaders - resolved bridge status readers, when available.
 * @returns `{ servers, issues }`.
 */
function buildInventory(ctx, document, lang = 'zh', statusReaders = null) {
  const issues = [...document.issues];
  const servers = [];
  const claimed = new Set();
  const table = readBindings(ctx);
  /** The binding projection the page renders for one server. */
  const bindingsOf = (name) => {
    const binding = bindingOf(table, name);
    return { paths: binding === null ? [] : [...binding.paths], restricted: binding !== null };
  };

  for (const row of document.rows) {
    const config = row.config;
    const serverName = typeof config.serverName === 'string' ? config.serverName : '';
    if (serverName === '') {
      issues.push(tr(lang, 'noServerName', { id: row.id || '(no id)' }));
      continue;
    }
    claimed.add(serverName);
    const disabled = document.overrides.disabled.get(row.id) === true;
    const entry = findEntry(ctx, serverName);
    const tools = disabled ? [] : toolsOfServer(ctx, serverName);
    const phase = phaseOf(entry, disabled);
    const live = {
      mounted: entry !== undefined,
      phase,
      toolCount: tools.length,
      tools,
    };
    const connection = liveConnectionOf(entry, phase, disabled, tools.length, statusReaders);
    if (connection !== null) live.connection = connection;
    servers.push({
      id: row.id,
      serverName,
      displayName: serverName,
      source: 'user',
      origin: 'patch',
      editable: true,
      removable: true,
      enabled: !disabled,
      transport: config.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
      command: typeof config.command === 'string' ? config.command : '',
      args: Array.isArray(config.args) ? config.args.filter((a) => typeof a === 'string') : [],
      env: maskMap(config.env),
      cwd: typeof config.cwd === 'string' ? config.cwd : '',
      url: typeof config.url === 'string' ? config.url : '',
      headers: maskMap(config.headers),
      binding: bindingsOf(serverName),
      live,
    });
  }

  // Deployment-provided MCP rows: composed rows the user patch layer does not
  // own. They are togglable through the patch layer — that is what the layer is
  // for — but never editable here, because their configuration belongs to a
  // bundle.
  const loader = ctx.get('loader');
  if (loader !== undefined && typeof loader.entries === 'function') {
    for (const entry of loader.entries()) {
      const options = entry.options ?? {};
      if (options.name !== MCP_CLIENT_PACKAGE) continue;
      const config = options.config;
      if (config === null || typeof config !== 'object') continue;
      const serverName = typeof config.serverName === 'string' ? config.serverName : '';
      if (serverName === '' || claimed.has(serverName)) continue;
      claimed.add(serverName);
      const id = typeof options.id === 'string' ? options.id : '';
      const off = entry.disabled === true || (id !== '' && document.overrides.disabled.get(id) === true);
      const tools = off ? [] : toolsOfServer(ctx, serverName);
      const phase = phaseOf(entry, off);
      const live = {
        mounted: entry.fiber !== undefined,
        phase,
        toolCount: tools.length,
        tools,
      };
      const connection = liveConnectionOf(entry, phase, off, tools.length, statusReaders);
      if (connection !== null) live.connection = connection;
      servers.push({
        id,
        serverName,
        displayName: serverName,
        source: 'bundle',
        origin: 'bundle',
        editable: false,
        removable: false,
        enabled: !off,
        transport: config.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
        command: typeof config.command === 'string' ? config.command : '',
        args: Array.isArray(config.args) ? config.args.filter((a) => typeof a === 'string') : [],
        env: maskMap(config.env),
        cwd: typeof config.cwd === 'string' ? config.cwd : '',
        url: typeof config.url === 'string' ? config.url : '',
        headers: maskMap(config.headers),
        binding: bindingsOf(serverName),
        live,
      });
    }
  }

  for (const provider of BUILTIN_PROVIDERS) {
    if (ctx.get(provider.service) === undefined) continue;
    if (claimed.has(provider.serverName)) continue;
    claimed.add(provider.serverName);
    const tools = toolsOfBuiltin(ctx, provider.service);
    servers.push({
      id: `builtin-${provider.serverName}`,
      serverName: provider.serverName,
      displayName: `${provider.label}${tr(lang, 'builtinSuffix')}`,
      source: 'builtin',
      origin: 'harness',
      editable: false,
      removable: false,
      enabled: true,
      transport: 'built-in',
      command: '',
      args: [],
      env: {},
      cwd: '',
      url: '',
      headers: {},
      binding: { paths: [], restricted: false },
      live: { mounted: true, phase: 'active', toolCount: tools.length, tools },
    });
  }

  const order = { user: 0, bundle: 1, builtin: 2 };
  servers.sort((a, b) => {
    const bySource = (order[a.source] ?? 9) - (order[b.source] ?? 9);
    return bySource !== 0 ? bySource : a.serverName.localeCompare(b.serverName);
  });

  return { servers, issues };
}

// ── config normalization ────────────────────────────────────────────────────

/**
 * Validate a server name against the bridge's own contract.
 * @param name - the submitted name.
 * @param lang - response language for the error message.
 * @returns an error message, or null when acceptable.
 */
function validateServerName(name, lang = 'zh') {
  if (typeof name !== 'string' || name.trim() === '') return tr(lang, 'nameRequired');
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(name)) {
    return tr(lang, 'nameInvalid');
  }
  return null;
}

/**
 * Normalize a submitted form into the bridge's own config key set.
 *
 * An OMITTED field is not the same as an emptied one: a caller that does not
 * send `env` at all is preserving it, while a caller that sends an empty object
 * is clearing it. That distinction is what keeps a partial update from silently
 * deleting configuration it never mentioned.
 * @param input - the submitted form.
 * @param previous - the row's existing config, when this is an edit.
 * @returns the config to write.
 */
function normalizeConfig(input, previous) {
  const config = { serverName: input.serverName };
  const http = input.transport === 'streamable-http';
  config.transport = http ? 'streamable-http' : 'stdio';
  if (http) {
    if (typeof input.url === 'string' && input.url.trim() !== '') config.url = input.url.trim();
    else if (typeof previous?.url === 'string') config.url = previous.url;
    const headers = input.headers === undefined ? previous?.headers : unmaskMap(input.headers, previous?.headers);
    if (headers !== null && typeof headers === 'object' && Object.keys(headers).length > 0) {
      config.headers = headers;
    }
  } else {
    if (typeof input.command === 'string' && input.command.trim() !== '') config.command = input.command.trim();
    else if (typeof previous?.command === 'string') config.command = previous.command;
    const args =
      input.args === undefined
        ? previous?.args
        : Array.isArray(input.args)
          ? input.args.filter((a) => typeof a === 'string' && a !== '')
          : undefined;
    if (Array.isArray(args) && args.length > 0) config.args = args;
    const env = input.env === undefined ? previous?.env : unmaskMap(input.env, previous?.env);
    if (env !== null && typeof env === 'object' && Object.keys(env).length > 0) config.env = env;
    if (typeof input.cwd === 'string' && input.cwd.trim() !== '') config.cwd = input.cwd.trim();
    else if (typeof previous?.cwd === 'string') config.cwd = previous.cwd;
  }
  // Pass through every key this form does not model, so editing a server never
  // silently drops configuration it already carried.
  if (previous !== null && typeof previous === 'object') {
    for (const [key, value] of Object.entries(previous)) {
      if (key in config || STRUCTURED_KEYS.has(key)) continue;
      config[key] = value;
    }
  }
  return config;
}

// ── writes ──────────────────────────────────────────────────────────────────

/** Serialize writes: two concurrent edits must not interleave a read-modify-write. */
let writeQueue = Promise.resolve();
function queuedWrite(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Atomically replace the patch file after validating the candidate.
 * @param patchPath - absolute path.
 * @param text - candidate document.
 * @param yaml - the `js-yaml` module.
 * @param schema - the entry-list schema.
 * @param lang - response language for the refusal message.
 */
function commit(patchPath, text, yaml, schema, lang = 'zh') {
  const invalid = validateDocument(text, yaml, schema);
  if (invalid !== null) throw new Error(tr(lang, 'writeCancelled', { reason: invalid }));
  mkdirSync(dirname(patchPath), { recursive: true });
  const temp = `${patchPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, text);
  renameSync(temp, patchPath);
}

/**
 * Insert or update one managed server in the profile patch layer.
 * @param ctx - host context.
 * @param input - the submitted form (`originalName` identifies the edited row).
 * @param lang - response language for error messages.
 * @returns `{ action, id, serverName }`.
 */
async function saveServer(ctx, input, lang = 'zh') {
  const serverName = typeof input.serverName === 'string' ? input.serverName.trim() : '';
  const invalid = validateServerName(serverName, lang);
  if (invalid !== null) throw new Error(invalid);
  const { patchPath } = resolvePatchPath(ctx);
  const { yaml, schema } = await loadYaml(ctx);

  return queuedWrite(async () => {
    let document = readDocument(readPatchText(patchPath), yaml, schema);
    // `originalName` is what makes this an EDIT: it names the row being
    // changed, which is how a rename keeps its row id and its overrides. With
    // no `originalName` this is a CREATE, and a name already in use is an
    // error rather than a silent overwrite of someone else's server.
    const originalName = typeof input.originalName === 'string' ? input.originalName.trim() : '';
    const editing = originalName !== '';
    const existing = editing
      ? document.rows.find((row) => row.config.serverName === originalName)
      : undefined;
    if (editing && existing === undefined) {
      throw new Error(tr(lang, 'editTargetMissing', { name: originalName }));
    }
    if (!editing && document.rows.some((row) => row.config.serverName === serverName)) {
      throw new Error(tr(lang, 'nameTaken', { name: serverName }));
    }
    const config = normalizeConfig({ ...input, serverName }, existing?.config ?? null);

    if (existing !== undefined) {
      // Rewriting through the block helper keeps every sibling row in the same
      // `- insert:` block, and keeps this row's id.
      const text = updateRowInBlock(
        document.parts,
        existing,
        { id: existing.id, name: MCP_CLIENT_PACKAGE, config },
        yaml,
        schema,
      );
      commit(patchPath, text, yaml, schema, lang);
      return { action: 'updated', id: existing.id, serverName };
    }

    const id = `${ROW_ID_PREFIX}${serverName}`;
    const taken = insertedIds(document.parts, yaml, schema);
    // A name that already appears as an override target is taken too: writing
    // an insert under it would produce two rows sharing one id.
    for (const overrideId of document.overrides.items.keys()) taken.add(overrideId);
    if (taken.has(id)) throw new Error(tr(lang, 'idTaken', { id }));
    const text = appendBlock(
      document.parts,
      emitInsertBlock([{ id, name: MCP_CLIENT_PACKAGE, config }]),
    );
    commit(patchPath, text, yaml, schema, lang);
    return { action: 'created', id, serverName };
  });
}

/**
 * Enable or disable one server through the patch layer.
 *
 * The `disabled` override is the only lever a user layer has, and its meaning
 * depends on which layer wrote the row:
 * - off → append `- id` + `disabled: true`, which wins over any lower layer;
 * - on for a row this plugin inserted → drop the override (the row is on by
 *   default), because `disabled: false` would be redundant noise;
 * - on for a row a bundle inserted → write `disabled: false`, since dropping
 *   the override cannot re-enable a row a lower layer holds down.
 * @param ctx - host context.
 * @param input - `{ id, enabled, source }`.
 * @param lang - response language for error messages.
 */
async function toggleServer(ctx, input, lang = 'zh') {
  const id = typeof input.id === 'string' ? input.id : '';
  if (id === '') throw new Error(tr(lang, 'rowMissingId'));
  const enabled = input.enabled === true;
  const { patchPath } = resolvePatchPath(ctx);
  const { yaml, schema } = await loadYaml(ctx);

  return queuedWrite(async () => {
    const document = readDocument(readPatchText(patchPath), yaml, schema);
    const ownedByPlugin = document.rows.some((row) => row.id === id);
    if (!ownedByPlugin && id === '') throw new Error(tr(lang, 'builtinMissingId'));

    const { parts } = dropDisabledOverrides(document.parts, [id], yaml, schema);
    const block = !enabled
      ? emitDisabledBlock(id, true)
      : ownedByPlugin
        ? null
        : emitDisabledBlock(id, false);
    const text = block === null ? joinTopLevel(parts) : appendBlock(parts, block);
    commit(patchPath, text, yaml, schema, lang);
    return { action: enabled ? 'enabled' : 'disabled', id };
  });
}

/**
 * Remove one managed server: its row inside its insert block, plus every
 * override that targeted it.
 * @param ctx - host context.
 * @param input - `{ id }`.
 * @param lang - response language for error messages.
 */
async function removeServer(ctx, input, lang = 'zh') {
  const id = typeof input.id === 'string' ? input.id : '';
  if (id === '') throw new Error(tr(lang, 'rowMissingId'));
  const { patchPath } = resolvePatchPath(ctx);
  const { yaml, schema } = await loadYaml(ctx);

  return queuedWrite(async () => {
    let document = readDocument(readPatchText(patchPath), yaml, schema);
    const target = document.rows.find((row) => row.id === id);
    if (target === undefined) {
      throw new Error(tr(lang, 'removeTargetMissing', { id }));
    }
    // Dropping the row keeps its siblings; only an emptied block disappears.
    let text = removeRowFromBlock(document.parts, target, yaml, schema).text;
    document = readDocument(text, yaml, schema);
    text = joinTopLevel(dropOverrides(document.parts, [id], yaml, schema).parts);
    commit(patchPath, text, yaml, schema, lang);
    return { action: 'removed', id };
  });
}

/**
 * Re-run one loader entry so its plugin starts again in place — the recovery
 * path for a connection that died past its reconnect budget.
 *
 * Two loader generations are supported, because the row API changed under this
 * plugin:
 * - `@deepseek-ai/cordis-plugin-loader` 1.0.3 and older (dsh ≤ 0.1.6-alpha.x)
 *   dispose a row through the private `entry._dispose()`, which also clears the
 *   entry's fiber, so the `entry.init()` that follows mounts a fresh one.
 * - 1.0.5 and newer (dsh ≥ 0.2.0-rc.x) dropped `_dispose`; the public
 *   `entry.fiber.restart()` replaces it, disposing the running plugin and
 *   re-applying it on the same fiber.
 *
 * `entry.fiber.dispose()` + `entry.init()` is deliberately NOT the newer path:
 * `init()` does not clear `entry.fiber` there, so that pair would leave a
 * second fiber behind.
 * @param entry - the live loader entry for the server.
 * @param serverName - the server's namespace, for messages.
 * @param lang - response language for messages.
 */
async function remountEntry(entry, serverName, lang) {
  if (typeof entry._dispose === 'function' && typeof entry.init === 'function') {
    await entry._dispose();
    await entry.init();
    return;
  }
  const fiber = entry.fiber;
  if (fiber === undefined || fiber.state === FIBER_DISPOSED) {
    throw new Error(tr(lang, 'restartUnmounted', { name: serverName }));
  }
  if (typeof fiber.restart !== 'function') {
    throw new Error(tr(lang, 'restartUnsupported'));
  }
  await fiber.restart();
}

/**
 * Restart one server's live connection by disposing and re-initializing its
 * loader entry. The row's configuration is untouched, so a server whose
 * transport died — a crashed stdio child past its reconnect budget — recovers
 * without a process restart.
 * @param ctx - host context.
 * @param input - `{ id }`.
 * @param lang - response language for messages.
 * @returns a message describing what happened.
 */
async function restartServer(ctx, input, lang = 'zh') {
  const id = typeof input.id === 'string' ? input.id : '';
  if (id === '') throw new Error(tr(lang, 'rowMissingId'));
  const { patchPath, profileDir } = resolvePatchPath(ctx);
  const { yaml, schema } = await loadYaml(ctx);
  const document = readDocument(readPatchText(patchPath), yaml, schema);
  const statusReaders = await prepareStatusReaders(ctx, profileDir);
  const inventory = buildInventory(ctx, document, lang, statusReaders);
  const server = inventory.servers.find((entry) => entry.id === id);
  if (server === undefined) throw new Error(tr(lang, 'restartTargetMissing', { id }));
  if (!server.enabled) throw new Error(tr(lang, 'restartDisabled', { name: server.serverName }));
  const entry = findEntry(ctx, server.serverName);
  if (entry === undefined) throw new Error(tr(lang, 'restartUnmounted', { name: server.serverName }));
  await remountEntry(entry, server.serverName, lang);
  return tr(lang, 'restarted', { name: server.serverName });
}

/**
 * Bind one server to a set of project directories, or clear its binding.
 *
 * An empty path list clears the binding and returns the server to "available in
 * every project". The server must already exist in the inventory: binding a
 * name nothing serves would look configured and never do anything.
 *
 * The write lands in the binding table, not the patch layer, so it takes effect
 * in the running process immediately — no loader generation is involved. Live
 * agents are re-synced here as well, so an open session sees the change on its
 * next step.
 * @param ctx - host context.
 * @param input - `{ serverName, paths }`.
 * @param lang - response language for error messages.
 * @returns `{ action, serverName, paths, message }`.
 */
async function bindServer(ctx, input, lang = 'zh') {
  const serverName = typeof input.serverName === 'string' ? input.serverName.trim() : '';
  const invalid = validateServerName(serverName, lang);
  if (invalid !== null) throw new Error(invalid);

  const { patchPath, profileDir } = resolvePatchPath(ctx);
  const { yaml, schema } = await loadYaml(ctx);
  const document = readDocument(readPatchText(patchPath), yaml, schema);
  const statusReaders = await prepareStatusReaders(ctx, profileDir);
  const known = buildInventory(ctx, document, lang, statusReaders).servers.some(
    (server) => server.serverName === serverName,
  );
  if (!known) throw new Error(tr(lang, 'bindUnknownServer', { name: serverName }));

  const submitted = Array.isArray(input.paths) ? input.paths : [];
  const paths = [];
  for (const item of submitted) {
    if (typeof item !== 'string' || item.trim() === '') continue;
    const accepted = normalizeBindingPath(item);
    if (accepted === null) {
      throw new Error(tr(lang, 'bindPathsAbsolute', { path: item.trim() }));
    }
    if (paths.some((existing) => pathKey(existing) === pathKey(accepted))) continue;
    paths.push(accepted);
  }

  const table = readBindings(ctx);
  const servers = { ...table.servers };
  if (paths.length === 0) delete servers[serverName];
  else servers[serverName] = { paths };
  writeBindings(ctx, servers);
  syncAllAgents(ctx);

  return {
    action: paths.length === 0 ? 'cleared' : 'bound',
    serverName,
    paths,
    message:
      paths.length === 0
        ? tr(lang, 'bindCleared', { name: serverName })
        : tr(lang, 'bindSaved', { name: serverName }),
  };
}

/**
 * Import servers from a pasted configuration document. The document may come
 * from any of the tools this module's parser understands — Claude Code, Cursor,
 * VS Code, Codex, OpenCode, Continue, Pi, Cherry Studio, Windsurf, Qoder,
 * CodeBuddy, TRAE, ZCode, or this plugin's own output — because the parser
 * normalizes their dialects. See `./import.js` for the shape table.
 *
 * `input.originalName` turns this into a single-server EDIT from the JSON
 * editor: the paste is then expected to describe exactly the row named by
 * `originalName`, and renaming it there renames that row (keeping its id and
 * its overrides) instead of creating a second server beside it.
 * @param ctx - host context.
 * @param input - `{ json, originalName? }` (json may be a string or object).
 * @param lang - response language for messages.
 * @returns `{ message, created, updated }`.
 */
async function importServers(ctx, input, lang = 'zh') {
  const { servers: parsed, source } = parseMcpConfig(input.json);

  const originalName = typeof input.originalName === 'string' ? input.originalName.trim() : '';
  if (originalName !== '') return importSingleEdit(ctx, parsed, originalName, source, lang);

  // Re-importing a configuration is an ordinary way to update a server, so an
  // entry naming one that already exists is sent as an edit rather than
  // refused as a duplicate.
  const { patchPath } = resolvePatchPath(ctx);
  const { yaml, schema } = await loadYaml(ctx);
  const existing = new Set(
    readDocument(readPatchText(patchPath), yaml, schema)
      .rows.map((row) => row.config.serverName)
      .filter((name) => typeof name === 'string'),
  );

  const created = [];
  const updated = [];
  const skipped = [];
  for (const entry of parsed) {
    const serverName = entry.serverName;
    if (serverName === '') {
      skipped.push(tr(lang, 'importUnnamed'));
      continue;
    }
    // One bad entry must not abandon the rest of a paste: the others are
    // usually fine, so report the failure and keep going.
    try {
      const result = await saveServer(ctx, {
        serverName,
        originalName: existing.has(serverName) ? serverName : undefined,
        transport: entry.transport,
        command: entry.command,
        args: entry.args,
        env: entry.env,
        cwd: entry.cwd,
        url: entry.url,
        headers: entry.headers,
      }, lang);
      (result.action === 'created' ? created : updated).push(result.serverName);
    } catch (error) {
      skipped.push(`${serverName}（${String(error?.message ?? error)}）`);
    }
  }

  if (created.length === 0 && updated.length === 0) {
    throw new Error(tr(lang, 'importNone', { detail: skipped.join(lang === 'en' ? '; ' : '；') }));
  }

  const parts = [tr(lang, 'importRecognized', { source })];
  if (created.length > 0) parts.push(tr(lang, 'importCreated', { names: joinList(lang, created) }));
  if (updated.length > 0) parts.push(tr(lang, 'importUpdated', { names: joinList(lang, updated) }));
  if (skipped.length > 0) parts.push(tr(lang, 'importSkipped', { names: skipped.join(lang === 'en' ? '; ' : '；') }));
  return { message: parts.join(lang === 'en' ? '; ' : '；'), created, updated, skipped };
}

/**
 * Apply a JSON-editor paste to exactly one existing server.
 *
 * The paste is the whole row, so it must describe one server and no more: a
 * document naming several would leave the user guessing which one won. The
 * entry's own name is what the row becomes, so renaming inside the JSON is a
 * rename of that row — `originalName` is what keeps it from turning into a new
 * server beside the old one.
 * @param ctx - host context.
 * @param parsed - servers the paste described.
 * @param originalName - the row being edited.
 * @param source - the detected dialect, for the message.
 * @param lang - response language for messages.
 * @returns `{ message, created, updated }`.
 */
async function importSingleEdit(ctx, parsed, originalName, source, lang = 'zh') {
  if (parsed.length === 0) throw new Error(tr(lang, 'noServerEntries'));
  if (parsed.length > 1) {
    const names = joinList(lang, parsed.map((entry) => entry.serverName));
    throw new Error(tr(lang, 'editSingleOnly', { count: parsed.length, names }));
  }

  const entry = parsed[0];
  const serverName = entry.serverName !== '' ? entry.serverName : originalName;
  const result = await saveServer(ctx, {
    serverName,
    originalName,
    transport: entry.transport,
    command: entry.command,
    args: entry.args,
    env: entry.env,
    cwd: entry.cwd,
    url: entry.url,
    headers: entry.headers,
  }, lang);

  const renamed = serverName !== originalName ? tr(lang, 'renamedFrom', { name: originalName }) : '';
  return {
    message: tr(lang, 'importEditUpdated', { source, name: serverName }) + renamed,
    created: [],
    updated: [serverName],
    skipped: [],
  };
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────

/** Read a JSON request body with a size ceiling. */
async function readJsonBody(req, lang = 'zh', limitBytes = 512 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error(tr(lang, 'bodyTooLarge'));
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(tr(lang, 'badJson', { detail: String(error?.message ?? error) }));
  }
}

/** Whether a request originated on the loopback interface. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

export const name = 'dsh-mcp-manager-plus';
// `tools` is a hard dependency, not a `ctx.get` probe: the project-binding
// guard and the agent-scoped restrictions are the whole of this plugin's
// enforcement, and a declared service parks the plugin until its provider
// exists rather than silently applying with no enforcer.
export const inject = ['webServer', 'tools'];

/**
 * Register the management API on the harness web server.
 * @param ctx - host context carrying `webServer`.
 */
export function apply(ctx) {
  /** Last inventory snapshot, so a burst of page loads costs one file read. */
  let cache = null;

  const listServers = async (lang = 'zh') => {
    const { patchPath, profileDir } = resolvePatchPath(ctx);
    const now = Date.now();
    if (cache !== null && now - cache.at < CACHE_TTL_MS && cache.patchPath === patchPath) {
      return cache.value;
    }
    const { yaml, schema, degraded, source } = await loadYaml(ctx);
    const document = readDocument(readPatchText(patchPath), yaml, schema);
    const statusReaders = await prepareStatusReaders(ctx, profileDir);
    const inventory = buildInventory(ctx, document, lang, statusReaders);
    // Say so rather than silently parsing with a weaker engine: the user's
    // patch file is still fully managed, but a report that mentions it saves a
    // round trip.
    if (degraded) inventory.issues.push(tr(lang, 'yamlDegraded', { source }));
    // Report writability before an edit rather than after one fails. Probing
    // the directory covers a patch file that does not exist yet; probing the
    // file covers one that a previous tool left read-only.
    let writable = true;
    try {
      if (existsSync(patchPath)) accessSync(patchPath, constants.W_OK);
      else accessSync(dirname(patchPath), constants.W_OK);
    } catch {
      writable = false;
    }
    const value = {
      patchPath,
      bindingsPath: resolveBindingsPath(ctx),
      profileDir,
      writable,
      servers: inventory.servers,
      issues: inventory.issues,
    };
    cache = { at: now, patchPath, value };
    return value;
  };

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const lang = requestLang(url);
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: tr(lang, 'loopbackOnly') });
      return;
    }
    const route = url.pathname.slice(API_PREFIX.length);

    try {
      if (route === '/servers' && req.method === 'GET') {
        sendJson(res, 200, await listServers(lang));
        return;
      }
      if (route === '/refresh' && req.method === 'POST') {
        cache = null;
        sendJson(res, 200, await listServers(lang));
        return;
      }
      if (route === '/save' && req.method === 'POST') {
        const result = await saveServer(ctx, await readJsonBody(req, lang), lang);
        cache = null;
        sendJson(res, 200, { ok: true, ...result, state: await listServers(lang) });
        return;
      }
      if (route === '/toggle' && req.method === 'POST') {
        const result = await toggleServer(ctx, await readJsonBody(req, lang), lang);
        cache = null;
        sendJson(res, 200, { ok: true, ...result, state: await listServers(lang) });
        return;
      }
      if (route === '/remove' && req.method === 'POST') {
        const result = await removeServer(ctx, await readJsonBody(req, lang), lang);
        cache = null;
        sendJson(res, 200, { ok: true, ...result, state: await listServers(lang) });
        return;
      }
      if (route === '/restart' && req.method === 'POST') {
        const message = await restartServer(ctx, await readJsonBody(req, lang), lang);
        cache = null;
        sendJson(res, 200, { ok: true, message, state: await listServers(lang) });
        return;
      }
      if (route === '/bind' && req.method === 'POST') {
        const result = await bindServer(ctx, await readJsonBody(req, lang), lang);
        cache = null;
        sendJson(res, 200, { ok: true, ...result, state: await listServers(lang) });
        return;
      }
      if (route === '/import' && req.method === 'POST') {
        const result = await importServers(ctx, await readJsonBody(req, lang), lang);
        cache = null;
        sendJson(res, 200, { ok: true, ...result, state: await listServers(lang) });
        return;
      }
      sendJson(res, 404, { error: tr(lang, 'unknownRoute', { route }) });
    } catch (error) {
      sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler,
      }),
    'dsh-mcp-manager-plus: management API',
  );

  applyProjectBindings(ctx);
}

export default { name, inject, apply };
