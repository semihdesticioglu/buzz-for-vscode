// stress_rapid.js — an impatient user. The real ChatController (out/chat.js) with a fake vscode module and a fake
// Buzz client that answers with small random latencies (5–60 ms). Bursts of select / search / older / openThread /
// send / setLanguage, then dispose() in the middle of a burst.
//
//   node test/harness/stress_rapid.js   [SEED=n]
//
// Prints PASS/FAIL lines, a final "N passed, M failed" line and exits 1 on any FAIL (or when something keeps the
// event loop alive after the run).
const Module = require('module');
const path = require('path');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');
if (!PROJ) {
  console.error('usage: node stress_rapid.js <buzz-vscode repo>');
  process.exit(2);
}

// ------------------------------------------------------------------ bookkeeping
let pass = 0;
let fail = 0;
const ok = (name, cond, info) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info).slice(0, 500)));
};
const stray = [];
process.on('unhandledRejection', (e) => stray.push('unhandledRejection: ' + ((e && e.stack) || e)));
process.on('uncaughtException', (e) => stray.push('uncaughtException: ' + ((e && e.stack) || e)));

// seeded latencies, so a failure can be run again
let seed = Number(process.env.SEED) || Date.now() % 100000;
console.log(`seed ${seed}`);
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const TIME_SCALE = Number(process.env.BUZZ_TIME_SCALE) || 1; // time bounds x this (run.js: 3 in CI, where runners are slower and shared)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r)); // a separate turn without a timer (every setTimeout here rounds to ~15 ms)
let inflight = 0; // fake client / relay calls in progress
const lat = async () => {
  inflight++;
  await sleep(5 + Math.floor(rand() * 56));
  inflight--;
};

// ------------------------------------------------------------------ fake vscode
const noop = () => undefined;
const disp = { dispose: noop };
let langSetting = 'auto';
let onConfigChange = null; // what extension.ts does in onDidChangeConfiguration for buzz.language
let updateChain = Promise.resolve(); // VS Code writes settings one after the other; each write fires its own event
const fakeVscode = {
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => (k === 'language' ? langSetting : d),
      update: (k, v) => {
        if (k !== 'language') return Promise.resolve();
        updateChain = updateChain.then(async () => {
          langSetting = v;
          await Promise.resolve(); // the event comes after the write, not inside the call
          if (onConfigChange) onConfigChange();
        });
        return updateChain;
      },
    }),
    onDidChangeConfiguration: () => disp,
    asRelativePath: (u) => String(u),
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    showInformationMessage: noop,
    showErrorMessage: noop,
    showWarningMessage: noop,
    createOutputChannel: () => ({ appendLine: noop }),
  },
  commands: { executeCommand: async () => undefined, registerCommand: () => disp },
  Uri: { joinPath: (...a) => ({ toString: () => a.join('/'), fsPath: a.join('/') }), file: (p) => ({ fsPath: p }), parse: (s) => ({ toString: () => s }) },
  EventEmitter: class {
    constructor() {
      this.event = () => disp;
    }
    fire() {}
    dispose() {}
  },
  env: { language: 'en', openExternal: noop, clipboard: { writeText: async () => undefined } },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ViewColumn: { Active: -1, Beside: -2 },
  ProgressLocation: { Window: 10 },
  Range: class {},
  Position: class {},
  Selection: class {},
  ThemeIcon: class {},
  Disposable: class {
    constructor(f) {
      this.dispose = f || noop;
    }
  },
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') return fakeVscode;
  return origLoad.apply(this, arguments);
};
const { ChatController } = require(path.join(PROJ, 'out', 'chat.js'));
const i18n = require(path.join(PROJ, 'out', 'i18n.js'));

