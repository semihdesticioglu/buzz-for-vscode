// Runs the harnesses in this folder against the repository:  node test/harness/run.js [name-filter]
// Controller harnesses need only Node (after `npm run compile`); browser harnesses load the real webview in a
// headless Chrome or Edge (see browser.js) and are skipped when none is installed. A harness that prints a line
// starting with SKIP and exits 0 counts as skipped (the agents' repository is not on this machine, say). On CI
// (CI is set) a missing browser is an error: the webview harnesses must run there, not be skipped.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const browser = require('./browser');

const ROOT = path.resolve(__dirname, '..', '..');
const filter = process.argv[2];
const chrome = browser.find();
if (!chrome && process.env.CI) {
  console.error('no Chrome or Edge found: on CI the webview harnesses must run (install one or set BUZZ_CHROME)');
  process.exit(2);
}
const files = fs
  .readdirSync(__dirname)
  .filter((f) => /^([\w-]+_check|stress_[\w-]+|perf_[\w-]+)\.js$/.test(f))
  .sort();

if (!fs.existsSync(path.join(ROOT, 'out', 'chat.js'))) {
  console.error('out/ is missing: run `npm run compile` first');
  process.exit(2);
}

let failed = 0;
let skipped = 0;
let ran = 0;
let checks = 0;
const t0 = Date.now();
for (const f of files) {
  if (filter && !f.includes(filter)) continue;
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  if (/puppeteer-core/.test(src) && !chrome) {
    console.log(`SKIP ${f} (no Chrome or Edge found; set BUZZ_CHROME)`);
    skipped++;
    continue;
  }
  const t1 = Date.now();
  const r = spawnSync(process.execPath, [...(/global\.gc/.test(src) ? ['--expose-gc'] : []), path.join(__dirname, f), ROOT], {
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, BUZZ_CHROME: chrome || '', BUZZ_TIME_SCALE: process.env.BUZZ_TIME_SCALE || (process.env.CI ? '3' : '1') },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const skip = r.status === 0 && /^SKIP/m.test(out);
  if (skip) {
    console.log(`SKIP ${f} ${(out.match(/^SKIP ?([^\n]*)/m) || ['', ''])[1]}`);
    skipped++;
    continue;
  }
  const ok = r.status === 0 && !/^FAIL/m.test(out);
  const pass = (out.match(/^PASS/gm) || []).length;
  const fail = (out.match(/^FAIL/gm) || []).length;
  checks += pass + fail;
  const summary = pass + fail ? `${pass} passed, ${fail} failed` : (out.match(/\d+ checks passed[^\n]*/) || ['metrics'])[0];
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f}: ${summary} (${((Date.now() - t1) / 1000).toFixed(1)} s)`);
  ran++;
  if (!ok) {
    failed++;
    // the failing checks, errors, and the seed of a randomised harness (SEED=n runs it again the same way)
    const lines = out.split('\n').filter((l) => /^FAIL|^seed |Error|rror:/.test(l));
    console.log(
      lines
        .slice(0, 8)
        .map((l) => '     ' + l)
        .join('\n'),
    );
    if (r.error) console.log('     ' + r.error.message);
  }
}
console.log(`\n${ran - failed} harnesses passed, ${failed} failed, ${skipped} skipped; ${checks} checks in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(failed ? 1 : 0);
