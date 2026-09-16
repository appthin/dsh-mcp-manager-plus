/**
 * dsh-mcp-manager-plus — profile patch-layer reader/writer.
 *
 * A profile composes its plugin tree from bundle patch layers plus the user's
 * own layer at `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. That file is a
 * top-level YAML array of loader patch entries; a user-added MCP server is one
 * of them:
 *
 *     - insert:
 *         - id: mcp-github
 *           name: '@deepseek-ai/dsh-mcp-client'
 *           config: { serverName: github, transport: stdio, ... }
 *
 * Turning a row off is a sibling entry (`- id: mcp-github` + `disabled: true`),
 * which is how the patch dialect expresses "off" for a row any layer inserted.
 * Both shapes therefore live in one file, and this module owns reading and
 * rewriting them without disturbing anything else in it.
 *
 * Two properties matter more than anything here:
 *
 * 1. **Never brick the boot.** Every candidate document is re-parsed as a
 *    top-level array before it is written; a document that does not parse is
 *    refused rather than committed.
 * 2. **Never touch what it does not own.** The file is hand-written by users.
 *    Comments, unrelated rows and unknown keys survive a rewrite verbatim;
 *    only the exact block being changed is re-emitted.
 *
 * @module dsh-mcp-manager-plus/patch
 */

import { readFileSync } from 'node:fs';

/** The MCP bridge package a managed row mounts. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

/** Row-id prefix this plugin mints for rows it creates. */
export const ROW_ID_PREFIX = 'mcp-';

/**
 * Split a document into top-level items, preserving every line that is not
 * part of an item (the preamble comment block, and any comments or blank runs
 * that trail an item).
 *
 * An item starts at a line that opens a top-level YAML sequence entry
 * (`- …`) or a top-level flow collection (`[]`, `[ ]`). Everything from that
 * line up to the line before the next start belongs to the item, so comments
 * written above a row stay with that row when it is rewritten.
 *
 * A bare empty-list placeholder is marked, not treated as an ordinary item:
 * the shipped profile template ships one, and keeping it alongside a real row
 * would put TWO top-level documents in one file (invalid YAML).
 *
 * @param text - raw file text.
 * @returns `{ eol, preamble, items, placeholder }`.
 */
export function splitTopLevel(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/u);
  // A trailing newline produces one empty final element; keep it out of the
  // model and re-add it on join so round-trips are byte-stable.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const starts = [];
  let placeholderIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^-(?:[ \t]|$)/u.test(line)) starts.push(index);
    else if (/^\[[^\]]*\][ \t]*(?:#.*)?$/u.test(line)) placeholderIndex = index;
  }
  // The placeholder is never kept as content: it is either the sole document
  // body (re-emitted by joinTopLevel) or replaced by the first real row.
  if (starts.length === 0) {
    const preamble = placeholderIndex === -1 ? lines : lines.filter((_, i) => i !== placeholderIndex);
    return { eol, preamble, items: [], placeholder: placeholderIndex !== -1 };
  }

  const items = [];
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index];
    const to = index + 1 < starts.length ? starts[index + 1] : lines.length;
    items.push({ lines: lines.slice(from, to) });
  }
  const firstStart = starts[0];
  const preambleSource = firstStart > 0 ? lines.slice(0, firstStart) : [];
  return {
    eol,
    preamble: preambleSource.filter((_, i) => i !== placeholderIndex),
    items,
    placeholder: placeholderIndex !== -1,
  };
}

/**
 * Reassemble a document from its parts. An empty-list placeholder is emitted
 * only when the document has no items, because a comment-only file is not a
 * top-level array and the loader refuses to boot such a profile.
 * @param parts - `{ eol, preamble, items }`.
 * @returns file text ending in a newline.
 */
export function joinTopLevel(parts) {
  const { eol, preamble, items } = parts;
  const chunks = [];
  if (preamble.length > 0) chunks.push(preamble.join(eol));
  let wroteItem = false;
  for (const item of items) {
    const body = item.lines.join(eol);
    if (body.trim() === '') continue;
    chunks.push(body);
    wroteItem = true;
  }
  if (!wroteItem) chunks.push('[]');
  let text = chunks.join(eol);
  if (text.trim() === '') return `[]${eol}`;
  if (!text.endsWith(eol)) text += eol;
  return text;
}

/** Text of one item. */
export function itemText(item, eol) {
  return item.lines.join(eol);
}

