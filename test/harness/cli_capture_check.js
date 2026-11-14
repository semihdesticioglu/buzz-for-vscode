// The CLI recording end to end, without a real Buzz: test/cli-contract/capture.js records out/test/sampleCli.js (a
// small, well-formed workspace) into a temporary file. Checks that the capture ran every read command and nothing
// else, kept nothing original (names, texts, ids, the key, the relay's address) and left no temporary folder, that the
// contract tests (out/test/cliContract.test.js) pass on the recording, and that they fail when the CLI's output changes
// shape: a renamed field, a list wrapped in an object, a renamed presence field.
//   node test/harness/cli_capture_check.js [repo]
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJ = process.argv[2] || path.resolve(__dirname, '..', '..');
const KEY = 'b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef'; // BIP-340 test vector 1, not anyone's key
const RELAY = 'http://relay.sample.example:7777';
const sample = require(path.join(PROJ, 'out', 'test', 'sampleCli.js'));

let pass = 0;
let fail = 0;
const ok = (name, cond, info) => {
  if (cond) pass++;
  else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info).slice(0, 400)));
};
const captures = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('buzz-capture-'));

/** The contract tests on a recording (only those whose name starts with `only`, when given): which passed and failed. */
function contract(file, only) {
  const pattern = only ? [`--test-name-pattern=^${only.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}`] : [];
  // the spec reporter, asked for by name: without a terminal Node 22 writes TAP by default, Node 24 spec
  const args = ['--test', '--test-force-exit', '--test-reporter=spec', ...pattern, path.join(PROJ, 'out', 'test', 'cliContract.test.js')];
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, BUZZ_CLI_RECORDING: file },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  // summary lines: "ℹ pass 9" (spec) or "# pass 9" (TAP)
  const count = (what) => Number((new RegExp(`^(?:ℹ|#) ${what} (\\d+)`, 'm').exec(out) || [0, -1])[1]);
  const failed = [
    ...new Set([
      ...(out.match(/^✖ (.+?) \(\d/gm) || []).map((l) => l.slice(2).replace(/ \(\d$/, '')),
      ...(out.match(/^not ok \d+ - (.+)$/gm) || []).map((l) => l.replace(/^not ok \d+ - /, '')),
    ]),
  ];
  return { status: r.status, pass: count('pass'), fail: count('fail'), skipped: count('skipped'), failed };
}

/** A copy of the recording with one answer changed. */
function tampered(dir, rec, name, words, change) {
  const copy = JSON.parse(JSON.stringify(rec));
  for (const c of copy.calls) if (words.every((w, i) => c.args[i] === w)) c.stdout = change(c.stdout);
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(copy));
  return file;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buzz-contract-'));
try {
  const before = captures();
  const file = path.join(tmp, 'recorded.json');
  const r = spawnSync(
    process.execPath,
    [path.join(PROJ, 'test', 'cli-contract', 'capture.js'), '--cli', path.join(PROJ, 'out', 'test', 'sampleCli.js'), '--relay', RELAY, '--out', file],
    { encoding: 'utf8', timeout: 300_000, env: { ...process.env, BUZZ_PRIVATE_KEY: KEY } },
  );
  const log = (r.stdout || '') + (r.stderr || '');
  ok('the capture runs and saves a recording', r.status === 0 && fs.existsSync(file) && /Saved /.test(log), log.slice(-300)); // the end says why
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const text = fs.readFileSync(file, 'utf8');

  const commands = new Set(rec.calls.map((c) => c.args.slice(0, 2).join(' ')));
  const reads = [
    'users get',
    'channels list',
    'dms list',
    'messages get',
    'messages thread',
    'channels members',
    'users presence',
    'feed get',
    'messages search',
  ];
  ok(
    'every read command the extension uses is recorded, and nothing else (nothing is sent or changed)',
    reads.every((c) => commands.has(c)) && [...commands].every((c) => reads.includes(c)) && rec.calls.every((c) => c.code === 0),
    [...commands],
  );

  const originals = [
    ...sample.PROFILES.flatMap((p) => Object.values(p).filter((v) => typeof v === 'string')),
    ...sample.CHANNELS.flatMap((c) => [c.channel_id, c.name, c.description].filter(Boolean)),
    ...sample.MESSAGES.flatMap((e) => [e.id, e.content]),
    sample.OPEN,
    sample.DM_OLD,
    KEY,
    'relay.sample.example',
  ];
  // a short original counts when it is a whole value or key ("lin" inside "online" is not a leak); a long one anywhere
  const values = new Set();
  const walk = (v) => {
    if (typeof v === 'string') values.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        values.add(k);
        walk(x);
      }
    }
  };
  walk(rec);
  const left = originals.filter((s) => typeof s === 'string' && s && (values.has(s) || (s.length >= 8 && text.includes(s))));
  ok('nothing original is left: names, texts, ids, the key, the relay address', left.length === 0, left);
  ok('the capture leaves no temporary folder behind', captures().length === before.length, captures());

  const good = contract(file);
  ok('the contract tests pass on the recording, none skipped', good.status === 0 && good.pass === 10 && good.fail === 0 && good.skipped === 0, good);

  const renamed = contract(
    tampered(tmp, rec, 'renamed', ['channels', 'list', '--member'], (rows) => rows.map(({ channel_id, ...r }) => ({ ...r, channelId: channel_id }))),
    'channels list --member',
  );
  ok(
    'a renamed field (channel_id -> channelId) makes the channel test fail',
    renamed.status !== 0 && renamed.failed.some((t) => t.startsWith('channels list --member')),
    renamed,
  );
  const wrapped = contract(
    tampered(tmp, rec, 'wrapped', ['messages', 'get'], (rows) => ({ messages: rows })),
    'messages get',
  );
  ok('a list wrapped in an object makes the message test fail', wrapped.status !== 0 && wrapped.failed.some((t) => t.startsWith('messages get')), wrapped);
  const presence = contract(
    tampered(tmp, rec, 'presence', ['users', 'presence'], (rows) => rows.map(({ status, ...r }) => ({ ...r, availability: status }))),
    'users presence',
  );
  ok(
    'a renamed presence field (status -> availability) makes the presence test fail',
    presence.status !== 0 && presence.failed.some((t) => t.startsWith('users presence')),
    presence,
  );
} catch (e) {
  ok('the harness itself', false, String((e && e.stack) || e));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
