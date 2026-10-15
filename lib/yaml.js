/**
 * dsh-mcp-manager-plus — `js-yaml` compatibility layer.
 *
 * The plugin needs exactly one thing from `js-yaml`: a custom scalar type for
 * the entry-list dialect's `!!js` tag. That is a v3/v4 API — `new yaml.Type(…)`
 * plus `schema.extend(…)` — and the module is resolved through the *profile*
 * root, where every plugin's dependencies are hoisted by pnpm. So an unrelated
 * plugin declaring `js-yaml@^5` can hoist a v5 to the top of the profile, and a
 * v5 no longer exports `Type`: the constructor call threw inside `loadYaml()`
 * and the whole panel became `加载失败：yaml.Type is not a constructor`. The
 * plugin never pinned its own copy, so nothing kept that from happening.
 *
 * Two independent defences, applied in this order:
 *
 * 1. **Pick a copy that can do the job.** Resolution walks the same anchors as
 *    before, but a candidate that cannot build the `!!js` tag is *skipped*
 *    rather than used, so the plugin's own pinned `js-yaml` (a real
 *    `dependencies` entry, reached through the plugin's own directory) wins
 *    over a hoisted v5.
 * 2. **Never lose the page.** If every candidate is incompatible the module is
 *    *adapted* instead of rejected: the `!!js` tag is neutralized textually
 *    before parsing and the parsed scalar is re-tagged afterwards. The panel
 *    keeps loading, and — because this module's contract is that a `!!js`
 *    expression must never be silently rewritten into a literal string — the
 *    value still round-trips as an expression node rather than as plain text.
 *
 * The adaptation is deliberately equivalent to the fast path, not merely
 * "good enough": a `!!js` scalar decodes to the same expression string a v4
 * `construct()` would have produced, so emission through {@link
 * module:dsh-mcp-manager-plus/patch.scalar} is unchanged.
 *
 * @module dsh-mcp-manager-plus/yaml
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The tag the loader's include plugin uses for an expression scalar. */
export const JS_EXPR_TAG = 'tag:yaml.org,2002:js';

/** Prefix of the placeholder that stands in for a neutralized `!!js` scalar. */
const PLACEHOLDER_PREFIX = '__mcpmp_js_expr_';

/** This file's own directory: the anchor that reaches the plugin's own deps. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Build the entry-list schema — a JSON schema plus the `!!js` scalar type — or
 * `null` when this module cannot express the tag.
 *
 * The probe is deliberately narrow: it asks for the two things the dialect
 * needs (`Type` constructible, base schema extensible) instead of sniffing a
 * version number, because a fork or a v5 that keeps half the API should fall
 * through to the adapted parser rather than throw halfway through a parse.
 *
 * @param mod - a `js-yaml` module (namespace or CJS exports object).
 * @returns the schema, or `null` when the module cannot carry `!!js`.
 */
export function buildEntrySchema(mod) {
  try {
    if (mod === null || typeof mod !== 'object') return null;
    if (typeof mod.Type !== 'function') return null;
    const base = mod.JSON_SCHEMA ?? mod.DEFAULT_SCHEMA;
    if (base === null || typeof base !== 'object') return null;
    if (typeof base.extend !== 'function') return null;
    const jsExpr = new mod.Type(JS_EXPR_TAG, {
      kind: 'scalar',
      resolve: (data) => typeof data === 'string',
      construct: (data) => ({ __jsExpr: data }),
      predicate: (value) =>
        value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string',
      represent: (value) => value.__jsExpr,
    });
    return base.extend(jsExpr);
  } catch {
    // A module that advertises the API but throws while building it (a v5 that
    // keeps a `Type` binding for compatibility, say) degrades like any other.
    return null;
  }
}

/**
 * Adapt a resolved `js-yaml` module for the entry-list dialect.
 *
 * @param mod - the module to adapt.
 * @param source - where it came from, for diagnostics and the UI warning.
 * @returns `{ yaml, schema, degraded, source, raw }`. `yaml` is the module
 *   itself on the fast path and a `load`-compatible wrapper otherwise;
 *   `schema` is `undefined` when degraded, because the wrapper ignores it.
 */
export function adaptYamlModule(mod, source = 'js-yaml') {
  const schema = buildEntrySchema(mod);
  if (schema !== null) return { yaml: mod, schema, degraded: false, source, raw: mod };
  return { yaml: degradeModule(mod), schema: undefined, degraded: true, source, raw: mod };
}