/**
 * Parse one item as a single-element loader patch list.
 * @param text - the item's text.
 * @param yaml - the `js-yaml` module.
 * @param schema - the entry-list schema (with the `!!js` tag).
 * @returns the patch row, or null when the item is not one.
 */
export function parseItem(text, yaml, schema) {
  const trimmed = text.trim();
  if (trimmed === '' || /^\[[^\]]*\]$/u.test(trimmed)) return null;
  try {
    const parsed = yaml.load(trimmed, { schema });
    if (!Array.isArray(parsed) || parsed.length !== 1) return null;
    const row = parsed[0];
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
    return row;
  } catch {
    return null;
  }
}

/**
 * Validate a candidate document before it is written.
 * @param text - candidate content.
 * @param yaml - the `js-yaml` module.
 * @param schema - the entry-list schema.
 * @returns an error message, or null when the document is a valid patch list.
 */
export function validateDocument(text, yaml, schema) {
  const stripped = text.replace(/^[ \t]*#.*$/gmu, '').trim();
  if (stripped === '' || stripped === '[]' || stripped === '[ ]') return null;
  try {
    const parsed = yaml.load(text, { schema });
    if (parsed === null || parsed === undefined) return null;
    if (!Array.isArray(parsed)) return '补丁层必须是顶层 YAML 数组';
    for (const row of parsed) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        return '补丁层的每个条目都必须是 YAML 映射';
      }
    }
    return null;
  } catch (error) {
    return `补丁层解析失败：${String(error?.reason ?? error?.message ?? error)}`;
  }
}

// ── YAML emission ───────────────────────────────────────────────────────────

/**
 * Whether a value is a `!!js` expression node, as the entry-list dialect's
 * schema constructs it. Such a value is a scalar on the wire, not a nested
 * mapping, so it must be handed back to the file with its tag intact — writing
 * it as an ordinary mapping would turn a dynamic expression into a literal
 * object and silently change what the row configures.
 * @param value - any config value.
 * @returns true for an expression node.
 */
export function isJsExprValue(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.__jsExpr === 'string' &&
    Object.keys(value).length === 1
  );
}

/**
 * YAML scalar for a value — JSON strings are valid YAML double-quoted scalars.
 * A `!!js` expression node round-trips as its tagged scalar; an expression
 * containing a newline becomes a block scalar, which is the only form the
 * dialect can carry one in.
 */
