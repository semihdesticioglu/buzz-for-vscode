// stress_network.js — a flaky network and an unreliable relay/CLI against the real ChatController (out/chat.js):
//   1. CLI reads of 2–5 s while the channel is switched 10 times (no leak, right channelId, no duplicate ids)
//   2. the first 3 reads fail with BuzzError code 2, the list recovers by the poll alone (refreshSeconds = 2)
//   3a. live state churn through a fake manager (a 'live' post per change, no re-subscribe by the chat)
//   3b. the real LiveManager + LiveRelay against a local ws relay that drops the connection 3 times
//   4. every live read incomplete: the CLI answers thread roots and search, nothing is cached as final
//   5. garbage from the CLI (no tags / created_at / id / pubkey, content not a string, id not hex, null)
//   6. 500 live events in one tick: one batched ingest, a bounded number of 'threads' posts
//   7. typing signals of unknown pubkeys: sane 'working' / 'presence' posts, expiry
//   8. dispose() with a slow read in flight: nothing posted afterwards, no timers left
// Run: node stress_network.js <path to buzz-vscode>   — exit 1 on any FAIL, well under 3 minutes.
'use strict';
const Module = require('module');
const path = require('path');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');
if (!PROJ) {
  console.error('usage: node stress_network.js <path to buzz-vscode>');
  process.exit(2);
}

// ---------------------------------------------------------------- timer accounting (installed before the extension loads)
const real = { setTimeout, clearTimeout, setInterval, clearInterval };
const activeTimers = new Map(); // handle -> { kind, ms, stack }
global.setTimeout = function (fn, ms, ...args) {
  const h = real.setTimeout(function () {
    activeTimers.delete(h);
    return fn.apply(this, args);
  }, ms);
  activeTimers.set(h, { kind: 'timeout', ms, stack: new Error().stack });
  return h;
};
global.clearTimeout = function (h) {
  activeTimers.delete(h);
  return real.clearTimeout(h);
};
global.setInterval = function (fn, ms, ...args) {
  const h = real.setInterval(fn, ms, ...args);
  activeTimers.set(h, { kind: 'interval', ms, stack: new Error().stack });
  return h;
};
global.clearInterval = function (h) {
  activeTimers.delete(h);
  return real.clearInterval(h);
};
const TIME_SCALE = Number(process.env.BUZZ_TIME_SCALE) || 1; // time bounds x this (run.js: 3 in CI, where runners are slower and shared)
const sleep = (ms) => new Promise((r) => real.setTimeout(r, ms));
async function waitFor(pred, ms, step = 20) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return !!pred();
}

// ---------------------------------------------------------------- bookkeeping
let pass = 0;
let fail = 0;
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push('unhandledRejection: ' + ((e && e.stack) || e)));
process.on('uncaughtException', (e) => unhandled.push('uncaughtException: ' + ((e && e.stack) || e)));
const ok = (name, cond, info) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info === undefined ? null : info).slice(0, 600)));
};
const info = (s) => console.log('  info: ' + s);
const metrics = [];
const metric = (k, v) => metrics.push([k, String(v)]);
const watchdog = real.setTimeout(() => {
  console.log('FAIL harness watchdog: 170 s elapsed');
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  process.exit(1);
}, 170_000);

// ---------------------------------------------------------------- fake vscode
const noop = () => undefined;
const disp = { dispose: noop };
const cfgValues = { refreshSeconds: 2, relayUrl: '' }; // the poll runs every 2 s when there is no live connection
const fakeVscode = {
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in cfgValues ? cfgValues[k] : d), update: async () => undefined }),
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
    withProgress: (_o, f) => f(),
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
  Disposable: class {
    constructor(fn) {
      this.fn = fn;
    }
    dispose() {
      if (this.fn) this.fn();
    }
  },
  env: { language: 'en', openExternal: noop, clipboard: { writeText: async () => undefined } },
  ViewColumn: { Active: -1, Beside: -2 },
  ConfigurationTarget: { Global: 1 },
  ProgressLocation: { Window: 10 },
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
const core = require(path.join(PROJ, 'out', 'core.js'));

// ---------------------------------------------------------------- data
const hex = (s) => (s + '0'.repeat(64)).slice(0, 64);
const now = Math.floor(Date.now() / 1000);
const ME = hex('ff');
const AG = hex('a1');
const P1 = hex('b1');
const U1 = hex('e1'); // a stranger: no profile
const KEY = 'a'.repeat(63) + '1'; // a valid secp256k1 private key for the real relay (scenario 3b)
const profiles = { [ME]: { name: 'me' }, [AG]: { name: 'lead_agent', bot: true }, [P1]: { name: 'Ada' } };
const range = (n) => Array.from({ length: n }, (_, i) => i);
const ev = (id, ch, ts, content, pk = P1, root, kind = 9) => ({
  id: hex(id),
  pubkey: pk,
  kind,
  created_at: ts,
  content,
  tags: [['h', ch], ...(root ? [['e', hex(root), '', 'root']] : [])],
});
/** `n` root messages of a channel (prefix: a hex digit so ids say which channel they belong to). */
const roots = (ch, prefix, n = 40) =>
  range(n).map((j) => ev(`${prefix}a${j.toString(16).padStart(3, '0')}`, ch, now - 10000 + j * 10, `thread ${prefix}-${j}`, j % 2 ? P1 : AG));
const chan = (id, name) => ({ id, name, isDm: false });

