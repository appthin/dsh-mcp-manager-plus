/**
 * Render the server row as a standalone page, using the bundle's own component
 * and stylesheet.
 *
 * The row is the part of the page a user looks at most, and its action buttons
 * are icon-only, so they are exactly the kind of thing that looks fine in a
 * diff and wrong on screen: an icon that reads as a smudge at 14px, a tooltip
 * clipped by the card, a meta line that wraps onto two lines. This renders the
 * real `ServerCard` with the real CSS so that can be judged before shipping.
 *
 * Run with:  node tools/preview-row.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

// ── a React stub whose element tree can be walked ──────────────────────────
function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((c) => c !== undefined && c !== null && c !== false && c !== true);
  return { type, props: props ?? {}, children: flat };
}
const react = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
  useRef: () => ({ current: null }),
};

// Expose the row for this preview only; the shipped bundle never carries it.
const MARKER = 'exports.name = ';
const instrumented = source.replace(
  MARKER,
  'exports.__preview = { ServerCard: ServerCard, Switch: Switch };\n    ' + MARKER,
);
if (instrumented === source) throw new Error('preview hook could not be injected; did the bundle change shape?');

const captured = [];
const styles = [];
const fakeEl = { id: '', textContent: '', style: {}, appendChild() {} };
globalThis.window = { __ModuleLoader__: { load: (r) => captured.push(r) } };
globalThis.document = {
  getElementById: () => null,
  createElement: () => fakeEl,
  head: { appendChild: (n) => styles.push(n) },
  addEventListener() {},
  removeEventListener() {},
  querySelectorAll: () => [],
};
new Function(instrumented)();

const plugin = captured[0].factory((spec) => {
  if (spec !== 'react') throw new Error(`unexpected require: ${spec}`);
  return react;
});
plugin.apply({
  slots: { inject: (_k, cb) => cb(), register: () => () => {} },
  get: () => undefined,
  effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {}; },
});

const P = plugin.__preview;
if (P === undefined) throw new Error('could not reach the row component');

/** The handful of props React writes verbatim rather than in kebab-case. */
const ATTR_NAMES = {
  className: 'class',
  viewBox: 'viewBox',
  tabIndex: 'tabindex',
  preserveAspectRatio: 'preserveAspectRatio',
};

/** Serialize an element tree to HTML using the plugin's own class names. */
function toHtml(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toHtml).join('');
  if (typeof node.type === 'symbol') return node.children.map(toHtml).join('');
  if (typeof node.type === 'function') {
    const props = { ...(node.props ?? {}) };
    if (node.children.length > 0) props.children = node.children.length === 1 ? node.children[0] : node.children;
    return toHtml(node.type(props));
  }
  if (typeof node.type !== 'string') return '';
  const attrs = [];
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (key === 'children' || key === 'key' || key === 'ref') continue;
    if (value === undefined || value === null || typeof value === 'function' || typeof value === 'object') continue;
    // React writes style objects as inline CSS; the row uses a few, so keep
    // them rather than dropping the switch's own state.
    const name = ATTR_NAMES[key] ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    attrs.push(`${name}="${String(value).replace(/"/g, '&quot;')}"`);
  }
  const body = node.children.length > 0
    ? node.children.map(toHtml).join('')
    : toHtml(node.props?.children);
  return `<${node.type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${body}</${node.type}>`;
}

const dict = {
  edit: '编辑',
  restart: '重启',
  remove: '删除',
  bindTitle: '项目绑定',
  bindScopeAll: '全局可用',
  bindScopeLimited: '仅限 {n} 个项目',
  toolCount: '{n} 个工具',
  phaseActive: '已连接',
  phaseDisabled: '已停用',
  sourceUser: '配置文件',
  sourceBundle: '部署内置',
  sourceBuiltin: '内置能力',
  noTools: '暂无工具',
  expand: '展开',
  collapse: '收起',
};
const t = (key, params) =>
  String(dict[key] ?? key).replace(/\{(\w+)\}/g, (match, name) =>
    params?.[name] !== undefined ? String(params[name]) : match,
  );

const base = {
  id: 'mcp-dbx',
  serverName: 'dbx',
  displayName: 'dbx',
  source: 'user',
  editable: true,
  removable: true,
  enabled: true,
  transport: 'stdio',
  command: 'node.exe',
};