export function scalar(value) {
  if (isJsExprValue(value)) {
    const expr = value.__jsExpr;
    if (expr.includes('\n')) return `!!js |-\n${expr}`;
    return `!!js ${expr}`;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return 'null';
  return JSON.stringify(value);
}

/**
 * Emit a mapping's entries at a fixed indent. Sequences of scalars use the
 * compact `- value` form; sequences of mappings and nested mappings open a
 * block, which is what a hand-written MCP row looks like.
 * @param object - the mapping.
 * @param indent - indentation of the keys.
 * @param lines - accumulator.
 */
export function emitMapping(object, indent, lines) {
  const pad = ' '.repeat(indent);
  for (const [key, value] of Object.entries(object)) {
    if (value !== null && typeof value === 'object' && !isJsExprValue(value)) {
      if (Array.isArray(value)) {
        if (value.length === 0) {
          lines.push(`${pad}${key}: []`);
          continue;
        }
        lines.push(`${pad}${key}:`);
        for (const item of value) {
          if (item !== null && typeof item === 'object' && !isJsExprValue(item)) {
            lines.push(`${pad}  -`);
            emitMapping(item, indent + 4, lines);
          } else {
            lines.push(`${pad}  - ${scalar(item)}`);
          }
        }
        continue;
      }
      if (Object.keys(value).length === 0) {
        lines.push(`${pad}${key}: {}`);
        continue;
      }
      lines.push(`${pad}${key}:`);
      emitMapping(value, indent + 2, lines);
      continue;
    }
    lines.push(`${pad}${key}: ${scalar(value)}`);
  }
}

/**
 * Emit one `- insert:` block holding the given rows.
 * @param rows - `{ id, name, config, extra }` entries.
 * @returns YAML text (no trailing newline).
 */
export function emitInsertBlock(rows) {
  const lines = ['- insert:'];
  for (const row of rows) {
    lines.push(`    - id: ${row.id}`);
    lines.push(`      name: ${JSON.stringify(row.name)}`);
    const config = row.config !== null && typeof row.config === 'object' ? row.config : {};
    if (Object.keys(config).length === 0) {
      lines.push('      config: {}');
    } else {
      lines.push('      config:');
      emitMapping(config, 8, lines);
    }
    for (const [key, value] of Object.entries(row.extra ?? {})) {
      if (value !== null && typeof value === 'object' && !isJsExprValue(value)) {
        lines.push(`      ${key}:`);
        emitMapping(value, 8, lines);
      } else {
        lines.push(`      ${key}: ${scalar(value)}`);
      }
    }
  }
  return lines.join('\n');
}

/** Emit a `- id: X` + `disabled: bool` override block. */
export function emitDisabledBlock(rowId, disabled) {
  return `- id: ${rowId}\n  disabled: ${disabled ? 'true' : 'false'}`;
}

// ── document model ──────────────────────────────────────────────────────────

/**
 * Build the management view of a patch document: the MCP rows it inserts, the
 * per-row overrides it carries, and its structural problems.
 * @param text - raw file text.
 * @param yaml - the `js-yaml` module.
 * @param schema - the entry-list schema.
 * @returns `{ parts, rows, overrides, issues }`.
 */
export function readDocument(text, yaml, schema) {
  const parts = splitTopLevel(text);
  const rows = [];
  const overrides = { disabled: new Map(), config: new Map(), items: new Map() };
  const issues = [];

  for (const item of parts.items) {
    const body = itemText(item, parts.eol);
    const stripped = body.replace(/^[ \t]*#.*$/gmu, '').trim();
    if (stripped === '' || stripped === '[]' || stripped === '[ ]') continue;
    const row = parseItem(body, yaml, schema);
    if (row === null) {
      issues.push('补丁层中有本插件无法解析的条目，已原样保留并跳过管理');
      continue;
    }
    if (Array.isArray(row.insert)) {
      for (const inserted of row.insert) {
        if (inserted === null || typeof inserted !== 'object' || Array.isArray(inserted)) continue;
        if (inserted.name !== MCP_CLIENT_PACKAGE) continue;
        const config = inserted.config;
        if (config === null || typeof config !== 'object' || Array.isArray(config)) continue;
        rows.push({
          id: typeof inserted.id === 'string' ? inserted.id : '',
          name: MCP_CLIENT_PACKAGE,
          config,
          extra: extraKeysOf(inserted),
          item,
        });
      }
      continue;
    }
    if (typeof row.id !== 'string' || row.id === '') continue;
    const existing = overrides.items.get(row.id) ?? [];
    existing.push(item);
    overrides.items.set(row.id, existing);
    if (row.disabled !== undefined) overrides.disabled.set(row.id, row.disabled === true);
    if (row.config !== undefined && row.config !== null && typeof row.config === 'object') {
      overrides.config.set(row.id, row.config);
    }
  }

  return { parts, rows, overrides, issues };
}

/** Row keys other than the ones this plugin models, preserved on rewrite. */
export function extraKeysOf(row) {
  const extra = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'id' || key === 'name' || key === 'config') continue;
    extra[key] = value;
  }
  return extra;
}

/**
 * Replace the item containing `row` with a freshly emitted block holding the
 * given rows.
 * @param parts - document parts.
 * @param row - the row whose item is rewritten.
 * @param rows - the rows the rewritten block holds.
 * @returns new document text.
 */
export function rewriteInsertBlock(parts, row, rows) {
  const replacement = rows.length === 0 ? null : emitInsertBlock(rows);
  const items = [];
  let replaced = false;
  for (const item of parts.items) {
    if (item === row.item) {
      replaced = true;
      if (replacement !== null) items.push({ lines: replacement.split('\n') });
      continue;
    }
    items.push(item);
  }
  if (!replaced) throw new Error('未找到目标行所在的块');
  return joinTopLevel({ ...parts, items });
}

/**
 * The rows sharing one `- insert:` block with `row`, as `{ id, name, config }`
 * entries. Used so an edit or a removal can never drop a sibling row that
 * happens to live in the same block.
 * @param parts - document parts.
 * @param row - a row read from that block.
 * @param yaml - the `js-yaml` module.
 * @param schema - the entry-list schema.
 * @returns the block's rows, in their original order.
 */
export function blockRows(parts, row, yaml, schema) {
  const parsed = parseItem(itemText(row.item, parts.eol), yaml, schema);
  const inserted = Array.isArray(parsed?.insert) ? parsed.insert : [];
  return inserted
    .filter((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      name: typeof entry.name === 'string' ? entry.name : MCP_CLIENT_PACKAGE,
      config: entry.config !== null && typeof entry.config === 'object' ? entry.config : {},
      extra: extraKeysOf(entry),
    }));
}