/** A Buzz client over fixed data; `over.before(ch, opts, n)` may delay or throw before a read, names come from the real helpers. */
function makeClient(chs, data, over = {}) {
  const calls = { messages: [], thread: [], search: [], ensureProfiles: 0, members: 0 };
  // over.asCli: rows as the real BuzzClient hands them over (malformed ones dropped and counted on the page)
  const asCli = (rows) => (over.asCli ? core.eventPage(rows) : rows);
  const client = {
    myPubkey: ME,
    me: async () => ({ pubkey: ME, name: 'me' }),
    channels: async () => chs.slice(),
    allChannels: async () => chs.slice(),
    dms: async () => [],
    async messages(ch, o = {}) {
      calls.messages.push({ ch, o: { ...o }, at: Date.now() });
      if (over.before) await over.before(ch, o, calls.messages.length);
      let page = data[ch] || [];
      if (o.before) page = page.filter((e) => e.created_at < o.before);
      if (o.since) page = page.filter((e) => e && e.created_at >= o.since);
      return asCli(page.slice(-(o.limit || 100)));
    },
    async thread(ch, id) {
      calls.thread.push({ ch, id });
      if (over.thread) return asCli(await over.thread(ch, id));
      const all = data[ch] || [];
      const rootOf = (e) => (e.tags.find((t) => t[3] === 'root') || [])[1] || e.id;
      const hit = all.find((e) => e.id === id);
      return hit ? all.filter((e) => rootOf(e) === rootOf(hit)) : [];
    },
    send: async () => ({ event_id: hex('5e'), accepted: true }),
    members: async () => {
      calls.members++;
      return [
        { pubkey: AG, name: 'lead_agent', isAgent: true },
        { pubkey: P1, name: 'Ada', isAgent: false },
      ];
    },
    presence: async () => ({}),
    // the real BuzzClient's behaviour for unknown (or missing) keys, through the same helpers
    nameOf: (pk) => core.displayNameOf(profiles[pk], pk),
    isAgent: (pk) => core.looksLikeAgent(profiles[pk], client.nameOf(pk)),
    ensureProfiles: async () => {
      calls.ensureProfiles++;
    },
    search: async (q, limit) => {
      calls.search.push({ q, limit });
      return over.search ? over.search(q, limit) : [];
    },
    calls,
  };
  return client;
}

/** A fake live manager: state changes and events are fired by the harness, every call is recorded. */
function fakeLive(state = 'offline') {
  const evCbs = new Set();
  const stCbs = new Set();
  const subs = new Map();
  const live = {
    state: { state },
    isLive: state === 'live',
    subs,
    subCalls: [],
    unsubCalls: [],
    fetchCalls: [],
    fetchImpl: undefined, // (filters, timeoutMs) => QueryResult | undefined
    onEvent: (cb) => (evCbs.add(cb), { dispose: () => evCbs.delete(cb) }),
    onState: (cb) => (stCbs.add(cb), { dispose: () => stCbs.delete(cb) }),
    subscribe: (id, f) => {
      subs.set(id, f);
      live.subCalls.push(id);
    },
    unsubscribe: (id) => {
      subs.delete(id);
      live.unsubCalls.push(id);
    },
    publish: () => false,
    fetch: async (filters, timeoutMs) => {
      live.fetchCalls.push(filters);
      return live.fetchImpl ? live.fetchImpl(filters, timeoutMs) : undefined;
    },
    fire: (sub, e) => evCbs.forEach((cb) => cb(sub, e)),
    setState: (s) => {
      live.state = s;
      live.isLive = s.state === 'live';
      stCbs.forEach((cb) => cb(s));
    },
    mainSub: () => [...subs.keys()].find((k) => !/-(typing|other)$/.test(k)),
    typingSub: () => [...subs.keys()].find((k) => k.endsWith('-typing')),
  };
  return live;
}

const ext = {
  workspaceState: { get: () => undefined, update: async () => undefined },
  globalState: { get: () => undefined, update: async () => undefined },
  extensionUri: { toString: () => '' },
};

/** The real controller attached to a fake webview; everything posted is kept, 'threads' posts remember the last 'channel'. */
function world(client, live) {
  const posted = [];
  const rec = { lastChannel: undefined, threads: [] };
  let onMsg;
  let visCb;
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
        if (m.type === 'channel') rec.lastChannel = m.id;
        if (m.type === 'threads') rec.threads.push({ channelId: m.channelId, lastChannel: rec.lastChannel, ids: m.items.map((t) => t.id), at: Date.now() });
        posted.push(m);
      },
    },
    isVisible: () => true,
    onVisibility: (cb) => ((visCb = cb), disp),
    onDispose: () => disp,
    reveal: noop,
    close: noop,
  });
  return { c, client, live, posted, rec, msg: (m) => onMsg(m), visible: () => visCb(), take: () => posted.splice(0) };
}
const lastOf = (msgs, type, pred = () => true) => [...msgs].reverse().find((m) => m.type === type && pred(m));

// ================================================================ 1. slow CLI while switching channels
async function s1() {
  console.log('\n[1] CLI reads of 2-5 s while the channel is switched 10 times');
  const chs = range(10).map((i) => chan('c' + i, 'chan' + i));
  const data = {};
  chs.forEach((ch, i) => (data[ch.id] = roots(ch.id, String(i))));
  let n = 0;
  const client = makeClient(chs, data, { before: () => sleep(2000 + ((n++ * 937) % 3001)) });
  const live = fakeLive();
  const w = world(client, live);
  void w.msg({ type: 'ready' });
  await sleep(150);
  const order = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c3'];
  for (const id of order) {
    void w.msg({ type: 'select', id });
    await sleep(100);
  }
  const tSwitch = Date.now();
  const final = order[order.length - 1];
  await waitFor(() => w.rec.threads.some((t) => t.channelId === final && t.ids.length), 9000);
  const tList = Date.now();
  await sleep(600);
  const th = w.rec.threads;
  ok(
    'every "threads" carries the channelId of the channel posted last',
    th.length > 0 && th.every((t) => t.channelId === t.lastChannel),
    th.map((t) => [t.channelId, t.lastChannel]),
  );
  ok(
    'no thread of another channel leaks into a list',
    th.every((t) => t.ids.every((id) => id[0] === t.channelId.slice(1))),
    th.map((t) => [t.channelId, [...new Set(t.ids.map((i) => i[0]))]]),
  );
  ok(
    'no duplicate thread ids within one "threads"',
    th.every((t) => new Set(t.ids).size === t.ids.length),
    th.map((t) => t.ids.length),
  );
  const last = th[th.length - 1];
  ok(
    'the list of the channel picked last arrives, complete',
    !!last && last.channelId === final && last.ids.length === 40,
    last && [last.channelId, last.ids.length],
  );
  ok(
    'no stale list of an earlier channel was posted',
    th.every((t) => t.channelId === final),
    th.map((t) => t.channelId),
  );
  const bad = w.posted.filter((m) => m.type === 'error' || (m.type === 'status' && m.text));
  ok('no error and no status text', !bad.length, bad);
  metric('[1] threads posts / CLI reads', `${th.length} / ${client.calls.messages.length}`);
  metric('[1] ms from the last switch to its list', tList - tSwitch);
  w.c.dispose();
}

