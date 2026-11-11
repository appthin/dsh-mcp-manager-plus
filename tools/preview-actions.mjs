/**
 * Render the row's action buttons large, and with their tooltips forced open.
 *
 * At 14px an icon either reads or turns into a smudge, and that judgement cannot
 * be made from source. This page renders the same buttons the row uses, at 1x and
 * magnified, with the tooltip stylesheet live — so the glyph legibility and the
 * tooltip's position can both be checked without hover.
 *
 * Run with:  node tools/preview-actions.mjs
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
const instrumented = source.replace(
  MARKER,
  'exports.__preview = { Icon: Icon, ICON_PATH: ICON_PATH };\n    ' + MARKER,
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

const { Icon, ICON_PATH } = plugin.__preview;

/**
 * Serialize a raw <svg> the way `Icon` builds it. This is deliberately not a
 * generic tree walker: the point is the exact markup `Icon` emits, and copying
 * that attribute set keeps the preview honest about stroke width and size.
 */
function svgOf(pathNode, size) {
  const d = pathNode.props.d;
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" `
    + `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
    + `<path d="${d}"></path></svg>`;
}

const ACTIONS = [
  { key: 'edit', label: '编辑', icon: ICON_PATH.edit },
  { key: 'restart', label: '重启', icon: ICON_PATH.refresh },
  { key: 'remove', label: '删除', icon: ICON_PATH.trash, danger: true },
  { key: 'bind', label: '项目绑定', icon: ICON_PATH.bind },
  { key: 'bind-on', label: '项目绑定', icon: ICON_PATH.bind, active: true },
];

const button = (action, { tip = false, text = false } = {}) =>
  `<button type="button" class="mcpmp-btn mcpmp-btn-sm mcpmp-icon${action.danger ? ' mcpmp-btn-danger' : ''}`
  + `${action.active ? ' mcpmp-btn-bound' : ''}${tip ? ' tip-on' : ''}" `
  + `title="${action.label}" aria-label="${action.label}" data-tip="${action.label}">`
  + `${text ? `<span>${action.label}</span>` : svgOf(action.icon, 14)}</button>`;

const css = styles.map((s) => s.textContent).join('\n');

const html = `<!doctype html>
<meta charset="utf-8">
<title>行内图标按钮：字形与提示</title>
<style>
  body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;margin:0;padding:24px 32px 96px;background:#eef0f3;color:#1b1d21}
  h2{font-size:13px;margin:26px 0 12px;color:#5c6169;font-weight:500}
  h2:first-of-type{margin-top:0}
  p.note{margin:0 0 10px;color:#6a7078;font-size:12px}
  .rack{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;background:#fff;border:1px solid #e2e4e8;border-radius:10px;padding:18px 16px}
  /* Room above each rack so a tooltip is not clipped by the box. */
  .rack{padding-top:44px}
  .zoom{transform:scale(3);transform-origin:top left}
  .zoom-wrap{height:150px;overflow:hidden}
  :root{
    --dsw-alias-label-primary:#1b1d21;--dsw-alias-label-secondary:#5c6169;
    --dsw-alias-label-primary-foreground:#fff;--dsw-alias-bg-base:#fff;
    --dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f2f3f5;--dsw-alias-bg-overlay:#fff;
    --dsw-alias-border-l1:#e2e4e8;--dsw-alias-border-l2:#cdd0d6;
    --dsw-alias-state-success-primary:#2f9e63;--dsw-alias-state-error-primary:#d0453b;
    --dsw-alias-state-warn-primary:#c9861a;--dsw-alias-brand-primary:#2f6fed;
  }
  /* Force the tooltip open on the marked buttons, so it can be judged without
     a mouse. Same declarations the plugin's own :hover rule applies. */
  .tip-on::after{opacity:1!important;visibility:visible!important;transform:translateX(-50%) translateY(0)!important}
</style>
<h2>逐个悬停（每次只开一个，看提示如何定位）</h2>
<p class="note">真实使用中同时只会有一个提示，这里逐行验证每个按钮的提示位置与文本。</p>
${ACTIONS.map((action) => `<div class="rack">${ACTIONS.map((a) => button(a, { tip: a === action })).join('')}</div>`).join('')}

<h2>实际尺寸 · 未悬停（看字形本身）</h2>
<div class="rack">${ACTIONS.map((a) => button(a)).join('')}</div>

<h2>放大 3× · 检查笔画是否糊在一起</h2>
<div class="rack zoom-wrap"><div class="zoom">${ACTIONS.map((a) => button(a)).join('')}</div></div>

<h2>对照：带文字的按钮（原来的样子）</h2>
<div class="rack">${ACTIONS.map((a) => button(a, { text: true })).join('')}</div>
<style>${css}</style>
`;

const out = join(here, '..', 'actions-preview.html');
writeFileSync(out, html);

const checks = [
  ['five action buttons rendered', (html.match(/class="mcpmp-btn mcpmp-btn-sm mcpmp-icon/g) ?? []).length >= 5],
  ['danger button keeps its colour class', html.includes('mcpmp-icon mcpmp-btn-danger')],
  ['bound button keeps its active class', html.includes('mcpmp-icon mcpmp-btn-bound')],
  ['tooltips forced open', /tip-on/.test(html) && /\[data-tip\]:hover::after/.test(css)],
];
let bad = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) bad += 1;
}
console.log(`wrote actions-preview.html (${html.length} bytes)`);
console.log(bad === 0 ? 'OK' : `${bad} PROBLEMS`);
process.exit(bad === 0 ? 0 : 1);