// ------------------------------------------------------------------ data: three channels
const hex = (s) => (s + '0'.repeat(64)).slice(0, 64);
const ME = hex('ff');
const AG = hex('ee'); // an agent
const P = hex('dd'); // a person
const KEYS = ['A', 'B', 'C'];
const CH = { A: 'chan-aaaa', B: 'chan-bbbb', C: 'chan-cccc' };
const COUNT = { A: 150, B: 40, C: 350 }; // roots; the first 10 roots of each channel have 2 replies in the pages
const PREFIX = { A: 'a', B: 'b', C: 'c' };
const keyOf = (ch) => KEYS.find((k) => CH[k] === ch);
const now = Math.floor(Date.now() / 1000);
const BASE = now - 600;
const mk = (id, ch, ts, content, pk, root) => ({
  id,
  pubkey: pk,
  kind: 9,
  created_at: ts,
  content,
  tags: [['h', ch], ...(root ? [['e', root, '', 'root']] : [])],
});
const h4 = (i) => i.toString(16).padStart(4, '0');
const rootId = (k, i) => hex(PREFIX[k] + '0' + h4(i));
const replyId = (k, i, j) => hex(PREFIX[k] + '1' + h4(i) + j);
const hiddenId = (k, i) => hex(PREFIX[k] + '2' + h4(i));
const data = {};
for (const k of KEYS) {
  const timeline = [];
  const hidden = new Map(); // root -> a reply only `messages thread` returns (older than the pages hold)
  for (let i = 0; i < COUNT[k]; i++) {
    const ts = BASE - i * 10;
    const root = mk(rootId(k, i), CH[k], ts, `${k} topic ${i} q${i % 10}`, i % 3 === 0 ? AG : P);
    timeline.push(root);
    if (i < 10) for (let j = 0; j < 2; j++) timeline.push(mk(replyId(k, i, j), CH[k], ts + 1 + j, `${k} reply ${i}.${j}`, j ? AG : ME, root.id));
    hidden.set(root.id, mk(hiddenId(k, i), CH[k], ts + 3, `${k} hidden reply ${i}`, AG, root.id));
  }
  data[k] = { timeline, hidden };
}
const sentChannel = new Map(); // sent event id -> channel key
const channelOfId = (id) => (id.startsWith('f0') ? sentChannel.get(id) : KEYS.find((k) => id.startsWith(PREFIX[k])));

// ------------------------------------------------------------------ fake client and live manager
const calls = { messages: [], thread: [], send: [], fetch: [] };
let sentVisible = true; // a sent root shows up in the pages at once (as the relay does)
let sentN = 0;
const client = {
  myPubkey: ME,
  me: async () => ({ pubkey: ME, name: 'me' }),
  channels: async () => KEYS.map((k) => ({ id: CH[k], name: 'chan-' + k.toLowerCase(), isDm: false })),
  allChannels: async () => {
    await lat();
    return KEYS.map((k) => ({ id: CH[k], name: 'chan-' + k.toLowerCase(), isDm: false }));
  },
  dms: async () => [],
  async messages(ch, o = {}) {
    await lat();
    calls.messages.push({ ch, limit: o.limit, since: o.since, before: o.before });
    const k = keyOf(ch);
    if (!k) return [];
    let evs = data[k].timeline.slice();
    if (o.since !== undefined) evs = evs.filter((e) => e.created_at >= o.since);
    if (o.before !== undefined) evs = evs.filter((e) => e.created_at < o.before);
    evs.sort((a, b) => b.created_at - a.created_at);
    return evs.slice(0, o.limit ?? 50);
  },
  async thread(ch, id) {
    await lat();
    calls.thread.push({ ch, id });
    const k = keyOf(ch);
    if (!k) return [];
    const all = [...data[k].timeline, ...data[k].hidden.values()];
    const hit = all.find((e) => e.id === id);
    if (!hit) return [];
    const rootOf = (e) => (e.tags.find((t) => t[0] === 'e' && t[3] === 'root') || [])[1] || e.id;
    const r = rootOf(hit);
    return all.filter((e) => rootOf(e) === r);
  },
  async send(ch, content, o = {}) {
    await lat();
    const id = hex('f0' + h4(sentN++));
    calls.send.push({ ch, content, mentions: o.mentions, replyTo: o.replyTo, id });
    const k = keyOf(ch);
    if (k) {
      sentChannel.set(id, k);
      const ev = mk(id, ch, Math.floor(Date.now() / 1000), content, ME, o.replyTo);
      if (sentVisible) data[k].timeline.push(ev);
      else data[k].hidden.set(id, ev); // only a thread read finds it; never in a page
    }
    return { event_id: id, accepted: true };
  },
  async members() {
    await lat();
    return [
      { pubkey: AG, name: 'agent', isAgent: true },
      { pubkey: P, name: 'Ada', isAgent: false },
    ];
  },
  async presence() {
    await lat();
    return { [AG]: 'online', [P]: 'online' };
  },
  nameOf: (pk) => (pk === ME ? 'me' : pk === AG ? 'agent' : pk === P ? 'Ada' : pk.slice(0, 6)),
  isAgent: (pk) => pk === AG,
  ensureProfiles: async () => {
    await lat();
  },
  async search(q) {
    await lat();
    return KEYS.flatMap((k) => data[k].timeline).filter((e) => e.content.includes(q));
  },
};
const subs = {};
const live = {
  onEvent: () => disp,
  onState: () => disp,
  subscribe: (id, f) => (subs[id] = f),
  unsubscribe: (id) => delete subs[id],
  state: { state: 'live' },
  isLive: true,
  publish: noop,
  out: { appendLine: noop },
  async fetch(filters) {
    const f = filters[0] || {};
    if (typeof f.search !== 'string') return undefined; // no live history here: the CLI reads the page (not a read)
    calls.fetch.push(f);
    await lat();
    let evs = KEYS.flatMap((k) => data[k].timeline).filter((e) => e.content.includes(f.search));
    if (Array.isArray(f['#h'])) evs = evs.filter((e) => f['#h'].includes(e.tags[0][1]));
    return { events: evs.slice(0, f.limit || 300), complete: true, reason: 'eose' };
  },
};
// the Memento write takes time too (VS Code writes it to its storage): a few ms, as any storage write
const ext = {
  workspaceState: { get: () => undefined, update: async () => undefined },
  globalState: {
    get: () => undefined,
    update: async () => {
      await sleep(5);
    },
  },
  extensionUri: { toString: () => '' },
};