// ================================================================ 2. the CLI fails 3 times, the poll recovers
async function s2() {
  console.log('\n[2] messages() fails with BuzzError code 2 three times, then works: recovery by the poll alone');
  const chs = [chan('c0', 'chan0')];
  const data = { c0: roots('c0', '0') };
  const client = makeClient(chs, data, {
    before: (_ch, _o, n) => {
      if (n <= 3) throw new core.BuzzError(2, 'network', 'relay unreachable (stress)');
    },
  });
  const w = world(client, fakeLive()); // no live connection: the poll runs every refreshSeconds (2 s)
  const t0 = Date.now();
  await w.msg({ type: 'ready' });
  await sleep(100);
  const st = w.posted.filter((m) => m.type === 'status');
  ok(
    'the failed first read reaches the webview as status text (network wording + the CLI detail)',
    st.some((m) => /reach the relay/.test(m.text) && /relay unreachable \(stress\)/.test(m.text)),
    st,
  );
  ok(
    'the channel list is up meanwhile',
    w.posted.some((m) => m.type === 'channels' && m.ready === true),
    w.posted.map((m) => m.type),
  );
  ok(
    'an empty list is posted so the view is not left loading',
    w.rec.threads.some((t) => t.channelId === 'c0' && t.ids.length === 0),
    w.rec.threads,
  );
  let readsAtRecovery = 0;
  const got = await waitFor(() => {
    if (w.rec.threads.some((t) => t.channelId === 'c0' && t.ids.length === 40)) {
      readsAtRecovery = readsAtRecovery || client.calls.messages.length;
      return true;
    }
    return false;
  }, 15000);
  const dt = Date.now() - t0;
  ok('the list recovers without a "refresh" within 15 s', got, { ms: dt, reads: client.calls.messages.length });
  await sleep(300);
  const reads = client.calls.messages.map((c) => ({ ...c.o, at: c.at - t0 }));
  ok(
    'the 4th CLI read (the poll after 3 failures) is the one that brings the list',
    readsAtRecovery >= 4 && reads.length >= 4 && reads[3].before === undefined,
    { readsAtRecovery, reads },
  );
  const extra = reads.slice(4);
  ok('no extra CLI read right after the recovery (the fill loop runs before the page is ingested)', extra.length === 0, extra);
  const lastStatus = lastOf(w.posted, 'status');
  ok('the status line is cleared after the recovery', !!lastStatus && lastStatus.text === '', lastStatus);
  ok(
    'no "error" message',
    !w.posted.some((m) => m.type === 'error'),
    w.posted.filter((m) => m.type === 'error'),
  );
  metric('[2] ms until recovery / reads', `${dt} / ${client.calls.messages.length}`);
  w.c.dispose();
}

// ================================================================ 2b. a failed first read right after another channel was read
// ================================================================ 2c. the same, and a channel event (a reaction) comes before the poll
async function s2c() {
  console.log('\n[2c] the first read fails, then a reaction in the channel: the re-read it triggers brings the cursors');
  const chs = [chan('c0', 'chan0'), chan('c1', 'chan1')];
  const data = { c0: roots('c0', '0'), c1: roots('c1', '1', 200) };
  let c1Fails = 1;
  const client = makeClient(chs, data, {
    before: (ch) => {
      if (ch === 'c1' && c1Fails-- > 0) throw new core.BuzzError(2, 'network', 'blip (stress 2c)');
    },
  });
  const live = fakeLive();
  const w = world(client, live);
  await w.msg({ type: 'ready' });
  await sleep(200);
  await w.msg({ type: 'select', id: 'c1' });
  await sleep(50);
  const other = [...live.subs.keys()].find((k) => k.endsWith('-other'));
  // a reaction (kind 7) in c1: not a message, so the controller schedules a re-read of the latest page
  live.fire(other, {
    id: hex('7a'),
    pubkey: P1,
    kind: 7,
    created_at: now,
    content: '+',
    tags: [
      ['h', 'c1'],
      ['e', hex('1a000')],
    ],
  });
  const got = await waitFor(() => {
    const th = lastOf(w.posted, 'threads', (m) => m.channelId === 'c1');
    return !!th && th.items.length >= 100 && th.more === true;
  }, 6000 * TIME_SCALE);
  const reads = client.calls.messages.filter((x) => x.ch === 'c1').map((x) => x.o);
  ok('2c: after the re-read a reaction triggered, the list has its cursors and offers older threads', got, reads);
  w.take();
  await w.msg({ type: 'older' });
  await sleep(300);
  const after = lastOf(w.posted, 'threads', (m) => m.channelId === 'c1');
  ok('2c: "Older threads" reads the next page', !!after && after.items.length >= 200, after && after.items.length);
  w.c.dispose();
}

async function s2b() {
  console.log('\n[2b] the first read of a channel fails right after another channel was read: the next poll is a full one');
  const chs = [chan('c0', 'chan0'), chan('c1', 'chan1')];
  const data = { c0: roots('c0', '0'), c1: roots('c1', '1', 200) };
  let c1Fails = 1;
  const client = makeClient(chs, data, {
    before: (ch) => {
      if (ch === 'c1' && c1Fails-- > 0) throw new core.BuzzError(2, 'network', 'blip (stress 2b)');
    },
  });
  const w = world(client, fakeLive()); // no live connection: the poll runs every refreshSeconds (2 s)
  await w.msg({ type: 'ready' }); // c0 opens and its page is reconciled: the 60 s full re-read is not due for a minute
  await sleep(200);
  w.take();
  await w.msg({ type: 'select', id: 'c1' });
  await sleep(100);
  ok(
    '2b: the failed read reaches the webview as status text',
    w.posted.some((m) => m.type === 'status' && /blip \(stress 2b\)/.test(m.text)),
    w.posted.filter((m) => m.type === 'status'),
  );
  const got = await waitFor(() => {
    const th = lastOf(w.posted, 'threads', (m) => m.channelId === 'c1');
    return !!th && th.items.length >= 100 && th.more === true;
  }, 6000 * TIME_SCALE);
  const th = lastOf(w.posted, 'threads', (m) => m.channelId === 'c1');
  const reads = client.calls.messages.filter((x) => x.ch === 'c1').map((x) => x.o);
  ok('2b: within one poll the list holds the whole first page and offers older threads', got, { items: th && th.items.length, more: th && th.more, reads });
  ok(
    '2b: that poll is a full read, not the incremental one (since/limit 50) that would leave no cursor',
    reads.length >= 2 && reads[1].since === undefined,
    reads,
  );
  w.take();
  await w.msg({ type: 'older' });
  await sleep(300);
  const after = lastOf(w.posted, 'threads', (m) => m.channelId === 'c1');
  ok('2b: "Older threads" then reads the next page', !!after && after.items.length >= 200, after && after.items.length);
  w.c.dispose();
}