/**
 * Rewrite one row in place, keeping every sibling row of its block.
 * @param parts - document parts.
 * @param row - the row to replace.
 * @param next - `{ id, name, config, extra }` the row becomes.
 * @param yaml - the `js-yaml` module.
 * @param schema - the entry-list schema.
 * @returns new document text.
 */
export function updateRowInBlock(parts, row, next, yaml, schema) {
  const rows = blockRows(parts, row, yaml, schema).map((entry) =>
    entry.id === row.id ? { ...entry, ...next } : entry,
  );
  return rewriteInsertBlock(parts, row, rows);
}

/**
 * Drop one row from its block, keeping every sibling row; the block itself
 * disappears only when it held nothing else.
 * @param parts - document parts.
 * @param row - the row to drop.
 * @param yaml - the `js-yaml` module.
 * @param schema - the entry-list schema.
 * @returns `{ text, blockRemoved }`.
 */
export function removeRowFromBlock(parts, row, yaml, schema) {
  const rows = blockRows(parts, row, yaml, schema).filter((entry) => entry.id !== row.id);
  return { text: rewriteInsertBlock(parts, row, rows), blockRemoved: rows.length === 0 };
}

/**
 * Append one block at the end of the document.
 * @param parts - document parts.
 * @param block - YAML text for the new item.
 * @returns new document text.
 */
export function appendBlock(parts, block) {
  return joinTopLevel({ ...parts, items: [...parts.items, { lines: block.split('\n') }] });
}

/**
 * Remove every override item that carries `disabled` for one of the given row
 * ids. Used before writing a fresh `disabled` override so repeated toggles
 * cannot accumulate duplicate blocks.
 *
 * Only `disabled`-bearing items are dropped. A row may also carry a
 * hand-written `config:` override, which belongs to the user and must survive
 * a toggle — the patch dialect applies each row independently, so two items
 * targeting one id with different keys compose rather than conflict.
 *
 * @param parts - document parts.
 * @param ids - row ids whose disable overrides are dropped.
 * @param yaml - the `js-yaml` module.
 * @param schema - the entry-list schema.
 * @returns `{ parts, removed }`.
 */
export function dropDisabledOverrides(parts, ids, yaml, schema) {
  const wanted = new Set(ids);
  const items = [];
  let removed = 0;
  for (const item of parts.items) {
    const row = parseItem(itemText(item, parts.eol), yaml, schema);
    const isDisableOverride =
      row !== null &&
      row.insert === undefined &&
      typeof row.id === 'string' &&
      wanted.has(row.id) &&
      row.disabled !== undefined;
    if (isDisableOverride) {
      removed += 1;
      continue;
    }
    items.push(item);
  }
  return { parts: { ...parts, items }, removed };
}

/**
 * Remove every item that is a pure override (`id` plus `disabled`/`config`, no
 * `insert`) targeting one of the given row ids. Used when a row is removed
 * outright: every override addressing it becomes an orphan that the loader
 * would warn about on the next boot.
 * @param parts - document parts.
 * @param ids - row ids whose overrides are dropped.
 * @param yaml - the `js-yaml` module.
 * @param schema - the entry-list schema.
 * @returns `{ parts, removed }`.
 */
export function dropOverrides(parts, ids, yaml, schema) {
  const wanted = new Set(ids);
  const items = [];
  let removed = 0;
  for (const item of parts.items) {
    const row = parseItem(itemText(item, parts.eol), yaml, schema);
    if (row !== null && row.insert === undefined && typeof row.id === 'string' && wanted.has(row.id)) {
      removed += 1;
      continue;
    }
    items.push(item);
  }
  return { parts: { ...parts, items }, removed };
}

/**
 * The row ids an `- insert:` item's rows use, for collision checks.
 * @param parts - document parts.
 * @param yaml - the `js-yaml` module.
 * @param schema - the entry-list schema.
 * @returns a Set of ids.
 */
export function insertedIds(parts, yaml, schema) {
  const ids = new Set();
  for (const item of parts.items) {
    const row = parseItem(itemText(item, parts.eol), yaml, schema);
    if (row === null || !Array.isArray(row.insert)) continue;
    for (const inserted of row.insert) {
      if (inserted !== null && typeof inserted === 'object' && typeof inserted.id === 'string') {
        ids.add(inserted.id);
      }
    }
  }
  return ids;
}

/** Read a patch file, treating a missing file as an empty document. */
export function readPatchText(patchPath) {
  try {
    return readFileSync(patchPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw new Error(`补丁层读取失败：${String(error?.message ?? error)}`);
  }
}
