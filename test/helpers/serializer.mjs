/**
 * Extract `serverToJson` from the client bundle for use in tests and tools.
 *
 * The serializer lives inside the browser bundle (which is not an importable
 * module — it registers itself with `window.__ModuleLoader__`), so the only way
 * to exercise the real thing rather than a copy is to lift the function out of
 * the source. Anything that verifies the JSON editor's seed should go through
 * here, so a test can never drift from what the browser actually runs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '..', '..', 'lib', 'client.js');

const source = readFileSync(bundlePath, 'utf8');
const body = /function serverToJson\(server\) \{([\s\S]*?)\n    \}/.exec(source)?.[1];
if (body === undefined) throw new Error('serverToJson not found in lib/client.js');

/**
 * Render one server as the `mcpServers` JSON the edit dialog opens with.
 * @param server - one inventory row.
 * @returns pretty-printed JSON text.
 */
export const serverToJson = new Function('server', body);