// ================================================================ 3a. state churn through the fake manager
async function s3fake() {
  console.log('\n[3a] the live manager reports offline->connecting->live five times (fake manager)');
  const chs = [chan('c0', 'chan0')];
  const client = makeClient(chs, { c0: roots('c0', '0') });
  const live = fakeLive();
  const w = world(client, live);
  await w.msg({ type: 'ready' });
  await sleep(150);
  w.take();
  const subsBefore = live.subCalls.length;
  const readsBefore = client.calls.messages.length;
  const seq = [];
  for (let i = 0; i < 5; i++)
    for (const s of ['offline', 'connecting', 'live']) {
      live.setState({ state: s, detail: s === 'offline' ? 'connection closed (1006)' : undefined });
      seq.push(s);
      await sleep(30);
    }
  await sleep(300);
  const posts = w.posted.filter((m) => m.type === 'live').map((m) => m.state);
  ok('every state change reaches the webview as a "live" message, in order', JSON.stringify(posts) === JSON.stringify(seq), posts);
  ok(
    'the chat does not re-send subscriptions on state changes (0 per channel per reconnect; the manager re-sends)',
    live.subCalls.length === subsBefore,
    live.subCalls.slice(subsBefore),
  );
  const reads = client.calls.messages.length - readsBefore;
  ok('a catch-up read per "live" at most', reads >= 1 && reads <= 5, reads);
  const th = w.rec.threads;
  ok(
    'lists posted during the churn carry the current channel and no duplicates',
    th.every((t) => t.channelId === 'c0' && new Set(t.ids).size === t.ids.length),
    th.length,
  );
  metric('[3a] live posts / catch-up reads / threads posts', `${posts.length} / ${reads} / ${th.length}`);
  w.c.dispose();
}

// ================================================================ 3b. the real LiveManager + LiveRelay against a local relay
async function s3real() {
  console.log('\n[3b] the real LiveManager + LiveRelay against a local ws relay that drops the connection 3 times');
  const WebSocket = require(path.join(PROJ, 'node_modules', 'ws'));
  const { LiveManager } = require(path.join(PROJ, 'out', 'live.js'));
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  cfgValues.relayUrl = `ws://127.0.0.1:${wss.address().port}`;
  const conns = []; // one per connection: the REQs it saw per subscription id
  wss.on('connection', (sock) => {
    const conn = { reqs: {}, sock };
    conns.push(conn);
    sock.on('error', noop);
    sock.on('message', (d) => {
      let m;
      try {
        m = JSON.parse(d.toString());
      } catch {
        return;
      }
      if (m[0] === 'AUTH' && m[1] && m[1].id) sock.send(JSON.stringify(['OK', m[1].id, true, '']));
      if (m[0] === 'REQ') conn.reqs[m[1]] = (conn.reqs[m[1]] || 0) + 1;
    });
    sock.send(JSON.stringify(['AUTH', 'challenge-' + conns.length]));
  });
  const lm = new LiveManager({ key: async () => KEY });
  const subCalls = [];
  const origSub = lm.subscribe.bind(lm);
  lm.subscribe = (id, f) => {
    subCalls.push(id);
    origSub(id, f);
  };
  const chs = [chan('c0', 'chan0')];
  const client = makeClient(chs, { c0: roots('c0', '0') });
  const w = world(client, lm);
  await w.msg({ type: 'ready' });
  await sleep(100);
  const subIds = subCalls.slice();
  const liveStates = () => w.posted.filter((m) => m.type === 'live').map((m) => m.state);
  const livePosts = () => w.posted.filter((m) => m.type === 'live' && m.state === 'live').length;
  const t0 = Date.now();
  await lm.restart();
  const up = await waitFor(() => lm.isLive && livePosts() === 1, 6000);
  ok('the real manager connects to the local relay (NIP-42) and the webview gets "live"', up, liveStates());
  metric('[3b] ms to the first live', Date.now() - t0);
  const r1 = await lm.fetch([{ kinds: [9], limit: 1 }], 300);
  ok(
    'a live read the relay never finishes resolves {complete:false, reason:"timeout"}',
    !!r1 && r1.complete === false && r1.reason === 'timeout' && r1.events.length === 0,
    r1,
  );
  const drops = [];
  for (let k = 0; k < 3; k++) {
    const n = conns.length;
    const lp = livePosts();
    const ts = Date.now();
    conns[conns.length - 1].sock.terminate();
    const off = await waitFor(() => !lm.isLive, 3000);
    const whileOff = await lm.fetch([{ kinds: [9] }], 300);
    const back = await waitFor(() => conns.length > n && lm.isLive && livePosts() > lp, 12000);
    drops.push({ off, whileOff, back, ms: Date.now() - ts });
    await sleep(100);
  }
  ok(
    'each drop is noticed (not live) and a fetch meanwhile resolves undefined',
    drops.every((d) => d.off && d.whileOff === undefined),
    drops,
  );
  ok(
    'the connection comes back after each drop (backoff 1 s, 2 s, 5 s) and the webview gets "live" each time',
    drops.every((d) => d.back) && conns.length === 4,
    drops.map((d) => d.ms),
  );
  const perConn = conns.map((c) => c.reqs);
  ok(
    'after every reconnect each of the 3 chat subscriptions is re-sent exactly once',
    conns.length === 4 && subIds.length === 3 && conns.every((c) => subIds.every((id) => c.reqs[id] === 1)),
    perConn,
  );
  ok(
    'no REQ for a subscription the chat never made (one-shot reads aside)',
    conns.every((c) => Object.keys(c.reqs).every((id) => subIds.includes(id) || id.startsWith('q-'))),
    perConn,
  );
  ok('the chat itself did not subscribe again on reconnect', subCalls.length === subIds.length, subCalls);
  const states = liveStates();
  ok(
    'the webview saw 4x connecting, 4x live, 3x offline',
    states.filter((s) => s === 'live').length === 4 &&
      states.filter((s) => s === 'offline').length === 3 &&
      states.filter((s) => s === 'connecting').length === 4,
    states,
  );
  const reads = client.calls.messages.length;
  ok('a catch-up read follows each "live" (the initial read + one per connection at least)', reads >= 5, reads);
  const th = w.rec.threads;
  ok(
    'every list posted meanwhile is the current channel, without duplicates',
    th.every((t) => t.channelId === 'c0' && new Set(t.ids).size === t.ids.length),
    th.length,
  );
  metric('[3b] reconnect ms (3 drops)', drops.map((d) => d.ms).join(', '));
  metric('[3b] REQ per connection', JSON.stringify(perConn.map((r) => Object.values(r))));
  lm.dispose();
  w.c.dispose();
  cfgValues.relayUrl = '';
  for (const c of conns) c.sock.terminate();
  await new Promise((r) => wss.close(() => r()));
}

