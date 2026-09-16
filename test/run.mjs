/**
 * Test entry point: runs every suite in one process.
 *
 * `node --test` spawns a child per file, which a confined sandbox can refuse;
 * importing the suites directly works everywhere and keeps one shared module
 * cache. Run with:  node test/run.mjs
 */
import './patch.test.mjs';
import './import.test.mjs';
import './editjson.test.mjs';
import './host.test.mjs';
import './client.test.mjs';
import './compose.test.mjs';
import './live.test.mjs';
