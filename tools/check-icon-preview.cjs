/**
 * Structural verification of the generated icon preview, used instead of a
 * screenshot: every candidate must produce two SVGs (light + dark) and each
 * SVG must carry real geometry with plausible coordinates. This catches the
 * real failure modes — an unresolved variable reference, a truncated path, or
 * a body bled in from the next icon definition — without needing a renderer.
 */
const { readFileSync } = require('fs');
const { join } = require('path');

const html = readFileSync(join(__dirname, '..', 'icon-options.html'), 'utf8');
const cards = [...html.matchAll(/<div class="card">([\s\S]*?)<div class="nm">([\s\S]*?)<\/div>/g)];
const problems = [];
const seen = new Map();

for (const card of cards) {
  const [body, meta] = [card[1], card[2]];
  const name = /(Icon[A-Za-z0-9]+)/.exec(meta)?.[1] ?? '?';
  const svgs = [...body.matchAll(/<svg[^>]*viewBox="([^"]+)"[^>]*>([\s\S]*?)<\/svg>/g)];

  if (svgs.length !== 2) problems.push(`${name}: expected 2 svgs (light+dark), got ${svgs.length}`);
  if (/未能解析/.test(body)) problems.push(`${name}: marked unresolved`);

  for (const [, viewBox, inner] of svgs) {
    if (!/<(path|ellipse|circle|rect|g|polygon|line)\b/.test(inner)) {
      problems.push(`${name}: svg has no geometry`);
      continue;
    }
    // Every numeric attribute must be a finite number: a NaN or an unresolved
    // identifier leaking through shows up here.
    for (const attr of inner.matchAll(/\b(d|cx|cy|r|rx|ry|x|y|width|height|stroke-width)="([^"]*)"/g)) {
      const [key, value] = [attr[1], attr[2]];
      if (key === 'd') {
        // SVG path grammar: commands, separators, and numbers — including
        // exponent form, which the real icons do use (`1.80598e-05`).
        if (!/^[MmZzLlHhVvCcSsQqTtAa0-9.,\s+eE+-]+$/.test(value)) {
          problems.push(`${name}: path data has unexpected characters: ${value.slice(0, 40)}`);
        }
        if (value.length < 8) problems.push(`${name}: path data looks truncated: ${value}`);
        // An unresolved identifier would leave a bare name behind.
        if (/[A-Za-z_$]/.test(value.replace(/[MmZzLlHhVvCcSsQqTtAaEe]/g, ''))) {
          problems.push(`${name}: path data carries an unresolved identifier`);
        }
      } else if (!Number.isFinite(Number(value))) {
        problems.push(`${name}: non-numeric ${key}="${value}"`);
      }
    }
    // Coordinates should sit inside a sane box for a 14/16 viewBox.
    const box = Number(viewBox.split(' ')[2]);
    for (const num of inner.matchAll(/\b(?:cx|cy|r|rx|ry|x|y)="([\d.]+)"/g)) {
      if (Number(num[1]) > box * 1.6) problems.push(`${name}: coordinate ${num[1]} far outside a ${box}px box`);
    }
  }

  // A body bled in from the next definition usually shows up as a duplicate.
  const key = svgs[0]?.[2];
  if (key !== undefined) {
    if (seen.has(key)) problems.push(`${name}: identical body to ${seen.get(key)}`);
    else seen.set(key, name);
  }
}

console.log(`cards checked : ${cards.length}`);
console.log(`distinct icons: ${seen.size}`);
if (problems.length === 0) {
  console.log('OK: every icon has two SVGs, real geometry, and sane coordinates');
  process.exit(0);
}
console.log(`PROBLEMS (${problems.length}):`);
for (const p of problems) console.log('  - ' + p);
process.exit(1);