// ================================================================ 4. every live read incomplete
async function s4() {
  console.log('\n[4] live fetch answers {complete:false} for everything: the CLI covers roots and search, nothing is final');
  const CH = 'c4';
  const ROLD = '4c001'; // a first message older than the page; the CLI has it
  const RGONE = '4c002'; // a first message the CLI cannot read at first (network), later it can
  const RBIG = '4c003'; // a thread of exactly 500 messages (the CLI's page), its root in the page: the rest is read live
  const RBIG2 = '4c004'; // the same, but the root is older than the page (fillRoots pulls the thread through the CLI first)
  const page = roots(CH, '4', 35);
  const oldRoot = ev(ROLD, CH, now - 50000, 'the old question', AG);
  const goneRoot = ev(RGONE, CH, now - 50000, 'the gone question', AG);
  const bigRoot = ev(RBIG, CH, now - 9500, 'the big question', AG);
  const big2Root = ev(RBIG2, CH, now - 40000, 'the other big question', AG);
  const oldReplies = range(3).map((i) => ev(`4b1${i.toString(16).padStart(2, '0')}`, CH, now - 9000 + i, 'old reply ' + i, P1, ROLD));
  const goneReplies = range(2).map((i) => ev(`4b2${i.toString(16).padStart(2, '0')}`, CH, now - 8000 + i, 'gone reply ' + i, P1, RGONE));
  const bigInPage = range(2).map((i) => ev(`4b3${i.toString(16).padStart(3, '0')}`, CH, now - 100 + i * 10, 'big reply new ' + i, P1, RBIG));
  const bigRest = range(497).map((i) => ev(`4b3${(i + 2).toString(16).padStart(3, '0')}`, CH, now - 9000 + i * 10, 'big reply ' + i, i % 2 ? P1 : AG, RBIG));
  const olderReply = ev('4b3fff', CH, now - 9400, 'the very first reply', P1, RBIG);
  const big2InPage = range(2).map((i) => ev(`4b4${i.toString(16).padStart(3, '0')}`, CH, now - 200 + i * 10, 'big2 reply new ' + i, P1, RBIG2));
  const big2Rest = range(497).map((i) =>
    ev(`4b4${(i + 2).toString(16).padStart(3, '0')}`, CH, now - 30000 + i * 10, 'big2 reply ' + i, i % 2 ? P1 : AG, RBIG2),
  );
  page.push(bigRoot, ...oldReplies, ...goneReplies, ...bigInPage, ...big2InPage);
  page.sort((a, b) => a.created_at - b.created_at);
  let goneFails = true;
  const client = makeClient(
    [chan(CH, 'chan4')],
    { [CH]: page },
    {
      thread: async (_ch, id) => {
        if (id === hex(RGONE) && goneFails) throw new core.BuzzError(2, 'network', 'thread read failed (stress)');
        if (id === hex(ROLD)) return [oldRoot, ...oldReplies];
        if (id === hex(RGONE)) return [goneRoot, ...goneReplies];
        if (id === hex(RBIG)) return [bigRoot, ...bigInPage, ...bigRest]; // exactly 500
        if (id === hex(RBIG2)) return [big2Root, ...big2InPage, ...big2Rest]; // exactly 500
        return [];
      },
      search: async () => [ev('4d001', CH, now - 50, 'the needle is here', P1)],
    },
  );
  const live = fakeLive('live');
  live.fetchImpl = async () => ({ events: [], complete: false, reason: 'timeout' });
  const w = world(client, live);
  await w.msg({ type: 'ready' });
  await sleep(500);
  const row = (id) => {
    const t = lastOf(w.posted, 'threads');
    return t && t.items.find((x) => x.id === hex(id));
  };
  ok(
    'the missing first messages are looked for over the live connection first (ids filter)',
    live.fetchCalls.some((f) => Array.isArray(f[0].ids) && f[0].ids.includes(hex(ROLD))),
    live.fetchCalls.map((f) => Object.keys(f[0])),
  );
  ok(
    'the live read being incomplete, the CLI is asked for every missing root',
    client.calls.thread.some((t) => t.id === hex(ROLD)) && client.calls.thread.some((t) => t.id === hex(RGONE)),
    client.calls.thread,
  );
  ok('the root the CLI found shows its text in the list', !!row(ROLD) && row(ROLD).snippet === 'the old question', row(ROLD));
  ok('the root nobody could confirm is not cached as tried (looked for again later)', !w.c.rootsTried.has(hex(RGONE)) && w.c.rootsRetryAt > Date.now(), {
    tried: [...w.c.rootsTried].map((x) => x.slice(0, 5)),
    retryAt: w.c.rootsRetryAt - Date.now(),
  });
  info(`the retry is due in ${Math.round((w.c.rootsRetryAt - Date.now()) / 1000)} s; the harness moves that time to now`);
  goneFails = false;
  w.c.rootsRetryAt = 0;
  const before = client.calls.thread.length;
  live.fire(live.mainSub(), ev('4e001', CH, now + 1, 'something new', P1));
  await sleep(500);
  ok(
    'after the retry time the root is read again (CLI) and shows up',
    client.calls.thread.slice(before).some((t) => t.id === hex(RGONE)) && !!row(RGONE) && row(RGONE).snippet === 'the gone question',
    { calls: client.calls.thread.slice(before), row: row(RGONE) },
  );
  // search
  w.take();
  await w.msg({ type: 'search', query: 'needle', scope: 'channel' });
  await sleep(100);
  const sr = lastOf(w.posted, 'searchResults');
  ok(
    'search: the live read is incomplete, so the CLI search answers (no error, the CLI hit)',
    live.fetchCalls.some((f) => f[0].search === 'needle') &&
      client.calls.search.length === 1 &&
      !!sr &&
      !sr.error &&
      sr.items.length === 1 &&
      sr.items[0].id === hex('4d001'),
    sr,
  );
  // a long thread
  w.take();
  await w.msg({ type: 'openThread', id: hex(RBIG) });
  await sleep(400);
  const th1 = lastOf(w.posted, 'thread', (m) => m.id === hex(RBIG));
  ok(
    'a 500-message thread whose older part the live read cut short is posted as partial',
    !!th1 && th1.partial === true && th1.items.length === 500,
    th1 && { partial: th1.partial, items: th1.items.length },
  );
  ok(
    'the live read for the older part used the root, the conversation and until',
    live.fetchCalls.some((f) => f[0]['#e'] && f[0]['#e'][0] === hex(RBIG) && f[0]['#h'][0] === CH && typeof f[0].until === 'number'),
    live.fetchCalls.filter((f) => f[0]['#e']),
  );
  live.fetchImpl = async (f) => (f[0]['#e'] ? { events: [olderReply], complete: true, reason: 'eose' } : { events: [], complete: false, reason: 'timeout' });
  w.take();
  await w.msg({ type: 'openThread', id: hex(RBIG) });
  await sleep(400);
  const th2 = lastOf(w.posted, 'thread', (m) => m.id === hex(RBIG));
  ok(
    '"partial" was not final: a later complete read brings the rest and clears it',
    !!th2 && !th2.partial && th2.items.length === 501 && th2.items.some((x) => x.id === hex('4b3fff')),
    th2 && { partial: th2.partial, items: th2.items.length },
  );
  // the same thread length, but its root was older than the page: fillRoots read the CLI's capped 500 at select time
  live.fetchImpl = async () => ({ events: [], complete: false, reason: 'timeout' });
  w.take();
  await w.msg({ type: 'openThread', id: hex(RBIG2) });
  await sleep(400);
  const th3 = lastOf(w.posted, 'thread', (m) => m.id === hex(RBIG2));
  ok(
    'a capped thread fillRoots pulled earlier: once opened and found partial, the webview is told so',
    !!th3 && th3.items.length === 500 && th3.partial === true,
    th3 && {
      partial: th3.partial,
      items: th3.items.length,
      partialThreadsHasIt: w.c.partialThreads.has(hex(RBIG2)),
      threadPosts: w.posted.filter((m) => m.type === 'thread').map((m) => [m.items.length, m.partial]),
    },
  );
  metric('[4] CLI thread reads / live fetches', `${client.calls.thread.length} / ${live.fetchCalls.length}`);
  w.c.dispose();
}

