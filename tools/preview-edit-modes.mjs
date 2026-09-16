/**
 * Render the edit dialog's mode switch and the format hint as a standalone
 * page, using the bundle's own components and stylesheet.
 *
 * The dialogs are internal to the bundle, so they are reached by exposing them
 * through a temporary export hook and then walking the element tree a minimal
 * React stub produces. The stylesheet is the plugin's real CSS, so what this
 * page shows is what the settings panel draws.
 *
 * Run with:  node tools/preview-edit-modes.mjs
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

// Expose the dialog internals for this preview only. The hook is injected here
// at load time, so the shipped bundle never carries it.
const MARKER = 'exports.name = ';
const instrumented = source.replace(
  MARKER,
  'exports.__preview = { Modal: Modal, Segmented: Segmented, FormatHint: FormatHint, '
  + 'ServerFormDialog: ServerFormDialog, ManualConfigDialog: ManualConfigDialog };\n    ' + MARKER,
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
if (P === undefined) throw new Error('could not reach the dialog internals');

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
    // A component: call it with its props AND its children, the way React
    // would. The plugin's Modal reads its body from `props.children`, so
    // dropping children here would render an empty shell.
    const props = { ...(node.props ?? {}) };
    if (node.children.length > 0) props.children = node.children.length === 1 ? node.children[0] : node.children;
    return toHtml(node.type(props));
  }
  if (typeof node.type !== 'string') return '';
  const attrs = [];
  for (const [key, value] of Object.entries(node.props ?? {})) {
    // React keeps `key`, `ref` and event handlers out of the DOM, and writes
    // SVG attributes in kebab-case. Matching that here keeps the preview
    // honest: a camelCase `strokeWidth` in the output would render as an
    // ignored attribute and the icons would look unstroked.
    if (key === 'children' || key === 'key' || key === 'ref') continue;
    if (value === undefined || value === null || typeof value === 'function' || typeof value === 'object') continue;
    const name = ATTR_NAMES[key] ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    attrs.push(`${name}="${String(value).replace(/"/g, '&quot;')}"`);
  }
  const body = node.children.length > 0
    ? node.children.map(toHtml).join('')
    : toHtml(node.props?.children);
  return `<${node.type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${body}</${node.type}>`;
}

const server = {
  serverName: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_example' },
};

const dict = {
  editTitle: '编辑 MCP 服务器',
  editJsonTitle: '编辑 MCP 服务器（JSON）',
  editJsonHint: '直接编辑该服务器的 JSON 配置。改服务名即为重命名，原有行与其启用/停用状态都会保留。',
  modeLabel: '配置模式',
  modeForm: '表单',
  modeJson: 'JSON',
  formatsSummary: '支持粘贴以下工具的 MCP 配置（点开查看容器键）',
  formatsFooter: '键名不同也能识别，无需改写；支持 JSON 注释与尾逗号。',
  manualWarn: '配置前请确认来源，甄别风险',
  manualPlaceholder: '',
  name: '服务名',
  nameHint: '仅字母、数字、下划线和连字符，1–32 个字符。',
  transport: '连接方式',
  transportStdio: 'STDIO（本地命令）',
  transportHttp: 'Streamable HTTP（远程地址）',
  command: '命令',
  commandHint: '例如 npx、uvx，或可执行文件的绝对路径。',
  args: '参数',
  argsHint: '每行一个参数。',
  env: '环境变量',
  envHint: '每行一个 KEY=VALUE。',
  cwd: '工作目录',
  cwdHint: '可选；留空则继承当前工作目录。',
  url: 'URL',
  urlHint: '例如 http://localhost:3000/mcp',
  headers: '请求头',
  headersHint: '每行一个 KEY=VALUE。',
  cancel: '取消',
  confirm: '确认',
  saving: '保存中…',
  close: '关闭',
};
const t = (key) => dict[key] ?? key;

const formDialog = toHtml(react.createElement(P.ServerFormDialog, {
  t, server, onClose: () => {}, onDone: () => {}, onSwitchToJson: () => {},
}));
const jsonDialog = toHtml(react.createElement(P.ManualConfigDialog, {
  t, server, onClose: () => {}, onDone: () => {}, onSwitchToForm: () => {},
}));
// Open the format list so the preview shows its contents.
const jsonOpen = jsonDialog.replace('<details class="mcpmp-formats">', '<details class="mcpmp-formats" open>');

const css = styles.map((s) => s.textContent).join('\n');
const html = `<!doctype html>
<meta charset="utf-8">
<title>编辑弹窗：两种模式</title>
<style>
  body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;margin:0;padding:24px;background:#eef0f3;color:#1b1d21}
  h2{font-size:13px;margin:22px 0 10px;color:#5c6169;font-weight:500}
  h2:first-of-type{margin-top:0}
  .stage{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}
  .mcpmp-overlay{position:static;inset:auto;background:transparent;padding:0;display:block}
  .mcpmp-modal{width:660px;max-height:none}
</style>
<h2>表单模式 —— 标题右侧是新的分段开关（带滑块与图标）</h2>
<div class="stage">${formDialog}</div>
<h2>JSON 模式 —— 含「支持哪些工具」的说明（此处已展开）</h2>
<div class="stage">${jsonOpen}</div>
<style>${css}</style>
`;

const out = join(here, '..', 'edit-modes-preview.html');
writeFileSync(out, html);

const checks = [
  ['mode switch rendered', /class="mcpmp-seg"/.test(html)],
  ['sliding pill present', /mcpmp-seg-pill/.test(html)],
  ['switch is a radiogroup', /role="radiogroup"/.test(html)],
  ['both mode labels present', /表单/.test(html) && /JSON/.test(html)],
  ['switch options carry icons', (html.match(/class="mcpmp-seg-btn[^"]*"><svg/g) ?? []).length >= 2],
  ['format hint rendered', /mcpmp-formats/.test(html)],
  ['format rows present', (html.match(/class="mcpmp-format"/g) ?? []).length >= 5],
  ['container keys shown', /mcp_servers/.test(html) && /mcpServers/.test(html)],
  ['json seeded from the server', /server-github/.test(html)],
];
let bad = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) bad += 1;
}
console.log(`wrote edit-modes-preview.html (${html.length} bytes)`);
console.log(bad === 0 ? 'OK' : `${bad} PROBLEMS`);
process.exit(bad === 0 ? 0 : 1);