/**
 * The anchors `js-yaml` is resolved through, in order.
 *
 * Order is unchanged from the original implementation — the profile directory
 * first, so the dialect matches what the loader's own include plugin uses — but
 * that no longer means "first copy wins": {@link resolveEntryYaml} skips an
 * anchor whose copy cannot build the `!!js` tag, which is what lets the
 * plugin's own pinned copy take over from a hoisted v5.
 *
 * @param profileDir - the profile directory, when the loader knows it.
 * @param options - `{ home, profile, pluginDir, cwd }`; all optional.
 * @returns candidate directories, most specific first.
 */
export function yamlResolutionAnchors(profileDir, options = {}) {
  const {
    home,
    profile = 'web',
    pluginDir = PLUGIN_DIR,
    cwd = process.cwd(),
  } = options;
  const anchors = [];
  if (typeof profileDir === 'string' && profileDir !== '') anchors.push(profileDir);
  // The plugin's own package directory: an installed copy sits inside the
  // profile's node_modules, so this reaches the same hoisted `js-yaml` even
  // when the profile directory could not be resolved from the loader.
  anchors.push(pluginDir);
  anchors.push(cwd);
  if (typeof home === 'string' && home !== '') {
    anchors.push(join(home, 'profiles', profile));
    anchors.push(join(home, 'profiles'));
  }
  return anchors;
}

/**
 * Resolve `js-yaml` and adapt it, preferring a copy that can express `!!js`.
 *
 * Every anchor is tried; the first *compatible* copy wins. If none is
 * compatible the first resolvable one is returned adapted (degraded), and only
 * when nothing resolves at all does this throw — a thrown error here is the
 * one case the page cannot survive, so it is left as the last resort rather
 * than the first.
 *
 * @param anchors - directories to resolve from, in order.
 * @param options - `{ load }`, injectable for tests.
 * @returns `{ yaml, schema, degraded, source, raw }`.
 */
export async function resolveEntryYaml(anchors, options = {}) {
  const load = options.load ?? loadFromAnchor;
  let degraded = null;
  for (const anchor of anchors) {
    if (typeof anchor !== 'string' || anchor === '') continue;
    let loaded;
    try {
      loaded = await load(anchor);
    } catch {
      continue; // No copy here; try the next anchor.
    }
    if (loaded === null || loaded === undefined) continue;
    const adapted = adaptLoaded(loaded, anchor);
    if (!adapted.degraded) return adapted;
    if (degraded === null) degraded = adapted;
  }
  // Last resort: an ordinary bare import, which succeeds when this package was
  // installed with `js-yaml` as a real dependency.
  try {
    const loaded = await load(null);
    if (loaded !== null && loaded !== undefined) {
      const adapted = adaptLoaded(loaded, 'js-yaml');
      if (!adapted.degraded) return adapted;
      if (degraded === null) degraded = adapted;
    }
  } catch {
    // Nothing resolvable; handled below.
  }
  if (degraded !== null) return degraded;
  throw new Error('未能解析到 js-yaml：插件目录与 profile 中都没有可用副本');
}

/**
 * Import a `js-yaml` copy through one anchor.
 * @param anchor - a directory, or `null` for a bare import.
 * @returns `{ module, source }`.
 */
async function loadFromAnchor(anchor) {
  if (anchor === null) {
    const loaded = await import('js-yaml');
    return { module: unwrapModule(loaded), source: 'js-yaml' };
  }
  const require = createRequire(join(anchor, 'package.json'));
  const resolved = require.resolve('js-yaml');
  const loaded = await import(pathToFileURL(resolved).href);
  return { module: unwrapModule(loaded), source: resolved };
}

/** A CJS module reached through `import()` carries its exports under `.default`. */
function unwrapModule(loaded) {
  return loaded?.default ?? loaded;
}

/**
 * Adapt whatever a loader returned, accepting a bare module for convenience.
 * @param loaded - `{ module, source }` or a module.
 * @param fallbackSource - source label when the loader did not supply one.
 * @returns the adapter result.
 */
function adaptLoaded(loaded, fallbackSource) {
  const mod = loaded.module !== undefined ? loaded.module : loaded;
  return adaptYamlModule(mod, loaded.source ?? fallbackSource);
}

// ── degraded parsing ────────────────────────────────────────────────────────