// ================================================================ 5. garbage from the CLI
async function s5() {
  console.log('\n[5] garbage from the CLI: objects missing fields, wrong types, a null');
  const garbage = {
    g1: { desc: 'no tags', e: { id: hex('e1'), pubkey: P1, kind: 9, content: 'no tags', created_at: now } },
    g2: { desc: 'no created_at', e: { id: hex('e2'), pubkey: P1, kind: 9, content: 'no created_at', tags: [['h', 'g2']] } },
    g3: { desc: 'content is a number', e: { id: hex('e3'), pubkey: P1, kind: 9, content: 42, created_at: now, tags: [['h', 'g3']] } },
    g4: { desc: 'id not hex', e: { id: 'not-a-hex-id', pubkey: P1, kind: 9, content: 'bad id', created_at: now, tags: [['h', 'g4']] } },
    g5: { desc: 'no id', e: { pubkey: P1, kind: 9, content: 'no id', created_at: now, tags: [['h', 'g5']] } },
    g6: { desc: 'no pubkey', e: { id: hex('e6'), kind: 9, content: 'no pubkey', created_at: now, tags: [['h', 'g6']] } },
    g7: { desc: 'a null element', e: null },
  };
  const keys = Object.keys(garbage);
  const chs = [chan('g0', 'clean'), ...keys.map((k) => chan(k, 'garbage-' + k))];
  const data = { g0: roots('g0', 'd', 5) };
  const valid = {};
  for (const k of keys) {
    valid[k] = roots(k, 'd', 5).map((e, j) => ({ ...e, id: hex(`d${k[1]}${j}`) }));
    data[k] = [...valid[k], garbage[k].e];
  }
  const client = makeClient(chs, data);
  const w = world(client, fakeLive());
  await w.msg({ type: 'ready' });
  await sleep(150);
  const shown = {};
  for (const k of keys) {
    w.take();
    const unh = unhandled.length;
    await w.msg({ type: 'select', id: k });
    await sleep(200);
    const errs = w.posted.filter((m) => m.type === 'error' || (m.type === 'status' && m.text));
    const th = lastOf(w.posted, 'threads', (m) => m.channelId === k);
    const hasValid = !!th && valid[k].every((e) => th.items.some((t) => t.id === e.id));
    ok(
      `garbage "${garbage[k].desc}": the list is still posted with the 5 valid messages, nothing thrown`,
      !errs.length && hasValid && unhandled.length === unh,
      {
        errors: errs.map((e) => e.message || e.text),
        listPosted: !!th,
        rows: th && th.items.map((t) => String(t.id).slice(0, 6)),
      },
    );
    shown[k] = th ? th.items.length - 5 : 'no list';
  }
  info('garbage rows shown per kind: ' + JSON.stringify(Object.fromEntries(keys.map((k) => [garbage[k].desc, shown[k]]))));
  // the incremental poll after a message without created_at
  await w.msg({ type: 'select', id: 'g2' });
  await sleep(100);
  const before = client.calls.messages.length;
  w.visible(); // the view became visible: the controller polls right away
  await sleep(300);
  const polls = client.calls.messages.slice(before).filter((c) => c.o.since !== undefined);
  ok(
    'the incremental poll after a message without created_at still sends a finite "since"',
    polls.length > 0 && polls.every((p) => Number.isFinite(p.o.since)),
    polls.map((p) => ({ ...p.o, since: String(p.o.since) })),
  );
  w.c.dispose();
}

// ================================================================ 5b. one malformed row inside a full page
async function s5b() {
  console.log('\n[5b] one malformed row inside a full page: the page still counts as full; the log hears of it once');
  const lines = [];
  require(path.join(PROJ, 'out', 'log.js')).log.init({ appendLine: (l) => lines.push(l) });
  for (const asCli of [false, true]) await s5bPages(asCli);
  // a malformed row that stays in the poll window: one log line, not one per poll
  await s5bLog(lines);
}

