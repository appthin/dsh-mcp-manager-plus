/**
 * Test entry point: runs every suite in one process.
 *
 * `node --test` spawns a child per file, which a confined sandbox can refuse;
 * importing the suites directly works everywhere and keeps one shared module
 * cache. Run with:  node test/run.mjs
 */
// Loaded one at a time on purpose: a suite that cannot even be imported (its
// environment dependency is gone, say) used to abort every later suite silently,
// which reads as a smaller green run instead of a missing file.
const suites = [
  './patch.test.mjs',
  './import.test.mjs',
  './editjson.test.mjs',
  './host.test.mjs',
  './client.test.mjs',
  './compose.test.mjs',
  './live.test.mjs',
];
for (const suite of suites) {
  try {
    await import(suite);
  } catch (error) {
    console.error(`# suite ${suite} could not be loaded: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
