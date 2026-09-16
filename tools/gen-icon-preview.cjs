/**
 * Generate `icon-options.html`: render every candidate sidebar icon as real
 * SVG, in the light and dark themes, so the icon can be chosen by looking at
 * it instead of guessing from a component name.
 *
 * The definitions are read out of the shipped frontend bundle — the same
 * bundle the settings shell itself imports — so the preview cannot drift from
 * what the harness would actually draw.
 *
 * Run with:  node tools/gen-icon-preview.cjs
 */
const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');

const dshRoot = process.env.DSH_DSH_ROOT
  ?? 'D:\\programs\\nvm\\v24.2.0\\node_modules\\@deepseek-ai\\dsh';
const assetsDir = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets');

const bundle = require('fs').readdirSync(assetsDir)
  .filter((name) => /^index-.*\.js$/.test(name))
  .map((name) => join(assetsDir, name))
  .find((path) => existsSync(path) && readFileSync(path, 'utf8').includes('IconAgentPresetOutline16'));
if (bundle === undefined) throw new Error(`no frontend bundle with an icon table under ${assetsDir}`);

const raw = readFileSync(bundle, 'utf8');
const tableStart = raw.indexOf('IconAgentPresetOutline16:');
const table = raw.slice(tableStart, tableStart + 3000);
const map = {};
for (const m of table.slice(0, table.indexOf('}')).matchAll(/(Icon[A-Za-z0-9]+):([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
  map[m[1]] = m[2];
}

/** Resolve a bare identifier used as a prop value, e.g. `d:A6` → the string A6 holds. */
function resolveIdentifier(identifier) {
  const at = raw.indexOf(`${identifier}=`);
  if (at < 0) return undefined;
  const value = raw.slice(at + identifier.length + 1, at + identifier.length + 400);
  const literal = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  return literal === null ? undefined : literal[1];
}

/** Turn one icon component definition into standalone SVG markup. */
function render(name) {
  const variable = map[name];
  if (variable === undefined) return null;
  const at = raw.indexOf(`${variable}=(`);
  if (at < 0) return null;
  const source = raw.slice(at, at + 6000);

  const viewBox = /viewBox:"([^"]+)"/.exec(source)?.[1] ?? '0 0 16 16';

  // Two shapes occur: `children:[<child/>, …]` (array) and
  // `children:<child/>` (a single element).
  let inner = '';
  const open = source.indexOf('children:');
  if (open < 0) return null;
  const rest = source.slice(open + 'children:'.length);
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']})');
    if (close < 0) return null;
    inner = rest.slice(1, close);
  } else {
    // A single child: `children:u.jsx("path",{…})`. Take exactly one call —
    // the definition's own trailing `})` would otherwise be swallowed too.
    const single = /^u\.jsxs?\("([a-zA-Z]+)",(\{[\s\S]*?\})\)/.exec(rest);
    if (single === null) return null;
    inner = `u.jsx("${single[1]}",${single[2]})`;
  }

  const body = inner.replace(/u\.jsxs?\("([a-zA-Z]+)",(\{[\s\S]*?\})\)/g, (_all, tag, propsRaw) => {
    const attrs = [];
    for (const pm of propsRaw.matchAll(/([A-Za-z][A-Za-z0-9]*)\s*:\s*("(?:[^"\\]|\\.)*"|\{[^}]*\}|[A-Za-z0-9_$]+)/g)) {
      const key = pm[1];
      if (key === 'children') continue;
      let value = pm[2];
      if (value.startsWith('{')) continue; // an object literal prop: not needed for drawing
      if (value.startsWith('"')) value = value.slice(1, -1);
      else {
        // A bare identifier: these icons hoist their path data / stroke width
        // into module-level constants next to the component.
        const resolved = resolveIdentifier(value);
        if (resolved === undefined) return `<${tag} />`; // give up on this child rather than emit a broken one
        value = resolved;
      }
      attrs.push(`${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${value}"`);
    }
    // `fill:"none"` sits on the root <svg>; children carry their own fill or stroke.
    return `<${tag} fill="none" ${attrs.join(' ')} />`;
  });
  if (!/<(path|ellipse|circle|rect|g|polygon|line)\b/.test(body)) return null;
  return { viewBox, body };
}

const candidates = [
  ['IconApiOutline14', 'API 接口（插头 / 连接协议）'],
  ['IconDatabaseOutline16', '数据库'],
  ['IconDataOutline16', '数据 · 模型'],
  ['IconCordisPluginOutline14', '插件'],
  ['IconSkillOutline16', '技能 · 工具'],
  ['IconGlobeOutline14', '地球（远程服务器）'],
  ['IconLinkOutline16', '链接（连接）'],
  ['IconShieldOutline16', '盾牌（安全 / 权限）'],
  ['IconContextInjectionOutline16', '上下文注入'],
  ['IconListPenOutline16', '清单 · 工具列表'],
  ['IconCodeOutline16', '代码'],
  ['IconBranchOutline16', '分支'],
  ['IconGaugeOutline16', '仪表（运行状态）'],
  ['IconChecklistOutline14', '勾选清单'],
  ['IconBrowseOutline16', '浏览'],
  ['IconProjectAddOutline16', '项目新增'],
  ['IconSparkle16', '星火'],
  ['IconEnhanceOutline16', '增强'],
  ['IconCompactOutline16', '紧凑'],
  ['IconPlanOutline14', '计划'],
  ['IconGoalOutline16', '目标'],
  ['IconPersonalizationOutline16', '个性化（「插件」页正在用）'],
];

let html = `<!doctype html>
<meta charset="utf-8">
<title>「MCP 管理」图标候选</title>
<style>
  body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;margin:0;padding:28px;background:#f6f7f9;color:#1b1d21}
  h1{font-size:18px;margin:0 0 4px}
  p.sub{margin:0 0 22px;color:#5c6169;font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
  .card{background:#fff;border:1px solid #e3e5e9;border-radius:12px;overflow:hidden}
  .row{display:flex;align-items:center;gap:8px;padding:10px 12px;font-size:14px}
  .dark{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#1b1d21;color:#f2f3f5}
  .nm{padding:7px 12px 11px;font:11px/1.5 ui-monospace,Consolas,monospace;color:#7a7f88;word-break:break-all}
  svg{flex:none}
</style>
<h1>「MCP 管理」图标候选（共 ${candidates.length} 个）</h1>
<p class="sub">上半是浅色主题下的样子，下半是深色主题。图标名在卡片底部。</p>
<div class="grid">`;

for (const [name, label] of candidates) {
  const icon = render(name);
  const svg = icon === null
    ? '<em style="color:#c0392b">未能解析</em>'
    : `<svg width="16" height="16" viewBox="${icon.viewBox}" fill="none" color="currentColor">${icon.body}</svg>`;
  html += `<div class="card">
    <div class="row">${svg}<span>MCP 管理</span></div>
    <div class="dark" style="color:#f2f3f5">${svg.replace(/currentColor/g, 'currentColor')}<span>MCP 管理</span></div>
    <div class="nm">${label}<br>${name}</div>
  </div>`;
}
html += '</div>\n';

writeFileSync(join(__dirname, '..', 'icon-options.html'), html);
console.log(`wrote icon-options.html with ${candidates.length} candidates`);