/** A full page and a 500-row thread with one malformed row, the rows as the CLI prints them or as BuzzClient hands them over. */
async function s5bPages(asCli) {
  const how = asCli ? ' (rows as BuzzClient hands them over)' : ' (rows as the CLI prints them)';
  // "Older threads" over 300 threads, one row of the second page malformed
  const CH = 'm1';
  const rows = range(300).map((j) => ev(`50${j.toString(16).padStart(3, '0')}`, CH, now - 100000 + j * 10, `thread ${j}`));
  rows[150] = { ...rows[150], content: 42 };
  const client = makeClient([chan(CH, 'pages')], { [CH]: rows }, { asCli });
  const w = world(client, fakeLive());
  await w.msg({ type: 'ready' });
  await sleep(300);
  for (let click = 0; click < 4 && !w.posted.some((m) => m.type === 'olderDone'); click++) {
    await w.msg({ type: 'older' });
    await sleep(200);
  }
  const th = lastOf(w.posted, 'threads', (m) => m.channelId === CH);
  ok('5b: a malformed row in a full page does not end "Older threads": every other thread is reachable' + how, !!th && th.items.length === 299, {
    items: th && th.items.length,
    reads: client.calls.messages.length,
  });
  w.c.dispose();
  // a thread of exactly 500 CLI rows, one malformed: still read on over the live connection
  const CH2 = 'm2';
  const R = '5c001';
  const root = ev(R, CH2, now - 20000, 'the question');
  const replies = range(499).map((j) => ev(`5c1${j.toString(16).padStart(3, '0')}`, CH2, now - 19000 + j * 10, `reply ${j}`, P1, R));
  const olderReply = ev('5c0ff', CH2, now - 19500, 'the oldest reply, only over the live connection', P1, R);
  const cliThread = [root, ...replies];
  cliThread[250] = { ...cliThread[250], content: 42 };
  const client2 = makeClient([chan(CH2, 'thread')], { [CH2]: replies.slice(-100) }, { thread: async () => cliThread.slice(), asCli });
  const live2 = fakeLive('live');
  live2.fetchImpl = async (f) => (f[0]['#e'] ? { events: [olderReply], complete: true, reason: 'eose' } : { events: [], complete: false, reason: 'timeout' });
  const w2 = world(client2, live2);
  await w2.msg({ type: 'ready' });
  await sleep(400);
  w2.take();
  await w2.msg({ type: 'openThread', id: hex(R) });
  await sleep(400);
  const t2 = lastOf(w2.posted, 'thread', (m) => m.id === hex(R));
  ok(
    '5b: a thread of 500 CLI rows with a malformed one is still read on over the live connection (its oldest reply shows)' + how,
    !!t2 && t2.items.some((x) => x.id === hex('5c0ff')) && !t2.partial,
    { items: t2 && t2.items.length, partial: t2 && t2.partial, liveThreadReads: live2.fetchCalls.filter((f) => f[0]['#e']).length },
  );
  w2.c.dispose();
}

async function s5bLog(lines) {
  const CH3 = 'm3';
  const rows3 = range(20).map((j) => ev(`5d${j.toString(16).padStart(3, '0')}`, CH3, now - 100 + j, `t ${j}`));
  rows3.push({ id: hex('5dfff'), pubkey: P1, kind: 9, created_at: now, content: 42, tags: [['h', CH3]] });
  const client3 = makeClient([chan(CH3, 'poll')], { [CH3]: rows3 });
  lines.length = 0;
  const w3 = world(client3, fakeLive());
  await w3.msg({ type: 'ready' });
  await sleep(300);
  const reads0 = client3.calls.messages.length;
  for (let i = 0; i < 5; i++) {
    w3.visible(); // the view became visible: a poll right away
    await sleep(120);
  }
  const logged = lines.filter((l) => /malformed/.test(l));
  ok(
    '5b: a malformed row that stays in the poll window is logged once, not on every poll',
    logged.length === 1 && client3.calls.messages.length - reads0 >= 3,
    {
      polls: client3.calls.messages.length - reads0,
      logged,
    },
  );
  w3.c.dispose();
}

// ================================================================ 6. 500 live events in one tick
async function s6() {
  console.log('\n[6] 500 live events delivered in one tick for the current channel');
  const CH = 'c6';
  const client = makeClient([chan(CH, 'chan6')], { [CH]: roots(CH, '6', 35) });
  const live = fakeLive('live');
  const w = world(client, live);
  await w.msg({ type: 'ready' });
  await sleep(300);
  w.take();
  const unh = unhandled.length;
  const profilesBefore = client.calls.ensureProfiles;
  const threadsBefore = w.rec.threads.length;
  const sub = live.mainSub();
  const burstRoots = range(300).map((i) => ev(`6b${i.toString(16).padStart(3, '0')}`, CH, now + 1 + i, 'burst root ' + i, i % 3 ? P1 : AG));
  const burstReplies = range(200).map((i) =>
    ev(`6c${i.toString(16).padStart(3, '0')}`, CH, now + 400 + i, 'burst reply ' + i, AG, `6b${(i % 300).toString(16).padStart(3, '0')}`),
  );
  const t0 = Date.now();
  for (const e of [...burstRoots, ...burstReplies]) live.fire(sub, e);
  const tFire = Date.now() - t0;
  await waitFor(() => w.rec.threads.length > threadsBefore, 3000);
  const tFirst = Date.now() - t0;
  await sleep(800);
  const th = w.rec.threads.slice(threadsBefore);
  const last = lastOf(w.posted, 'threads');
  ok('the thread list is posted a bounded number of times (1-2) for the whole burst', th.length >= 1 && th.length <= 2, th.length);
  ok(
    'one batched ingest: profiles were looked up once for the batch',
    client.calls.ensureProfiles - profilesBefore === 1,
    client.calls.ensureProfiles - profilesBefore,
  );
  ok(
    'the list holds the 35 old and 300 new threads, every id once',
    !!last && last.items.length === 335 && new Set(last.items.map((t) => t.id)).size === 335,
    last && last.items.length,
  );
  ok(
    'replies of the burst are counted under their roots',
    !!last &&
      burstReplies.every(
        (r) => (last.items.find((t) => t.id === hex(`6b${(burstReplies.indexOf(r) % 300).toString(16).padStart(3, '0')}`)) || { replies: 0 }).replies >= 1,
      ),
    last && last.items.filter((t) => t.replies).length,
  );
  const elsewhere = w.posted.filter((m) => m.type === 'elsewhere');
  ok(
    'one "elsewhere" notice for the batch, counting the messages',
    elsewhere.length === 1 && elsewhere[0].count === 500,
    elsewhere.map((m) => m.count),
  );
  ok('no unhandled rejection during the burst', unhandled.length === unh, unhandled.slice(unh));
  metric('[6] threads posts for 500 events', th.length);
  metric('[6] ms: fire loop / until the list', `${tFire} / ${tFirst}`);
  w.c.dispose();
}

