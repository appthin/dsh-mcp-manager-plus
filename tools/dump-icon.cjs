/** Print the resolved SVG markup for one icon, for hand-copying into the plugin. */
const { readFileSync } = require('fs');
const { join } = require('path');

const bundle = join(
  'D:\\programs\\nvm\\v24.2.0\\node_modules\\@deepseek-ai\\dsh\\node_modules',
  '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets', 'index-C04Zg7TP.js',
);
const raw = readFileSync(bundle, 'utf8');

const name = process.argv[2] ?? 'IconLinkOutline16';
const tableStart = raw.indexOf('IconAgentPresetOutline16:');
const table = raw.slice(tableStart, tableStart + 3000);
const map = {};
for (const m of table.slice(0, table.indexOf('}')).matchAll(/(Icon[A-Za-z0-9]+):([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
  map[m[1]] = m[2];
}

const variable = map[name];
if (variable === undefined) throw new Error(`no such icon: ${name}`);
const at = raw.indexOf(`${variable}=(`);
const source = raw.slice(at, at + 6000);
const viewBox = /viewBox:"([^"]+)"/.exec(source)[1];

function resolve(id) {
  const i = raw.indexOf(`${id}=`);
  if (i < 0) return undefined;
  const v = raw.slice(i + id.length + 1, i + id.length + 400);
  const lit = /^"((?:[^"\\]|\\.)*)"/.exec(v);
  return lit === null ? undefined : lit[1];
}

const rest = source.slice(source.indexOf('children:') + 'children:'.length);
let inner;
if (rest.startsWith('[')) {
  inner = rest.slice(1, rest.indexOf(']})'));
} else {
  const single = /^u\.jsxs?\("([a-zA-Z]+)",(\{[\s\S]*?\})\)/.exec(rest);
  inner = `u.jsx("${single[1]}",${single[2]})`;
}

console.log(`icon    : ${name}`);
console.log(`variable: ${variable}`);
console.log(`viewBox : ${viewBox}`);
console.log('--- raw children ---');
console.log(inner);
console.log('--- resolved attributes ---');
for (const m of inner.matchAll(/u\.jsxs?\("([a-zA-Z]+)",(\{[\s\S]*?\})\)/g)) {
  const [, tag, props] = m;
  console.log(`<${tag}>`);
  for (const pm of props.matchAll(/([A-Za-z][A-Za-z0-9]*)\s*:\s*("(?:[^"\\]|\\.)*"|\{[^}]*\}|[A-Za-z0-9_$]+)/g)) {
    const key = pm[1];
    if (key === 'children') continue;
    let value = pm[2];
    if (value.startsWith('{')) { console.log(`  ${key} = <object> (skipped)`); continue; }
    if (value.startsWith('"')) value = value.slice(1, -1);
    else value = resolve(value) ?? '<UNRESOLVED>';
    console.log(`  ${key} = ${value}`);
  }
}