// ------------------------------------------------------------------ the controller and its fake host
let shownChannel; // what the webview's composer shows: the last 'channel' message it received
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
    postMessage: async (m) => {
      if (m.type === 'channel') shownChannel = m.id;
      posted.push(Object.assign({}, m, { _t: Date.now() }));
    },
  },
  isVisible: () => true,
  onVisibility: () => disp,
  onDispose: () => disp,
  reveal: noop,
  close: noop,
});
onConfigChange = () => {
  i18n.setLang(i18n.resolveLang(langSetting, 'en'));
  c.languageChanged();
};
const send = (m) => {
  // like the real webview (media/chat.js send()), every message carries the channel on screen
  if (m.type === 'send' && m.channel === undefined) m = Object.assign({ channel: shownChannel }, m);
  const p = onMsg(m);
  p.catch((e) => stray.push('onMessage rejected: ' + ((e && e.stack) || e)));
  return p;
};
const take = () => posted.splice(0);
const lastOf = (msgs, type) => [...msgs].reverse().find((m) => m.type === type);
const ofType = (msgs, type) => msgs.filter((m) => m.type === type);
const uniq = (arr) => new Set(arr).size === arr.length;
/** Waits until nothing was posted and no fake call ran for `quietMs` (at most `maxMs`). */
async function settle(quietMs = 150, maxMs = 6000) {
  const start = Date.now();
  let lastLen = posted.length;
  let lastChange = Date.now();
  for (;;) {
    await sleep(20);
    if (posted.length !== lastLen || inflight > 0) {
      lastLen = posted.length;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) return true;
    if (Date.now() - start > maxMs) return false;
  }
}
async function waitFor(pred, maxMs = 3000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > maxMs) return false;
    await sleep(10);
  }
  return true;
}
/** Like waitFor, but looks after every turn of the loop (to land inside a window of a few ms). */
async function waitTicks(pred, maxMs = 3000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > maxMs) return false;
    await tick();
  }
  return true;
}
const errorsIn = (msgs) => [...ofType(msgs, 'error'), ...ofType(msgs, 'status').filter((s) => s.text)];
const subsOn = () => Object.values(subs).map((f) => (f[0] && f[0]['#h']) || []);
const section = (title) => {
  console.log(`\n--- ${title}`);
};

