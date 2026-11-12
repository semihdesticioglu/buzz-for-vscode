// Buzz Lens search paths with the real BuzzLens (out/lens.js): live NIP-50 page, time windows when the page is
// full, CLI fallback when the live connection is off or fails, and the timing line in the log.
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');

const noop = () => undefined;
const disp = { dispose: noop };
const fakeVscode = new Proxy(
  {
    workspace: {
      getConfiguration: () => ({ get: (_k, d) => d }),
      onDidChangeConfiguration: () => disp,
      onDidChangeTextDocument: () => disp,
      onDidCloseTextDocument: () => disp,
      asRelativePath: (u) =>
        String(u.fsPath || u)
          .replace(/\\/g, '/')
          .split('/')
          .slice(-3)
          .join('/'),
      getWorkspaceFolder: () => undefined,
      textDocuments: [],
    },
    window: {
      visibleTextEditors: [],
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: () => disp,
      onDidChangeVisibleTextEditors: () => disp,
      createTextEditorDecorationType: () => disp,
      createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop }),
      createOutputChannel: () => ({ appendLine: noop }),
      showInformationMessage: noop,
    },
    commands: { executeCommand: async () => undefined, registerCommand: () => disp },
    Uri: {
      joinPath: (...a) => ({ toString: () => a.join('/'), fsPath: a.join('/') }),
      file: (p) => ({ scheme: 'file', fsPath: p, path: p, query: '', toString: () => 'file:///' + p.replace(/\\/g, '/') }),
    },
    EventEmitter: class {
      constructor() {
        this.event = () => disp;
      }
      fire() {}
      dispose() {}
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    OverviewRulerLane: { Right: 4 },
    env: { language: 'en' },
  },
  { get: (t, k) => (k in t ? t[k] : class {}) },
);
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') return fakeVscode;
  return origLoad.apply(this, arguments);
};
const { BuzzLens } = require(path.join(PROJ, 'out', 'lens.js'));
const { log } = require(path.join(PROJ, 'out', 'log.js'));
const lines = [];
log.init({ appendLine: (l) => lines.push(l) });

const hex = (s) => (s + '0'.repeat(64)).slice(0, 64);
const now = Math.floor(Date.now() / 1000);
const ev = (i, ts, content) => ({ id: hex('e' + i.toString(16)), pubkey: hex('p1'), kind: 9, created_at: ts, content, tags: [['h', 'CH']] });
const mention = (i, ts) => ev(i, ts, `see pipeline/steps/rollup.py:${10 + (i % 50)} please`);

let liveCalls = [];
let liveMode = 'small'; // small | capped | off | throw
let cliCalls = [];
const live = {
  fetch: async (filters, ms) => {
    liveCalls.push({ f: filters[0], ms });
    if (liveMode === 'off') return undefined;
    if (liveMode === 'throw') throw new Error('socket closed');
    if (liveMode === 'cut') return { events: [mention(1, now - 100)], complete: false, reason: 'closed' };
    const f = filters[0];
    const done = (events) => ({ events, complete: true, reason: 'eose' });
    if (liveMode === 'small') return done([mention(1, now - 100), mention(2, now - 200), ev(3, now - 300, 'unrelated rollup talk')]);
    // capped: the first page is full; the windows hold what the relevance order dropped (an old one too)
    if (f.since === undefined && f.until === undefined) return done(Array.from({ length: 500 }, (_, i) => mention(1000 + i, now - 1000 - i)));
    if (f.until === undefined) return done([mention(1, now - 50)]);
    if (f.since !== undefined && f.until !== undefined) return done([mention(2000 + (f.since % 7), f.until - 10)]);
    return done([mention(9, now - 3 * 365 * 86400)]); // older than two years
  },
};
const client = {
  search: async (q, limit) => {
    cliCalls.push({ q, limit });
    return [mention(42, now - 42)];
  },
  ensureProfiles: async () => undefined,
  allChannels: async () => [{ id: 'CH', name: 'data', isDm: false }],
  nameOf: () => 'agent',
  isAgent: () => true,
};
const repos = { previousPaths: async () => [] };
const lens = new BuzzLens(client, { toString: () => 'ext' }, repos, live);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-')); // not a git repo: no earlier names
const uri = fakeVscode.Uri.file(path.join(tmp, 'pipeline', 'steps', 'rollup.py'));
let pass = 0;
let fail = 0;
const ok = (name, cond, info) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info)));
};
const entry = () => lens.cache.get(uri.toString());
const reset = () => {
  lens.cache.clear();
  liveCalls = [];
  cliCalls = [];
  lines.length = 0;
};

(async () => {
  await lens.load(uri);
  let e = entry();
  ok(
    'live: one NIP-50 query with kinds, the OR search text and a page of 500',
    liveCalls.length === 1 &&
      Array.isArray(liveCalls[0].f.kinds) &&
      liveCalls[0].f.search === 'rollup OR rollup.py OR pipeline/steps/rollup.py' &&
      liveCalls[0].f.limit === 500,
    liveCalls,
  );
  ok(
    'live: mentions grouped into threads, unrelated hits dropped, CLI not used',
    e && e.threads.length === 2 && cliCalls.length === 0,
    e && e.threads.map((t) => t.root),
  );
  ok(
    'the log says how long it took and which way it went',
    lines.some((l) => /\[lens\] rollup\.py:.*2 threads.* \d+ ms via live$/.test(l)),
    lines,
  );

  reset();
  liveMode = 'capped';
  await lens.load(uri);
  e = entry();
  const windows = liveCalls.slice(1);
  ok(
    'a full page -> the history is read again in four time windows',
    windows.length === 4 && windows[0].f.since && !windows[0].f.until && windows[3].f.until && !windows[3].f.since,
    windows.map((w) => [w.f.since, w.f.until]),
  );
  ok(
    'results of all pages are merged without duplicates, including the one older than two years',
    e && e.threads.length === 500 + 1 + 2 + 1 && e.threads.some((t) => t.last < now - 2 * 365 * 86400),
    e && e.threads.length,
  );
  ok(
    'the log marks nothing as capped when the windows had room',
    lines.some((l) => /via live$/.test(l)),
    lines,
  );

  reset();
  liveMode = 'off';
  await lens.load(uri);
  e = entry();
  ok(
    'no live connection -> the CLI runs the same search with a page of 500',
    cliCalls.length === 1 && cliCalls[0].limit === 500 && cliCalls[0].q === 'rollup OR rollup.py OR pipeline/steps/rollup.py' && e && e.threads.length === 1,
    cliCalls,
  );
  ok(
    'the log says cli',
    lines.some((l) => /via cli$/.test(l)),
    lines,
  );

  reset();
  liveMode = 'cut';
  await lens.load(uri);
  e = entry();
  ok(
    'a live read cut short (CLOSED/timeout) is not trusted: the CLI answers instead',
    cliCalls.length === 1 && e && e.threads.length === 1 && lines.some((l) => /via cli$/.test(l)),
    { cliCalls, lines },
  );

  reset();
  liveMode = 'throw';
  await lens.load(uri);
  e = entry();
  ok(
    'a failing live search falls back to the CLI and says so',
    cliCalls.length === 1 && e && e.threads.length === 1 && lines.some((l) => /live search failed/.test(l)),
    lines,
  );

  lens.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