/**
 * Wrap a module that cannot register `!!js` so it still parses documents that
 * carry the tag.
 *
 * Only `load` is provided: the plugin never dumps YAML through the module (it
 * emits patch text itself), so a `dump` here would be dead code pretending to
 * be a fallback.
 *
 * @param mod - the incompatible module.
 * @returns `{ load, __mcpmpDegraded }`.
 */
function degradeModule(mod) {
  return {
    load(text) {
      if (typeof text !== 'string' || !text.includes('!!js')) return parseDocument(mod, text);
      const { text: neutralized, expressions } = neutralizeJsTags(mod, text);
      if (expressions.size === 0) return parseDocument(mod, text);
      return retagExpressions(parseDocument(mod, neutralized), expressions);
    },
    __mcpmpDegraded: true,
  };
}

/**
 * Parse with the closest schema the module offers. The fast path extends
 * `JSON_SCHEMA`, so degrading to it keeps value typing identical — falling back
 * to the default schema would quietly turn a date-shaped string into a `Date`
 * and rewrite it on the next save.
 * @param mod - the `js-yaml` module.
 * @param text - document text.
 * @returns the parsed value.
 */
function parseDocument(mod, text) {
  const base = mod.JSON_SCHEMA ?? mod.DEFAULT_SCHEMA;
  return base === undefined ? mod.load(text) : mod.load(text, { schema: base });
}

/**
 * Replace every `!!js` tag and its scalar with a unique placeholder string.
 *
 * The scan is quote- and comment-aware on purpose: a config value such as
 * `args: ["echo !!js x"]` or a header comment mentioning `!!js` must survive
 * untouched, and a placeholder that leaked into such a value would be re-tagged
 * as an expression and change what the row configures.
 *
 * @param mod - the `js-yaml` module (used to decode each scalar).
 * @param text - the document.
 * @returns `{ text, expressions }`, expressions mapping placeholder → value.
 */