(async () => {
  const t0 = Date.now();
  // ------------------------------------------------------------ ready
  section('ready');
  await send({ type: 'ready' });
  await settle();
  let m = take();
  ok(
    'ready: channel list posted and the first channel opened',
    ofType(m, 'channels').some((x) => x.ready) && lastOf(m, 'threads') && lastOf(m, 'threads').channelId === CH.A,
    m.map((x) => x.type),
  );
  ok('ready: no error', errorsIn(m).length === 0, errorsIn(m));

  // ------------------------------------------------------------ 1. 30 selects in 300 ms
  section('1. thirty selects alternating three channels within 300 ms');
  const order = Array.from({ length: 30 }, (_, i) => KEYS[i % 3]);
  const lastKey = order[order.length - 1];
  const t1 = Date.now();
  for (let i = 0; i < order.length; i++) {
    send({ type: 'select', id: CH[order[i]] });
    await (i % 3 === 2 ? sleep(10) : tick()); // three quick clicks, a short pause, three more…
  }
  const burstMs = Date.now() - t1;
  const settled = await settle();
  m = take();
  // the pace is the harness's, not the extension's: it is shown, the checks are about what the controller did
  console.log(`INFO thirty selects fired in ${burstMs} ms`);
  ok('the controller settled after the burst', settled, { burstMs, settled });
  const chans = ofType(m, 'channel');
  ok(
    "the last 'channel' post is the last selected channel",
    chans.length > 0 && chans[chans.length - 1].id === CH[lastKey],
    chans.map((x) => x.id),
  );
  const thr = ofType(m, 'threads');
  ok(
    "the last 'threads' post belongs to the last selected channel",
    thr.length > 0 && thr[thr.length - 1].channelId === CH[lastKey],
    thr.map((x) => x.channelId),
  );
  const leaks = thr.filter((x) => x.items.some((t) => channelOfId(t.id) !== keyOf(x.channelId)));
  ok(
    "no 'threads' post carries another channel's threads",
    leaks.length === 0,
    leaks.map((x) => ({ ch: x.channelId, ids: x.items.filter((t) => channelOfId(t.id) !== keyOf(x.channelId)).map((t) => t.id.slice(0, 8)) })),
  );
  const lastThreads = thr[thr.length - 1];
  ok(
    'the last list holds the whole first page of that channel, no duplicates',
    lastThreads && uniq(lastThreads.items.map((t) => t.id)) && lastThreads.items.length >= 30,
    lastThreads && lastThreads.items.length,
  );
  ok(
    'the live subscriptions (messages, typing, other) end on the last channel',
    subsOn().length === 3 && subsOn().every((h) => h.length === 1 && h[0] === CH[lastKey]),
    subsOn(),
  );
  ok('the controller reports the last channel', c.channel && c.channel.id === CH[lastKey], c.channel);
  const lateChannelPost = chans.findIndex((x) => x.id === CH[lastKey]);
  ok(
    "after the last 'channel' post nothing arrives for another channel's list",
    thr.filter((x) => x._t > chans[chans.length - 1]._t && x.channelId !== CH[lastKey]).length === 0 && lateChannelPost >= 0,
    thr.map((x) => [x.channelId, x._t - chans[chans.length - 1]._t]),
  );
  ok('no error during the burst', errorsIn(m).length === 0, errorsIn(m));

  // ------------------------------------------------------------ 2. 10 searches in 100 ms (on C)
  section('2. ten searches within 100 ms');
  const queries = Array.from({ length: 10 }, (_, i) => 'q' + i);
  const t2 = Date.now();
  for (let i = 0; i < queries.length; i++) {
    send({ type: 'search', query: queries[i], scope: 'channel' });
    await (i % 2 ? sleep(10) : tick());
  }
  const searchMs = Date.now() - t2;
  await settle();
  m = take();
  const res = ofType(m, 'searchResults');
  console.log(`INFO ten searches fired in ${searchMs} ms`);
  ok(
    "the last 'searchResults' answers the last query",
    res.length > 0 && res[res.length - 1].query === 'q9',
    res.map((r) => r.query),
  );
  const firstLast = res.findIndex((r) => r.query === 'q9');
  ok(
    'no result for an older query after the last one',
    firstLast >= 0 && res.slice(firstLast).every((r) => r.query === 'q9'),
    res.map((r) => r.query),
  );
  ok(
    'every result carries only matches of its own query and channel',
    res.every((r) => r.items.every((i) => i.channelId === CH[lastKey] && i.snippet.includes(r.query))),
    res.map((r) => [r.query, r.items.length]),
  );
  ok('the last result is not empty', res.length > 0 && res[res.length - 1].items.length > 0, res.length && res[res.length - 1].items.length);
  ok('no error during the searches', errorsIn(m).length === 0, errorsIn(m));

  // ------------------------------------------------------------ 3. 'older' twenty times
  section("3a. 'older' twenty times in one burst (channel A: one older page left)");
  await send({ type: 'select', id: CH.A });
  await settle();
  take();
  calls.messages.length = 0;
  calls.fetch.length = 0;
  for (let i = 0; i < 20; i++) send({ type: 'older' });
  await settle();
  m = take();
  let befores = calls.messages.filter((x) => x.before !== undefined).map((x) => x.before);
  let untils = calls.fetch.filter((x) => x.until !== undefined).map((x) => x.until);
  ok('one burst of twenty clicks reads one page (one distinct cursor)', befores.length === 1 && untils.length === 0, { befores, untils });
  ok('no two reads with the same cursor', uniq(befores) && uniq(untils), { befores, untils });
  ok("'olderDone' exactly once", ofType(m, 'olderDone').length === 1, ofType(m, 'olderDone').length);
  let lt = lastOf(m, 'threads');
  // the list is posted just before `noOlder` is set, so it may still say more:true; the webview re-renders on olderDone
  ok(
    'the list then holds every thread of the channel once, and olderDone follows the last list',
    lt && lt.channelId === CH.A && lt.items.length === COUNT.A && uniq(lt.items.map((t) => t.id)) && lastOf(m, 'olderDone')._t >= lt._t,
    lt && [lt.items.length, lt.more],
  );

  section("3b. 'older' clicked every 15 ms until the end (channel C: three older pages)");
  await send({ type: 'select', id: CH.C });
  await settle();
  take();
  calls.messages.length = 0;
  calls.fetch.length = 0;
  let clicks = 0;
  for (let i = 0; i < 20; i++) {
    send({ type: 'older' });
    clicks++;
    await sleep(15);
    if (posted.some((x) => x.type === 'olderDone')) break; // the end was announced: a user stops clicking
  }
  await settle();
  m = take();
  befores = calls.messages.filter((x) => x.before !== undefined).map((x) => x.before);
  untils = calls.fetch.filter((x) => x.until !== undefined).map((x) => x.until);
  ok(`reads ≤ distinct pages (${clicks} clicks, ${befores.length} reads)`, befores.length === 3 && untils.length === 0, { clicks, befores, untils });
  ok('no two reads with the same cursor', uniq(befores) && uniq(untils), { befores, untils });
  ok("'olderDone' exactly once", ofType(m, 'olderDone').length === 1, ofType(m, 'olderDone').length);
  lt = lastOf(m, 'threads');
  ok(
    'the list holds every thread of C once, and olderDone follows the last list',
    lt && lt.channelId === CH.C && lt.items.length === COUNT.C && uniq(lt.items.map((t) => t.id)) && lastOf(m, 'olderDone')._t >= lt._t,
    lt && [lt.items.length, lt.more],
  );
  const thrLists = ofType(m, 'threads');
  ok(
    'every list posted meanwhile is for C and free of duplicates',
    thrLists.every((x) => x.channelId === CH.C && uniq(x.items.map((t) => t.id))),
    thrLists.map((x) => [x.channelId, x.items.length]),
  );
  // the button stays on screen until the next list render, so another click after the end is possible
  calls.messages.length = 0;
  for (let i = 0; i < 2; i++) send({ type: 'older' });
  await settle();
  m = take();
  ok(
    'a click after the end reads nothing and is answered (list + olderDone)',
    calls.messages.length === 0 && ofType(m, 'olderDone').length >= 1 && lastOf(m, 'threads') && lastOf(m, 'threads').more === false,
    { reads: calls.messages.length, types: m.map((x) => x.type) },
  );

  // ------------------------------------------------------------ 4. ten openThread in 50 ms
  section('4. ten openThread within 50 ms');
  calls.thread.length = 0;
  const t4 = Date.now();
  const timing = [];
  for (let i = 0; i < 10; i++) {
    const a = Date.now();
    send({ type: 'openThread', id: rootId('C', i) });
    const b = Date.now();
    await (i === 4 ? sleep(10) : tick());
    timing.push([b - a, Date.now() - b]);
  }
  const openMs = Date.now() - t4;
  const handlerMs = timing.reduce((a, x) => a + x[0], 0); // onMessage runs inline here: its own synchronous work is not the user's pace
  if (process.env.DEBUG) console.log('openThread handler ms / gap ms:', JSON.stringify(timing));
  await settle();
  m = take();
  const ths = ofType(m, 'thread');
  const LASTID = rootId('C', 9);
  console.log(`INFO ten openThread clicks: ${openMs - handlerMs} ms between clicks, ${handlerMs} ms inside the handlers`);
  ok(
    "the final 'thread' post is for the last id",
    ths.length > 0 && ths[ths.length - 1].id === LASTID,
    ths.map((x) => x.id && x.id.slice(0, 8)),
  );
  const firstLastIdx = ths.findIndex((x) => x.id === LASTID);
  ok(
    "after the last openThread no 'thread' post for an older id",
    firstLastIdx >= 0 && ths.slice(firstLastIdx).every((x) => x.id === LASTID),
    ths.map((x) => x.id && x.id.slice(0, 8)),
  );
  const fin = ths[ths.length - 1];
  ok(
    'the final thread holds root + 2 replies + the reply only the thread read brings, each once',
    fin && fin.items.length === 4 && uniq(fin.items.map((x) => x.id)) && fin.items.some((x) => x.id === hiddenId('C', 9)) && fin.items[0].isRoot,
    fin && fin.items.map((x) => x.id.slice(0, 8)),
  );
  ok(
    'threadAppend (if any) is for the open thread only',
    ofType(m, 'threadAppend').every((x) => x.id === LASTID),
    ofType(m, 'threadAppend').map((x) => x.id.slice(0, 8)),
  );
  ok('no error', errorsIn(m).length === 0, errorsIn(m));

  // ------------------------------------------------------------ 5. send while a select is in flight
  section("5. 'send' posted while a 'select' is in flight (the composer still shows channel A)");
  await send({ type: 'select', id: CH.A });
  await settle();
  await send({ type: 'openThread', id: rootId('A', 0) });
  await settle();
  take();
  calls.send.length = 0;
  send({ type: 'select', id: CH.B }); // the user clicks B...
  send({ type: 'send', text: 'typed into A thread 0', mentions: [], thread: rootId('A', 0) }); // ...and Enter lands before the 'channel' message
  await settle();
  m = take();
  let s = calls.send[0];
  ok(
    "a reply typed in A's thread is sent to channel A as a reply to that thread",
    calls.send.length === 1 && s.ch === CH.A && s.replyTo === rootId('A', 0),
    calls.send.map((x) => ({ ch: x.ch, replyTo: x.replyTo && x.replyTo.slice(0, 8) })),
  );
  ok('the composer was unlocked afterwards', lastOf(m, 'sending') && lastOf(m, 'sending').on === false, ofType(m, 'sending'));
  // the same with "New thread" showing in A
  await send({ type: 'select', id: CH.A });
  await settle();
  send({ type: 'newThread' });
  await settle();
  take();
  calls.send.length = 0;
  send({ type: 'select', id: CH.C });
  send({ type: 'send', text: 'new thread typed in A', mentions: [], thread: null });
  await settle();
  m = take();
  s = calls.send[0];
  ok(
    'a new thread typed in A (New thread on screen) is sent to channel A',
    calls.send.length === 1 && s.ch === CH.A && !s.replyTo,
    calls.send.map((x) => ({ ch: x.ch, replyTo: x.replyTo })),
  );
  ok('no error', errorsIn(m).length === 0, errorsIn(m));
  // Enter a few ms later: the controller has switched to B already, the 'channel' message is not out yet (its
  // Memento write is in progress), so the composer still shows A's thread
  section("5c. 'send' lands after the controller switched, before the webview heard about it");
  await send({ type: 'select', id: CH.A });
  await settle();
  await send({ type: 'openThread', id: rootId('A', 2) });
  await settle();
  take();
  calls.send.length = 0;
  send({ type: 'select', id: CH.B });
  const inWindow = await waitTicks(() => c.channel && c.channel.id === CH.B);
  const channelOut = posted.some((x) => x.type === 'channel' && x.id === CH.B);
  send({ type: 'send', text: 'typed into A thread 2', mentions: [], thread: rootId('A', 2) });
  await settle();
  m = take();
  s = calls.send[0];
  ok('the window exists: the controller is on B, the webview has not been told yet', inWindow && !channelOut, { inWindow, channelOut });
  ok(
    "the reply typed in A's thread is sent to channel A as a reply to that thread",
    calls.send.length === 1 && s.ch === CH.A && s.replyTo === rootId('A', 2),
    calls.send.map((x) => ({ ch: x.ch, replyTo: x.replyTo && x.replyTo.slice(0, 8) })),
  );
  ok(
    'the composer was unlocked, no error',
    lastOf(m, 'sending') && lastOf(m, 'sending').on === false && errorsIn(m).length === 0,
    m.map((x) => x.type),
  );
  section("5d. the same with 'New thread' on screen in A");
  await send({ type: 'select', id: CH.A });
  await settle();
  send({ type: 'newThread' });
  await settle();
  take();
  calls.send.length = 0;
  send({ type: 'select', id: CH.C });
  const inWindow2 = await waitTicks(() => c.channel && c.channel.id === CH.C);
  const channelOut2 = posted.some((x) => x.type === 'channel' && x.id === CH.C);
  send({ type: 'send', text: 'new thread typed in A (late)', mentions: [], thread: null });
  await settle();
  take();
  s = calls.send[0];
  ok('the window exists: the controller is on C, the webview has not been told yet', inWindow2 && !channelOut2, { inWindow2, channelOut2 });
  ok(
    'the new thread typed in A is sent to channel A',
    calls.send.length === 1 && s.ch === CH.A && !s.replyTo,
    calls.send.map((x) => ({ ch: x.ch, replyTo: x.replyTo })),
  );

  // ------------------------------------------------------------ 6. newThread, then two sends quickly
  section("6a. 'newThread' then two sends in a row (the root arrives before the composer unlocks)");
  await send({ type: 'select', id: CH.A });
  await settle();
  send({ type: 'newThread' });
  await settle();
  take();
  calls.send.length = 0;
  sentVisible = true;
  send({ type: 'send', text: '@agent first', mentions: [AG], thread: null });
  await waitFor(() => posted.some((x) => x.type === 'sending' && x.on === false));
  let viewThread = (() => {
    const t = lastOf(posted, 'thread');
    return t ? t.id : null; // what the composer shows when the user types the second message
  })();
  const firstId = calls.send[0] && calls.send[0].id;
  send({ type: 'send', text: 'second', mentions: [], thread: viewThread });
  await settle();
  m = take();
  ok('two sends reached the client', calls.send.length === 2, calls.send.length);
  ok('the root arrived and opened before the second message was typed', viewThread === firstId, {
    viewThread: viewThread && viewThread.slice(0, 8),
    firstId: firstId && firstId.slice(0, 8),
  });
  ok(
    'the second message is a reply to the first (its root had arrived)',
    calls.send[1] && calls.send[1].ch === CH.A && calls.send[1].replyTo === firstId,
    calls.send.map((x) => ({ ch: x.ch, replyTo: x.replyTo && x.replyTo.slice(0, 8) })),
  );
  ok(
    "'sent' twice, composer unlocked twice, no error",
    ofType(m, 'sent').length === 2 && ofType(m, 'sending').filter((x) => !x.on).length === 2 && errorsIn(m).length === 0,
    m.map((x) => x.type),
  );

  section("6b. 'newThread' then two sends in a row (the root does not arrive)");
  send({ type: 'newThread' });
  await settle();
  take();
  calls.send.length = 0;
  sentVisible = false;
  send({ type: 'send', text: '@agent third', mentions: [AG], thread: null });
  await waitFor(() => posted.some((x) => x.type === 'sending' && x.on === false));
  viewThread = (() => {
    const t = lastOf(posted, 'thread');
    return t ? t.id : null;
  })();
  send({ type: 'send', text: 'fourth', mentions: [], thread: viewThread });
  await settle();
  m = take();
  sentVisible = true;
  ok('two sends reached the client', calls.send.length === 2, calls.send.length);
  ok('the composer still showed "New thread" (no root arrived)', viewThread === null, viewThread);
  ok(
    'the second message is not a reply to the first',
    calls.send[1] && calls.send[1].ch === CH.A && !calls.send[1].replyTo,
    calls.send.map((x) => ({ ch: x.ch, replyTo: x.replyTo })),
  );
  ok('no error', errorsIn(m).length === 0, errorsIn(m));

  // ------------------------------------------------------------ 7. setLanguage toggled five times
  section('7. setLanguage toggled five times with a thread open');
  await send({ type: 'openThread', id: rootId('A', 1) });
  await settle();
  take();
  const langs = ['tr', 'en', 'tr', 'en', 'tr'];
  for (const l of langs) send({ type: 'setLanguage', lang: l });
  await settle();
  m = take();
  const i18ns = ofType(m, 'i18n');
  ok(
    'five i18n posts, in the order of the toggles',
    i18ns.map((x) => x.lang).join() === langs.join(),
    i18ns.map((x) => x.lang),
  );
  const word = (x) => x.strings && x.strings.newThread;
  ok(
    'the strings follow the language of each post',
    i18ns.length === 5 && word(i18ns[0]) !== word(i18ns[1]) && i18ns.every((x) => word(x) === word(x.lang === 'tr' ? i18ns[0] : i18ns[1])),
    i18ns.map((x) => [x.lang, word(x)]),
  );
  const thPosts = ofType(m, 'thread');
  ok(
    'the open thread is re-posted once per toggle',
    thPosts.length === 5 && thPosts.every((x) => x.id === rootId('A', 1)),
    thPosts.map((x) => x.id && x.id.slice(0, 8)),
  );
  ok(
    'no duplicate items in any re-posted thread; the same items each time',
    thPosts.every((x) => uniq(x.items.map((i) => i.id)) && x.items.length === thPosts[0].items.length && x.items.length >= 3),
    thPosts.map((x) => x.items.length),
  );
  const listPosts = ofType(m, 'threads');
  ok(
    'the list is re-posted for A without duplicates',
    listPosts.length >= 5 && listPosts.every((x) => x.channelId === CH.A && uniq(x.items.map((t) => t.id))),
    listPosts.map((x) => [x.channelId, x.items.length]),
  );
  ok(
    'the channel notes are re-posted',
    ofType(m, 'channels').length === 5 && ofType(m, 'channels').every((x) => x.ready && x.items.length === 3),
    ofType(m, 'channels').length,
  );
  ok('the language ends on the last toggle', i18n.lang() === 'tr', i18n.lang());
  ok('no error', errorsIn(m).length === 0, errorsIn(m));
  send({ type: 'setLanguage', lang: 'en' });
  await settle();
  take();

  // ------------------------------------------------------------ 8. dispose in the middle of a burst
  section('8. dispose() in the middle of a burst');
  const strayBefore = stray.length;
  send({ type: 'select', id: CH.C });
  send({ type: 'search', query: 'q3', scope: 'all' });
  send({ type: 'older' });
  await sleep(8);
  send({ type: 'openThread', id: rootId('C', 4) });
  send({ type: 'send', text: '@agent while leaving', mentions: [AG], thread: null });
  send({ type: 'select', id: CH.B });
  send({ type: 'setLanguage', lang: 'tr' });
  await sleep(12);
  const postsAtDispose = posted.length;
  c.dispose();
  await sleep(700);
  await waitFor(() => inflight === 0, 3000);
  await sleep(200);
  ok(
    'no posts after dispose()',
    posted.length === postsAtDispose,
    posted.slice(postsAtDispose).map((x) => x.type),
  );
  ok('the live subscriptions are gone', Object.keys(subs).length === 0, Object.keys(subs));
  ok('no unhandled rejection or exception during the burst and the dispose', stray.length === strayBefore, stray.slice(strayBefore));
  ok('the controller reports not alive', c.alive === false, c.alive);
  // nothing of the extension keeps the event loop alive: after our own timers are done, only the loop's own handles remain
  await new Promise((r) => setImmediate(r));
  const active = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : ['(getActiveResourcesInfo unavailable)'];
  const keepers = active.filter((x) => x === 'Timeout' || x === 'Immediate');
  ok('no timer of the extension is left running after dispose()', keepers.length === 0, active);

  // ------------------------------------------------------------ end
  ok('no unhandled rejection or uncaught exception anywhere', stray.length === 0, stray);
  ok(`the whole run finished well within 3 minutes (${((Date.now() - t0) / 1000).toFixed(1)} s)`, Date.now() - t0 < 120000 * TIME_SCALE, Date.now() - t0);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
  // the process must end by itself: if anything keeps the loop alive this watchdog ends it (and the run fails)
  const watchdog = setTimeout(() => {
    console.log(
      'FAIL the process is still alive 2 s after the end (something keeps the event loop alive): ' +
        JSON.stringify(process.getActiveResourcesInfo ? process.getActiveResourcesInfo() : []),
    );
    process.exit(1);
  }, 2000);
  watchdog.unref();
})().catch((e) => {
  console.error(e);
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