// ================================================================ 7. typing signals of strangers
async function s7() {
  console.log('\n[7] typing signals for unknown pubkeys');
  const CH = 'c7';
  const client = makeClient([chan(CH, 'chan7')], { [CH]: roots(CH, '7', 35) });
  const live = fakeLive('live');
  const w = world(client, live);
  await w.msg({ type: 'ready' });
  await sleep(300);
  w.take();
  const typing = (pk, extra = {}, content = '') => ({
    id: hex('7e' + Math.random().toString(16).slice(2, 8)),
    pubkey: pk,
    kind: core.TYPING_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags: [['h', CH], ...(extra.thread ? [['e', extra.thread, '', 'root']] : [])],
  });
  const tsub = live.typingSub();
  live.fire(tsub, typing(U1));
  await sleep(150);
  let wk = lastOf(w.posted, 'working');
  const sane = (m) =>
    !!m &&
    Array.isArray(m.items) &&
    Array.isArray(m.busy) &&
    Array.isArray(m.channel) &&
    m.items.every((i) => typeof i.name === 'string' && i.name && typeof i.isAgent === 'boolean' && i.real === true) &&
    m.busy.every((b) => typeof b === 'string');
  ok(
    'a stranger typing in the channel: a sane "working" post naming the short key, not an agent',
    sane(wk) && wk.items.length === 1 && wk.items[0].name === U1.slice(0, 8) && wk.items[0].isAgent === false && wk.busy.length === 0,
    wk,
  );
  const pr = lastOf(w.posted, 'presence');
  ok('the stranger counts as online (just active) in the presence map', !!pr && pr.map[U1] === 'online', pr && pr.map[U1]);
  w.take();
  const X = hex('7f0a'); // a thread nobody has loaded
  live.fire(tsub, typing(U1, { thread: X }));
  await sleep(150);
  wk = lastOf(w.posted, 'working');
  ok(
    'typing in an unknown thread: that thread is busy, nobody shown in "New thread" or the channel',
    sane(wk) && wk.busy.length === 1 && wk.busy[0] === X && wk.items.length === 0 && wk.channel.length === 0,
    wk,
  );
  w.take();
  live.fire(tsub, typing(U1, { thread: X }, '{"typing":false}'));
  await sleep(150);
  wk = lastOf(w.posted, 'working');
  ok('a stop signal clears it', sane(wk) && wk.busy.length === 0 && wk.items.length === 0, wk);
  w.take();
  live.fire(tsub, typing(ME));
  await sleep(150);
  ok(
    'my own typing signal changes nothing',
    !w.posted.some((m) => m.type === 'working'),
    w.posted.map((m) => m.type),
  );
  w.take();
  const U2 = hex('e2');
  live.fire(tsub, typing(U2));
  await sleep(150);
  wk = lastOf(w.posted, 'working');
  ok('a second stranger shows up', sane(wk) && wk.items.length === 1 && wk.items[0].name === U2.slice(0, 8), wk);
  const n = w.posted.filter((m) => m.type === 'working').length;
  await sleep(8600); // TYPING_TTL = 8 s
  const later = w.posted.filter((m) => m.type === 'working');
  wk = later[later.length - 1];
  ok(
    'the indicator expires on its own after 8 s (a "working" post with nobody)',
    later.length > n && sane(wk) && wk.items.length === 0 && wk.busy.length === 0,
    { posts: later.length - n, last: wk },
  );
  metric('[7] working posts', w.posted.filter((m) => m.type === 'working').length);
  w.c.dispose();
}

// ================================================================ 8. dispose with a slow read in flight
async function s8() {
  console.log('\n[8] dispose() while a slow messages() is in flight');
  const CH = 'c8';
  const client = makeClient([chan(CH, 'chan8')], { [CH]: roots(CH, '8') }, { before: () => sleep(1500) });
  const live = fakeLive();
  const w = world(client, live);
  void w.msg({ type: 'ready' });
  await sleep(300);
  ok('the read is in flight when dispose() is called', client.calls.messages.length === 1 && !w.rec.threads.length, {
    reads: client.calls.messages.length,
    threads: w.rec.threads.length,
  });
  const n = w.posted.length;
  w.c.dispose();
  await sleep(2000); // the read resolves at 1.5 s
  ok(
    'nothing is posted after dispose (the late read is dropped)',
    w.posted.length === n,
    w.posted.slice(n).map((m) => m.type),
  );
  ok('dispose() unsubscribes every live subscription', live.subs.size === 0 && live.unsubCalls.length >= 3, {
    left: [...live.subs.keys()],
    unsub: live.unsubCalls.length,
  });
  ok('the controller reports not alive', w.c.alive === false, w.c.alive);
}

// ================================================================ run
(async () => {
  const t0 = Date.now();
  for (const s of [s1, s2, s2b, s2c, s3fake, s3real, s4, s5, s5b, s6, s7, s8]) {
    try {
      await s();
    } catch (e) {
      ok(`${s.name}: the scenario ran without a harness exception`, false, (e && e.stack) || String(e));
    }
  }
  // every controller was disposed: after 2 s of idle nothing of the extension may still be scheduled
  console.log('\n[timers] after every dispose()');
  await sleep(2000);
  const left = [...activeTimers.values()].map(
    (t) => `${t.kind} ${t.ms}ms @ ${(t.stack.split('\n').find((l) => /buzz-vscode[\\/]out/.test(l)) || t.stack.split('\n')[2] || '').trim()}`,
  );
  ok('no timers of the extension are left after dispose (setTimeout/setInterval accounting)', activeTimers.size === 0, left);
  real.clearTimeout(watchdog);
  const handles = process.getActiveResourcesInfo().filter((x) => x === 'Timeout' || x === 'Immediate');
  ok('Node reports no active timer handles (the process would exit on its own)', handles.length === 0, handles);
  ok('no unhandled rejections or uncaught exceptions during the run', unhandled.length === 0, unhandled);
  console.log('\nmetrics');
  for (const [k, v] of metrics) console.log(`  ${k.padEnd(48)} ${v}`);
  console.log(`  ${'total run time (s)'.padEnd(48)} ${((Date.now() - t0) / 1000).toFixed(1)}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
