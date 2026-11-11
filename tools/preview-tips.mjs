/**
 * Render real cards with one tooltip forced open, to check two things that only
 * show up together: that the tip escapes the card (the card must not clip), and
 * that the card's rounded bottom corner still survives without `overflow:hidden`.
 *
 * Run with:  node tools/preview-tips.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

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

const MARKER = 'exports.name = ';
const instrumented = source.replace(MARKER, 'exports.__preview = { ServerCard: ServerCard };\n    ' + MARKER);
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

const ATTR_NAMES = { className: 'class', viewBox: 'viewBox', tabIndex: 'tabindex' };
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
    const name = ATTR_NAMES[key] ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    attrs.push(`${name}="${String(value).replace(/"/g, '&quot;')}"`);
  }
  const body = node.children.length > 0 ? node.children.map(toHtml).join('') : toHtml(node.props?.children);
  return `<${node.type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${body}</${node.type}>`;
}

const dict = {
  edit: '编辑', restart: '重启', remove: '删除', bindTitle: '项目绑定',
  bindScopeAll: '全局可用', bindScopeLimited: '仅限 {n} 个项目', toolCount: '{n} 个工具',
  phaseActive: '已连接', sourceUser: '配置文件', sourceBundle: '部署内置',
  noTools: '暂无工具', expand: '展开', collapse: '收起',
};
const t = (key, params) =>
  String(dict[key] ?? key).replace(/\{(\w+)\}/g, (m, n) => (params?.[n] !== undefined ? String(params[n]) : m));

const card = (server, expanded = false) =>
  toHtml(react.createElement(plugin.__preview.ServerCard, {
    t, server, busy: false, expanded,
    onExpand: () => {}, onToggle: () => {}, onRestart: () => {},
    onRemove: () => {}, onEdit: () => {}, onBind: () => {},
  }));

const base = {
  id: 'mcp-x', serverName: 'dbx', displayName: 'dbx', source: 'user',
  editable: true, removable: true, enabled: true, transport: 'stdio', command: 'x',
  binding: { paths: [], restricted: false },
  live: { mounted: true, phase: 'active', toolCount: 0, tools: [] },
};

const css = styles.map((s) => s.textContent).join('\n');
const html = `<!doctype html>
<meta charset="utf-8">
<title>卡片与提示：不被裁切、圆角仍在</title>
<style>
  body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;margin:0;padding:24px 32px 80px;background:#eef0f3;color:#1b1d21}
  h2{font-size:13px;margin:26px 0 10px;color:#5c6169;font-weight:500}
  h2:first-of-type{margin-top:0}
  p.note{margin:0 0 10px;color:#6a7078;font-size:12px}
  .stage{max-width:760px;display:flex;flex-direction:column;gap:8px;padding-top:34px}
  :root{
    --dsw-alias-label-primary:#1b1d21;--dsw-alias-label-secondary:#5c6169;
    --dsw-alias-label-primary-foreground:#fff;--dsw-alias-bg-base:#fff;
    --dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f2f3f5;--dsw-alias-bg-overlay:#fff;
    --dsw-alias-border-l1:#e2e4e8;--dsw-alias-border-l2:#cdd0d6;
    --dsw-alias-state-success-primary:#2f9e63;--dsw-alias-state-error-primary:#d0453b;
    --dsw-alias-state-warn-primary:#c9861a;--dsw-alias-brand-primary:#2f6fed;
  }
  /* Force ONE tip open, via the same declarations the :hover rule applies.
     Opening every tip at once would overlap them, which is not a real state. */
  .tip-first .mcpmp-row-actions>.mcpmp-icon:first-child[data-tip]::after{opacity:1!important;visibility:visible!important;transform:translateX(-50%) translateY(0)!important}
  .tip-last .mcpmp-row-actions>.mcpmp-icon:last-child[data-tip]::after{opacity:1!important;visibility:visible!important;transform:translateY(0)!important}
  /* Grid lines make a clipped tip obvious. */
  .stage{background-image:linear-gradient(to bottom,#0000 0,#0000 100%)}
</style>

<h2>第一张卡片的第一个按钮悬停：提示必须越过卡片上边缘</h2>
<p class="note">上下两张卡片紧邻，提示若被卡片裁切，就会在两张卡之间断掉。</p>
<div class="stage tip-first">
  ${card(base)}
  ${card({ ...base, serverName: 'second', displayName: 'second' })}
</div>

<h2>最后一个按钮悬停：提示右对齐，不能超出卡片右边</h2>
<div class="stage tip-last">
  ${card(base)}
</div>

<h2>展开状态：底部圆角必须还在（去掉 overflow:hidden 之后）</h2>
<div class="stage">
  ${card({ ...base, binding: { paths: ['E:\\work\\alpha'], restricted: true },
    live: { mounted: true, phase: 'active', toolCount: 1,
      tools: [{ name: 'query', fullName: 'mcp__dbx__query', description: 'Run a read-only query.' }] } }, true)}
</div>
<style>${css}</style>
`;

const out = join(here, '..', 'tips-preview.html');
writeFileSync(out, html);

const checks = [
  ['card no longer clips', !/\.mcpmp-card\{[^}]*overflow:hidden/.test(css)],
  ['card keeps a relative position for stacking', /\.mcpmp-card\{position:relative\}/.test(css)],
  ['hovered card raises above its neighbour', /\.mcpmp-card:hover[^{]*\{z-index:1\}/.test(css)],
  ['last child carries the bottom radius', /\.mcpmp-card>\*:last-child\{border-bottom-left-radius/.test(css)],
];
let bad = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) bad += 1;
}
console.log(`wrote tips-preview.html (${html.length} bytes)`);
console.log(bad === 0 ? 'OK' : `${bad} PROBLEMS`);
process.exit(bad === 0 ? 0 : 1);
