// Performance and memory of the real ChatController (out/chat.js) with a fake vscode module and a fake Buzz client.
// Run with: node --expose-gc perf_chat.js <project>
const Module = require('module');
const path = require('path');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');

const noop = () => undefined;
const disp = { dispose: noop };
const fakeVscode = {
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }), onDidChangeConfiguration: () => disp, asRelativePath: (u) => String(u) },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    showInformationMessage: noop,
    showErrorMessage: noop,
    showWarningMessage: noop,
    createOutputChannel: () => ({ appendLine: noop }),
  },
  commands: { executeCommand: async () => undefined, registerCommand: () => disp },
  Uri: { joinPath: (...a) => ({ toString: () => a.join('/'), fsPath: a.join('/') }), file: (p) => ({ fsPath: p }) },
  EventEmitter: class {
    constructor() {
      this.event = () => disp;
    }
    fire() {}
    dispose() {}
  },
  env: { language: 'en', openExternal: noop },
  ViewColumn: { Active: -1, Beside: -2 },
  Range: class {},
  Position: class {},
  Selection: class {},
  ThemeIcon: class {},
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') return fakeVscode;
  return origLoad.apply(this, arguments);
};
const { ChatController } = require(path.join(PROJ, 'out', 'chat.js'));

const hex = (s) => (s + '0'.repeat(64)).slice(0, 64);
const THREADS = 400;
const PER_THREAD = 7; // 400 roots + 2400 replies = 2800 messages
const BIG_THREAD = 300;
const now = Math.floor(Date.now() / 1000);
const people = Array.from({ length: 12 }, (_, i) => hex('p' + i.toString(16).padStart(2, '0')));
const LONG =
  'Lorem ipsum **dolor** sit amet, `code_name_x` consectetur adipiscing elit. See `pipeline/steps/rollup.py:142` and ABC-4321.\n\n```python\ndef f(x):\n    return x * 2\n```\n' +
  'Daha fazla metin. '.repeat(8);
const ev = (id, ch, ts, content, pk, root) => ({
  id: hex(id),
  pubkey: pk,
  kind: 9,
  created_at: ts,
  content,
  tags: [['h', ch], ...(root ? [['e', hex(root), '', 'root']] : [])],
});

function channel(chId) {
  const evs = [];
  let t = now - 200_000;
  for (let i = 0; i < THREADS; i++) {
    const rootId = `${chId}r${i.toString(16)}`;
    evs.push(ev(rootId, chId, t, `Thread ${i}: ${LONG.slice(0, 160)}`, people[i % people.length]));
    const n = i === 0 ? BIG_THREAD : PER_THREAD - 1;
    for (let j = 0; j < n; j++) {
      t += 30;
      evs.push(ev(`${chId}r${i.toString(16)}x${j.toString(16)}`, chId, t, LONG, people[(i + j) % people.length], rootId));
    }
    t += 300;
  }
  return evs;
}
const data = { A: channel('a'), B: channel('b') };
const PAGE = 100;
let cliCalls = 0;
const client = {
  myPubkey: hex('ff'),
  me: async () => ({}),
  channels: async () => [
    { id: 'A', name: 'a' },
    { id: 'B', name: 'b' },
  ],
  allChannels: async () => [
    { id: 'A', name: 'a' },
    { id: 'B', name: 'b' },
  ],
  dms: async () => [],
  async messages(ch, o = {}) {
    cliCalls++;
    let evs = data[ch];
    if (o.before) evs = evs.filter((e) => e.created_at < o.before);
    if (o.since) evs = evs.filter((e) => e.created_at >= o.since);
    return evs.slice(-(o.limit || PAGE));
  },
  async thread(ch, id) {
    cliCalls++;
    const all = data[ch];
    const rootOf = (e) => (e.tags.find((t) => t[3] === 'root') || [])[1] || e.id;
    const hit = all.find((e) => e.id === id);
    return hit ? all.filter((e) => rootOf(e) === rootOf(hit)) : [];
  },
  send: async () => ({ event_id: hex('s'), accepted: true }),
  members: async () => people.map((pk) => ({ pubkey: pk, name: 'agent_' + pk.slice(0, 3), isAgent: true })),
  presence: async () => ({}),
  nameOf: (pk) => 'agent_' + pk.slice(0, 3),
  isAgent: () => true,
  ensureProfiles: async () => undefined,
};
let onLive;
const live = {
  onEvent: (cb) => ((onLive = cb), disp),
  onState: () => disp,
  subscribe: noop,
  unsubscribe: noop,
  state: { state: 'live' },
  isLive: true,
  out: { appendLine: noop },
  publish: noop,
  fetch: async () => undefined,
};
const ext = {
  workspaceState: { get: () => undefined, update: async () => undefined },
  globalState: { get: () => undefined, update: async () => undefined },
  extensionUri: { toString: () => '' },
};

