/**
 * Render the nav-row markup the settings shell produces, with this plugin's
 * icon CSS applied to it, as a standalone page.
 *
 * This is the closest thing to a screenshot that works without a browser
 * engine: it composes the exact DOM the shell draws (a `navCell` button whose
 * first child is the generic gear) and the exact rules the plugin injects, so
 * opening the result shows whether the swap actually lands on the right row
 * and inherits the row's colour in both themes.
 *
 * Run with:  node tools/preview-nav-icon.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

// Capture the stylesheet the bundle builds, by running only its top-level
// factory body far enough to reach installStyles().
const captured = [];
const styles = [];
const fakeEl = { id: '', textContent: '', style: {}, appendChild() {} };
globalThis.window = { __ModuleLoader__: { load: (r) => captured.push(r) } };
globalThis.document = {
  getElementById: () => null,
  createElement: () => fakeEl,
  head: { appendChild: (node) => styles.push(node) },
  querySelectorAll: () => [],
};
new Function(source)();

const plugin = captured[0].factory((spec) => {
  if (spec !== 'react') throw new Error(`unexpected require: ${spec}`);
  return {
    createElement: () => null, Fragment: Symbol('F'),
    useState: () => [null, () => {}], useEffect: () => {}, useCallback: (f) => f,
    useRef: () => ({ current: null }),
  };
});

// The stylesheet is injected from apply(), so apply() has to run to capture it.
plugin.apply({
  slots: {
    inject: (_key, callback) => callback(),
    register: () => () => {},
  },
  get: () => undefined,
  effect: (factory) => {
    const dispose = factory();
    return typeof dispose === 'function' ? dispose : () => {};
  },
});
if (styles.length === 0) throw new Error('apply() injected no stylesheet; the preview would be empty');

// The generic gear the shell draws for an unknown section id, and the row it
// sits in. `navCell`/`navIcon` are the shell's own hashed class names.
const gear = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.375" stroke="currentColor" stroke-width="1.25"/><path d="M8 5v6M5 8h6" stroke="currentColor" stroke-width="1.25"/></svg>';

const rows = [
  ['通用设置', false],
  ['模型', false],
  ['插件', false],
  ['Agent 预设', false],
  ['已归档会话', false],
  ['MCP 管理', true],
  ['插件市场', false],
  ['Jet Hub', false],
];

const html = `<!doctype html>
<meta charset="utf-8">
<title>导航图标覆盖效果</title>
<style>
  body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;margin:0;padding:28px;background:#f6f7f9;color:#1b1d21}
  h1{font-size:17px;margin:0 0 4px}
  p.sub{margin:0 0 20px;color:#5c6169;font-size:13px}
  .wrap{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}
  .panel{background:#fff;border:1px solid #e3e5e9;border-radius:14px;padding:14px 12px;width:230px}
  .panel.dark{background:#1b1d21;border-color:#33363c;color:#f2f3f5}
  .panel h2{font-size:12px;margin:0 0 10px;color:#7a7f88;font-weight:500}
  .navList{display:flex;flex-direction:column;gap:4px}
  .navCell{display:flex;align-items:center;gap:8px;height:40px;padding:9px 16px 9px 12px;
           border:none;border-radius:12px;background:0 0;color:inherit;font:inherit;
           cursor:pointer;text-align:left;width:100%;box-sizing:border-box}
  .navCell:hover{background:#eceef1}
  .panel.dark .navCell:hover{background:#2a2d33}
  .navCell.active{background:#eceef1}
  .panel.dark .navCell.active{background:#2a2d33}
  .navIcon{flex:none}
  .navLabel{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style>
<h1>设置侧边栏图标覆盖效果</h1>
<p class="sub">「MCP 管理」这一行应由插件打上标记并换成链条图标；其余行保持外壳原有图标。
左侧为浅色主题，右侧为深色主题 —— 图标颜色都来自行文字颜色，因此应随主题变化。</p>
<div class="wrap">
  ${['', 'dark'].map((theme) => `
  <div class="panel ${theme}">
    <h2>${theme === 'dark' ? '深色主题' : '浅色主题'}</h2>
    <div class="navList">
      ${rows.map(([label, mine]) => `<button type="button" class="navCell${mine ? ' active' : ''}"${mine ? ' data-mcpmp-nav' : ''}>${gear}<span class="navLabel">${label}</span></button>`).join('\n      ')}
    </div>
  </div>`).join('')}
</div>
<style>
${styles.map((s) => s.textContent).join('\n')}
</style>
`;

const out = join(here, '..', 'nav-icon-preview.html');
writeFileSync(out, html);

// Structural assertions, so the preview cannot silently be wrong.
const css = styles.map((s) => s.textContent).join('\n');
const ok = css.includes('button[data-mcpmp-nav]>svg:first-child{display:none}')
  && css.includes('button[data-mcpmp-nav]::before')
  && /mask-image:url\("data:image\/svg\+xml,/.test(css)
  && html.includes('data-mcpmp-nav');
console.log(`wrote nav-icon-preview.html (${html.length} bytes)`);
console.log(ok ? 'OK: swap rules present and the marked row is rendered' : 'PROBLEM: expected rules missing');
process.exit(ok ? 0 : 1);