function neutralizeJsTags(mod, text) {
  const nonce = `${PLACEHOLDER_PREFIX}${Math.random().toString(36).slice(2)}_`;
  const expressions = new Map();
  let out = '';
  let index = 0;
  let inSingle = false;
  let inDouble = false;
  let inComment = false;
  let lineStart = true;
  let flowDepth = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === '\n') {
      out += char;
      index += 1;
      inComment = false;
      lineStart = true;
      continue;
    }
    if (inComment) {
      out += char;
      index += 1;
      continue;
    }
    if (inSingle) {
      out += char;
      index += 1;
      // YAML escapes a quote inside a single-quoted scalar by doubling it.
      if (char === "'") {
        if (text[index] === "'") {
          out += text[index];
          index += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (inDouble) {
      out += char;
      index += 1;
      if (char === '\\') {
        out += text[index] ?? '';
        index += 1;
      } else if (char === '"') {
        inDouble = false;
      }
      continue;
    }
    if (char === '#' && (lineStart || /[ \t]/u.test(text[index - 1] ?? '\n'))) {
      inComment = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      inSingle = char === "'";
      inDouble = char === '"';
      lineStart = false;
      out += char;
      index += 1;
      continue;
    }
    if (char === '[' || char === '{') {
      flowDepth += 1;
      lineStart = false;
      out += char;
      index += 1;
      continue;
    }
    if (char === ']' || char === '}') {
      flowDepth = Math.max(0, flowDepth - 1);
      lineStart = false;
      out += char;
      index += 1;
      continue;
    }
    if (char === '!' && text.startsWith('!!js', index) && isTagBoundary(text[index + 4])) {
      const node = captureNode(text, index, index + 4, flowDepth);
      const placeholder = `${nonce}${expressions.size}`;
      expressions.set(placeholder, decodeExpression(mod, node.raw));
      out += placeholder;
      index = node.end;
      lineStart = false;
      continue;
    }
    if (char !== ' ' && char !== '\t') lineStart = false;
    out += char;
    index += 1;
  }

  return { text: out, expressions };
}

/** A tag ends at end-of-input or at the whitespace before its node. */
function isTagBoundary(char) {
  return char === undefined || char === ' ' || char === '\t' || char === '\n';
}

/**
 * Find the scalar a `!!js` tag applies to.
 *
 * The tag is followed by either an inline scalar (a plain, single- or
 * double-quoted scalar, ended by the line, an unquoted comment, or a flow
 * indicator) or a block scalar header (`|`/`>`) whose indented lines belong to
 * it. Neither form is decoded here — the raw source text is returned so the
 * decode can go through `js-yaml` itself, which is the only correct parser for
 * quoting and block folding.
 *
 * @param text - the document.
 * @param tagStart - index of the `!` that opens the tag.
 * @param from - index just past the tag.
 * @param flowDepth - current flow-collection depth (0 outside `[]`/`{}`).
 * @returns `{ raw, end }`; `end` is where the placeholder replaces to.
 */
function captureNode(text, tagStart, from, flowDepth) {
  let cursor = from;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
  if (text[cursor] === '|' || text[cursor] === '>') return captureBlock(text, tagStart, cursor);

  let end = cursor;
  let single = false;
  let double = false;
  while (end < text.length) {
    const char = text[end];
    if (char === '\n') break;
    if (single) {
      if (char === "'") {
        if (text[end + 1] === "'") {
          end += 2;
          continue;
        }
        single = false;
      }
      end += 1;
      continue;
    }
    if (double) {
      if (char === '\\') {
        end += 2;
        continue;
      }
      if (char === '"') double = false;
      end += 1;
      continue;
    }
    if (char === "'") {
      single = true;
      end += 1;
      continue;
    }
    if (char === '"') {
      double = true;
      end += 1;
      continue;
    }
    if (char === '#' && (text[end - 1] === ' ' || text[end - 1] === '\t')) break;
    if (flowDepth > 0 && (char === ',' || char === '}' || char === ']')) break;
    end += 1;
  }
  let rawEnd = end;
  while (rawEnd > cursor && (text[rawEnd - 1] === ' ' || text[rawEnd - 1] === '\t')) rawEnd -= 1;
  return { raw: text.slice(cursor, rawEnd), end };
}

/**
 * Capture a block scalar (`!!js |-`) including its indented body.
 * @param text - the document.
 * @param tagStart - index of the `!` that opens the tag.
 * @param indicatorStart - index of the `|`/`>` indicator.
 * @returns `{ raw, end }`.
 */
function captureBlock(text, tagStart, indicatorStart) {
  const lineStart = text.lastIndexOf('\n', tagStart - 1) + 1;
  const firstBreak = text.indexOf('\n', indicatorStart);
  const headerEnd = firstBreak === -1 ? text.length : firstBreak;
  const tagIndent = (text.slice(lineStart, headerEnd).match(/^[ \t]*/u)?.[0] ?? '').length;

  let cursor = firstBreak === -1 ? text.length : firstBreak + 1;
  let lastContent = headerEnd;
  while (cursor < text.length) {
    const nextBreak = text.indexOf('\n', cursor);
    const lineStop = nextBreak === -1 ? text.length : nextBreak;
    const line = text.slice(cursor, lineStop).replace(/\r$/u, '');
    if (line.trim() !== '') {
      const indent = (line.match(/^[ \t]*/u)?.[0] ?? '').length;
      if (indent <= tagIndent) break;
      lastContent = lineStop;
    }
    if (nextBreak === -1) break;
    cursor = nextBreak + 1;
  }
  return { raw: text.slice(indicatorStart, lastContent), end: lastContent };
}

/**
 * Decode one captured scalar through `js-yaml`, so the expression string is
 * exactly what a v4 `construct()` would have received. A scalar the module
 * refuses (or one that resolves to a non-string) keeps its raw source text,
 * which still emits as a valid `!!js` scalar.
 * @param mod - the `js-yaml` module.
 * @param raw - the captured scalar source text.
 * @returns the expression string.
 */
function decodeExpression(mod, raw) {
  if (raw === '') return raw;
  try {
    const parsed = parseDocument(mod, `x: ${raw}`);
    const value = parsed?.x;
    if (typeof value === 'string') return value;
  } catch {
    // Fall through to the raw source.
  }
  return raw;
}

/**
 * Walk a parsed document and turn every placeholder back into an expression
 * node. Only strings are considered (a placeholder is always parsed as one),
 * and only plain objects/arrays are recursed into, so schema-built values such
 * as `Date` are returned untouched.
 * @param value - the parsed value.
 * @param expressions - placeholder → expression string.
 * @returns the document with expression nodes restored.
 */
function retagExpressions(value, expressions) {
  if (typeof value === 'string') {
    const expr = expressions.get(value);
    return expr === undefined ? value : { __jsExpr: expr };
  }
  if (Array.isArray(value)) return value.map((entry) => retagExpressions(entry, expressions));
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = retagExpressions(entry, expressions);
    }
    return out;
  }
  return value;
}