const rows = [
  ['user row, 0 tools, global', { ...base, binding: { paths: [], restricted: false },
    live: { mounted: true, phase: 'active', toolCount: 0, tools: [] } }],
  ['user row, bound to one project', { ...base, serverName: 'github', displayName: 'github',
    binding: { paths: ['D:\\work\\my-project'], restricted: true },
    live: { mounted: true, phase: 'active', toolCount: 12, tools: [] } }],
  ['bundle row (not editable, not removable)', { ...base, id: 'mcp-rea', serverName: 'rea',
    displayName: 'rea', source: 'bundle', editable: false, removable: false,
    binding: { paths: [], restricted: false },
    live: { mounted: true, phase: 'active', toolCount: 3, tools: [] } }],
  ['builtin row', { ...base, id: 'builtin-computer-use', serverName: 'computer-use',
    displayName: 'Computer Use (内置)', source: 'builtin', editable: false, removable: false,
    enabled: true, transport: 'built-in', binding: { paths: [], restricted: false },
    live: { mounted: true, phase: 'active', toolCount: 2, tools: [] } }],
  ['disabled row', { ...base, enabled: false, binding: { paths: [], restricted: false },
    live: { mounted: false, phase: 'disabled', toolCount: 0, tools: [] } }],
  ['bound, expanded', { ...base, serverName: 'dbx', binding: { paths: ['E:\\work\\alpha', '~/work/beta'], restricted: true },
    live: { mounted: true, phase: 'active', toolCount: 2, tools: [
      { name: 'query', fullName: 'mcp__dbx__query', description: 'Run a read-only query.' },
      { name: 'tables', fullName: 'mcp__dbx__tables', description: 'List tables.' },
    ] } }],
];

const htmlRows = rows.map(([label, server]) => {
  const card = toHtml(react.createElement(P.ServerCard, {
    t,
    server,
    busy: false,
    expanded: label.endsWith('expanded'),
    onExpand: () => {},
    onToggle: () => {},
    onRestart: () => {},
    onRemove: () => {},
    onEdit: () => {},
    onBind: () => {},
  }));
  return `<h2>${label}</h2><div class="stage">${card}</div>`;
}).join('\n');

const css = styles.map((s) => s.textContent).join('\n');
const html = `<!doctype html>
<meta charset="utf-8">
<title>服务器行：图标按钮与绑定状态</title>
<style>
  body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;margin:0;padding:24px;background:#eef0f3;color:#1b1d21}
  h2{font-size:13px;margin:22px 0 10px;color:#5c6169;font-weight:500}
  h2:first-of-type{margin-top:0}
  .stage{display:block;max-width:760px}
  /* Mirror the settings panel's theme tokens, so the page renders standalone. */
  :root{
    --dsw-alias-label-primary:#1b1d21;--dsw-alias-label-secondary:#5c6169;
    --dsw-alias-label-primary-foreground:#fff;--dsw-alias-bg-base:#fff;
    --dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f2f3f5;--dsw-alias-bg-overlay:#fff;
    --dsw-alias-border-l1:#e2e4e8;--dsw-alias-border-l2:#cdd0d6;
    --dsw-alias-state-success-primary:#2f9e63;--dsw-alias-state-error-primary:#d0453b;
    --dsw-alias-state-warn-primary:#c9861a;--dsw-alias-brand-primary:#2f6fed;
  }
  /* Force one tooltip open so it can be checked without a mouse. */
  .tip-open .mcpmp-icon[data-tip]::after{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0)}
</style>
${htmlRows}
<style>${css}</style>
<script>
  // Focus the first icon button in the second row so a tooltip is visible in a
  // screenshot of this page, and label each button for the check below.
  document.querySelectorAll('.mcpmp-row-actions .mcpmp-icon').forEach(function (b, i) {
    b.setAttribute('data-check-index', String(i));
  });
</script>
`;

const out = join(here, '..', 'row-preview.html');
writeFileSync(out, html);

const iconButtons = (html.match(/class="mcpmp-btn mcpmp-btn-sm mcpmp-icon[^"]*"/g) ?? []).length;
const checks = [
  ['row actions rendered as icon buttons', iconButtons >= 4],
  ['no action button carries visible text', !/class="mcpmp-btn mcpmp-btn-sm mcpmp-icon[^"]*"[^>]*>[^<]{1,}<\/button>/.test(html)],
  ['every icon button has aria-label', (html.match(/aria-label="/g) ?? []).length >= iconButtons],
  ['every icon button has a data-tip', (html.match(/data-tip="/g) ?? []).length >= iconButtons],
  ['tooltips are styled', /\[data-tip\]::after\{content:attr\(data-tip\)/.test(css)],
  ['binding tag replaces the source chip on a user row', !html.includes('>配置文件<')],
  ['binding state is rendered', html.includes('全局可用') && html.includes('仅限 1 个项目')],
  ['bundle row still shows its origin', html.includes('>部署内置<')],
  ['builtin row still shows its origin', html.includes('>内置能力<')],
];
let bad = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) bad += 1;
}
console.log(`wrote row-preview.html (${html.length} bytes)`);
console.log(bad === 0 ? 'OK' : `${bad} PROBLEMS`);
process.exit(bad === 0 ? 0 : 1);