const posted = [];
let onMsg;
const c = new ChatController(ext, client, live, {}, {}, { available: false });
c.attach({
  kind: 'panel',
  webview: {
    options: {},
    html: '',
    asWebviewUri: (u) => u,
    cspSource: '',
    onDidReceiveMessage: (cb) => ((onMsg = cb), disp),
    postMessage: async (m) => posted.push(m),
  },
  isVisible: () => true,
  onVisibility: () => disp,
  onDispose: () => disp,
  reveal: noop,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB';
const heap = () => {
  if (global.gc) global.gc();
  return process.memoryUsage().heapUsed;
};
const settle = async () => {
  // let the controller's timers (live batch, members, presence) run
  for (let i = 0; i < 10; i++) await sleep(25);
};

(async () => {
  console.log(`dataset: ${data.A.length} messages / ${THREADS} threads per channel; page ${PAGE}`);
  const h0 = heap();
  await onMsg({ type: 'ready' });
  await settle();
  const threadsMsgs = posted.filter((m) => m.type === 'threads');
  console.log(
    `open channel: ${threadsMsgs.length} list posts, ${threadsMsgs[threadsMsgs.length - 1].items.length} threads shown, ${cliCalls} CLI calls, byId ${c.byId.size}`,
  );
  const withRoot = threadsMsgs[threadsMsgs.length - 1].items.filter((t) => t.snippet && !/older|eski/i.test(t.snippet)).length;
  console.log(`threads with their first message: ${withRoot}/${threadsMsgs[threadsMsgs.length - 1].items.length}`);

  // load everything (as a long session would) to measure the per-event costs on a full channel
  let guard = 0;
  while (!posted.some((m) => m.type === 'olderDone') && guard++ < 50) await onMsg({ type: 'older' });
  console.log(`after loading all pages: byId ${c.byId.size}, heap ${mb(heap() - h0)} over baseline`);

  // a live reply arriving: the list is rebuilt
  posted.length = 0;
  const t1 = performance.now();
  for (let i = 0; i < 20; i++) {
    onLive(c.subId, ev('live' + i, 'A', now + i, LONG, people[0], 'ar5'));
    await sleep(130);
  }
  const perLive = (performance.now() - t1 - 20 * 130) / 20;
  console.log(`live message -> list rebuild: ~${Math.max(0, perLive).toFixed(1)} ms each (${posted.filter((m) => m.type === 'threads').length} list posts)`);

  // opening the big thread, then a nested reply that re-renders it fully
  posted.length = 0;
  let t2 = performance.now();
  await onMsg({ type: 'openThread', id: hex('ar0') });
  await settle();
  const open = performance.now() - t2;
  const thread = posted.find((m) => m.type === 'thread');
  console.log(`open a ${thread.items.length}-message thread: ${open.toFixed(0)} ms (markdown for every message)`);
  posted.length = 0;
  t2 = performance.now();
  onLive(c.subId, {
    ...ev('nested', 'A', now + 100, 'nested reply', people[1], 'ar0'),
    tags: [
      ['h', 'A'],
      ['e', hex('ar0'), '', 'root'],
      ['e', hex('ar0x3'), '', 'reply'],
    ],
  });
  await sleep(200);
  const again = posted.find((m) => m.type === 'thread');
  console.log(`nested reply -> full re-render of ${again ? again.items.length : 0} messages: ~${(performance.now() - t2 - 200).toFixed(0)} ms`);

  // channel switching back and forth: does memory come back?
  const hA = heap();
  for (let i = 0; i < 20; i++) {
    await onMsg({ type: 'select', id: i % 2 ? 'A' : 'B' });
    await settle();
  }
  const hB = heap();
  console.log(`20 channel switches: heap ${mb(hA - h0)} -> ${mb(hB - h0)} over baseline (${(hB - hA) / 1024 / 1024 > 5 ? 'GROWS' : 'stable'})`);
  c.dispose();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
