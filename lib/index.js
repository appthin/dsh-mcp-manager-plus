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

import { accessSync, constants, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
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

/** Route prefix for this plugin's API. */
const API_PREFIX = '/mcp-manager-plus';
/** How long a listing may be reused, in ms. */
const CACHE_TTL_MS = 300;
/** Config keys whose values never travel to the browser in the clear. */
const SECRET_KEY_RE = /KEY|PASSWORD|SECRET|TOKEN/i;
/** The mask the browser receives and may echo back unchanged. */
const SECRET_MASK = '••••••••';
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
 * @param ctx - host context, used to anchor resolution at the profile directory.
 * @returns the module plus a schema able to round-trip `!!js` scalars.
 */
async function loadYaml(ctx) {
  const yaml = await resolveYaml(resolvePatchPath(ctx).profileDir);
  const jsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
    predicate: (value) =>
      value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string',
    represent: (value) => value.__jsExpr,
  });
  return { yaml, schema: yaml.JSON_SCHEMA.extend(jsExpr) };
}

/** Resolve the `js-yaml` module, preferring the profile's own copy. */
async function resolveYaml(anchorDir) {
  const candidates = [];
  if (typeof anchorDir === 'string' && anchorDir !== '') candidates.push(anchorDir);
  // The plugin's own package directory: an installed copy sits inside the
  // profile's node_modules, so this reaches the same hoisted `js-yaml` even
  // when the profile directory could not be resolved from the loader.
  candidates.push(dirname(fileURLToPath(import.meta.url)));
  candidates.push(process.cwd());
  const home = dshHome();
  candidates.push(join(home, 'profiles', argvProfile() ?? 'web'));
  candidates.push(join(home, 'profiles'));

  for (const anchor of candidates) {
    try {
      const require = createRequire(join(anchor, 'package.json'));
      const loaded = await import(pathToFileURL(require.resolve('js-yaml')).href);
      return loaded.default ?? loaded;
    } catch {
      // Try the next anchor.
    }
  }
  // Last resort: an ordinary bare import, which succeeds when this package was
  // installed with `js-yaml` as a real dependency.
  const loaded = await import('js-yaml');
  return loaded.default ?? loaded;
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

/** Resolve a `file://` URL or plain path to a native path. */
function fromFileUrl(value) {
  if (!value.startsWith('file://')) return value;
  try {
    const path = new URL(value).pathname;
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

// ── live-state reads ────────────────────────────────────────────────────────

/** Cordis fiber states, mirrored as the readable phase the browser shows. */
const FIBER_PHASE = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: null, 5: 'unloading' };

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
 * @returns `{ servers, issues }`.
 */
function buildInventory(ctx, document, lang = 'zh') {
  const issues = [...document.issues];
  const servers = [];
  const claimed = new Set();

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
      live: {
        mounted: entry !== undefined,
        phase: phaseOf(entry, disabled),
        toolCount: tools.length,
        tools,
      },
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
        live: {
          mounted: entry.fiber !== undefined,
          phase: phaseOf(entry, off),
          toolCount: tools.length,
          tools,
        },
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
  const { patchPath } = resolvePatchPath(ctx);
  const { yaml, schema } = await loadYaml(ctx);
  const document = readDocument(readPatchText(patchPath), yaml, schema);
  const inventory = buildInventory(ctx, document, lang);
  const server = inventory.servers.find((entry) => entry.id === id);
  if (server === undefined) throw new Error(tr(lang, 'restartTargetMissing', { id }));
  if (!server.enabled) throw new Error(tr(lang, 'restartDisabled', { name: server.serverName }));
  const entry = findEntry(ctx, server.serverName);
  if (entry === undefined) throw new Error(tr(lang, 'restartUnmounted', { name: server.serverName }));
  if (typeof entry._dispose !== 'function' || typeof entry.init !== 'function') {
    throw new Error(tr(lang, 'restartUnsupported'));
  }
  await entry._dispose();
  await entry.init();
  return tr(lang, 'restarted', { name: server.serverName });
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
export const inject = ['webServer'];

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
    const { yaml, schema } = await loadYaml(ctx);
    const document = readDocument(readPatchText(patchPath), yaml, schema);
    const inventory = buildInventory(ctx, document, lang);
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
}

export default { name, inject, apply };
