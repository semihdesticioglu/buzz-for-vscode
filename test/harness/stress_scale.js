// Scale stress: a big, busy workspace against the real ChatController (out/chat.js) and the real chat webview.
// Run with: node stress_scale.js <project>   (the controller part re-runs itself under node --expose-gc)
//
// Controller: 50 channels, one with 5,000 messages across 400 threads (one thread of 1,500 replies); fake vscode,
// fake Buzz client, fake live manager answering ids / #e thread pages / #h older pages / search filters.
// Webview: the real page (src/chatHtml.ts + media/chat.css + media/chat.js) in headless Chrome, fed 500 thread rows,
// a 1,500-message thread with markdown html, the filter, and 40+40 re-renders.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHILD = process.argv.includes('--controller-child');
const PROJ = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || require('path').resolve(__dirname, '..', '..');
if (!PROJ) {
  console.error('usage: node stress_scale.js <project>');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const unexpected = [];
process.on('unhandledRejection', (e) => unexpected.push('unhandledRejection: ' + (e && e.stack ? e.stack : e)));
process.on('uncaughtException', (e) => unexpected.push('uncaughtException: ' + (e && e.stack ? e.stack : e)));
const ok = (name, cond, info) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + (typeof info === 'string' ? info : JSON.stringify(info))));
};
const metrics = [];
// a time budget is a few times what this machine takes (they vary 2-3x with load), so it catches a regression of
// another order (a quadratic loop, a read per message), not noise; structure (rows thrown away, reads) is exact
const metric = (name, value, unit, limit) => {
  const lim = limit === undefined ? undefined : unit === 'ms' ? limit * TIME_SCALE : limit;
  metrics.push({ name, value, unit, limit: lim });
  const text = `${name}: ${typeof value === 'number' ? (Number.isInteger(value) ? value : value.toFixed(1)) : value} ${unit}`;
  if (lim === undefined) console.log('INFO ' + text);
  else ok(text + ` (limit < ${lim} ${unit})`, typeof value === 'number' && value < lim, text);
};
const TIME_SCALE = Number(process.env.BUZZ_TIME_SCALE) || 1; // time bounds x this (run.js: 3 in CI, where runners are slower and shared)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (s) => (s + '0'.repeat(64)).slice(0, 64);
const LONG =
  'Lorem ipsum **dolor** sit amet, `code_name_x` consectetur adipiscing elit. See `pipeline/steps/rollup.py:142` and ABC-4321.\n\n```python\ndef f(x):\n    return x * 2\n```\n' +
  'More text here. '.repeat(8);

// ======================================================================================= controller (child process)
async function controller() {
  const Module = require('module');
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
  // synchronous disk reads made while rendering (config fallbacks): counted, they block the extension host
  let agentsMdReads = 0;
  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = function (p) {
    if (/AGENTS\.md$/i.test(String(p))) agentsMdReads++;
    return origReadFileSync.apply(this, arguments);
  };
  const { ChatController } = require(path.join(PROJ, 'out', 'chat.js'));

  // ---------------------------------------------------------------- dataset: 50 channels, c00 is the big one
  const N_CHANNELS = 50;
  const THREADS = 400;
  const BIG_REPLIES = 1500;
  const TOTAL = 5000;
  const now = Math.floor(Date.now() / 1000);
  const people = Array.from({ length: 12 }, (_, i) => hex('p' + i.toString(16).padStart(2, '0')));
  const ev = (id, ch, ts, content, pk, root) => ({
    id,
    pubkey: pk,
    kind: 9,
    created_at: ts,
    content,
    tags: [['h', ch], ...(root ? [['e', root, '', 'root']] : [])],
  });
  const chId = (i) => 'c' + String(i).padStart(2, '0');
  const BIG = chId(0);
  // fixed-width ids (channel 2 + thread 4 + reply 4 hex digits, reply 0 = the root): zero padding cannot make two collide
  const mkId = (ci, ti, ri) => hex(ci.toString(16).padStart(2, '0') + ti.toString(16).padStart(4, '0') + ri.toString(16).padStart(4, '0'));
  const bigRoot = mkId(0, 0, 0);

  function bigChannel() {
    const evs = [];
    const start = now - 400_000;
    let t = start;
    // thread 0 is the long-lived one: its root first, its 1,500 replies spread over the whole timeline below
    evs.push(ev(mkId(0, 0, 0), BIG, t, `Thread 0 (the long one): ${LONG.slice(0, 160)}`, people[0]));
    t += 300;
    const rest = TOTAL - THREADS - BIG_REPLIES; // replies shared by the other 399 threads
    const base = Math.floor(rest / (THREADS - 1));
    let extra = rest - base * (THREADS - 1);
    for (let i = 1; i < THREADS; i++) {
      const rootId = mkId(0, i, 0);
      evs.push(ev(rootId, BIG, t, `Thread ${i}: ${i % 10 === 0 ? 'alpha ' : ''}${LONG.slice(0, 160)}`, people[i % people.length]));
      const n = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      for (let j = 0; j < n; j++) {
        t += 30;
        evs.push(ev(mkId(0, i, j + 1), BIG, t, (j % 5 === 0 ? 'alpha ' : '') + LONG, people[(i + j) % people.length], rootId));
      }
      t += 300;
    }
    const span = t - start;
    for (let k = 0; k < BIG_REPLIES; k++) {
      const ts = start + 1 + Math.floor((span * (k + 1)) / (BIG_REPLIES + 1));
      evs.push(ev(mkId(0, 0, k + 1), BIG, ts, (k % 10 === 0 ? 'alpha ' : '') + `reply ${k}: ` + LONG, people[k % people.length], bigRoot));
    }
    evs.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
    return evs;
  }
  function smallChannel(ch, i) {
    const evs = [];
    let t = now - 50_000 - i * 100;
    for (let r = 0; r < 12; r++) {
      const rootId = mkId(i, r, 0);
      evs.push(ev(rootId, ch, t, `Thread ${r} of ${ch}: ${LONG.slice(0, 120)}`, people[r % people.length]));
      for (let j = 0; j < 5; j++) {
        t += 30;
        evs.push(ev(mkId(i, r, j + 1), ch, t, LONG, people[(r + j) % people.length], rootId));
      }
      t += 200;
    }
    return evs;
  }
  const data = {};
  const channels = [];
  for (let i = 0; i < N_CHANNELS; i++) {
    const id = chId(i);
    channels.push({ id, name: 'chan-' + id, isDm: false });
    data[id] = i === 0 ? bigChannel() : smallChannel(id, i);
  }
  const allEvents = Object.values(data).flat();
  const byIdAll = new Map(allEvents.map((e) => [e.id, e]));
  const rootOf = (e) => (e.tags.find((t) => t[3] === 'root') || [])[1];
  const bigThreadCount = data[BIG].filter((e) => rootOf(e) === bigRoot).length;
  console.log(
    `dataset: ${N_CHANNELS} channels; ${BIG}: ${data[BIG].length} messages / ${THREADS} threads, thread ${bigRoot.slice(0, 6)} has ${bigThreadCount} replies; others: ${data[chId(1)].length} messages each`,
  );
  ok(
    'dataset is 5,000 messages / 400 threads / 1,500-reply thread, ids unique',
    data[BIG].length === TOTAL &&
      new Set(data[BIG].filter((e) => !rootOf(e)).map((e) => e.id)).size === THREADS &&
      bigThreadCount === BIG_REPLIES &&
      byIdAll.size === allEvents.length,
    { n: data[BIG].length, big: bigThreadCount, ids: byIdAll.size, evs: allEvents.length },
  );

  // ---------------------------------------------------------------- fakes
  const PAGE = 100;
  const THREAD_PAGE = 500;
  const calls = { messages: 0, thread: 0, fetch: 0, search: 0 };
  const client = {
    myPubkey: hex('ff'),
    me: async () => ({}),
    channels: async () => channels,
    allChannels: async () => channels,
    dms: async () => [],
    async messages(ch, o = {}) {
      calls.messages++;
      let evs = data[ch] || [];
      if (o.before) evs = evs.filter((e) => e.created_at < o.before);
      if (o.since) evs = evs.filter((e) => e.created_at >= o.since);
      return evs.slice(-(o.limit || PAGE));
    },
    async thread(ch, id) {
      calls.thread++;
      const hit = byIdAll.get(id);
      if (!hit) return [];
      const root = rootOf(hit) || hit.id;
      const all = (data[ch] || []).filter((e) => e.id === root || rootOf(e) === root);
      return all.slice(-THREAD_PAGE); // like the CLI: the newest THREAD_PAGE messages of the thread
    },
    async search(q, limit) {
      calls.search++;
      return allEvents.filter((e) => e.content.includes(q)).slice(-limit);
    },
    send: async () => ({ event_id: hex('s'), accepted: true }),
    members: async () => people.map((pk) => ({ pubkey: pk, name: 'agent_' + pk.slice(0, 3), isAgent: true })),
    presence: async () => ({}),
    nameOf: (pk) => (pk === hex('ff') ? 'me' : 'agent_' + pk.slice(0, 3)),
    isAgent: (pk) => pk !== hex('ff'),
    ensureProfiles: async () => undefined,
  };
  let onLive;
  const fetchLog = [];
  const live = {
    onEvent: (cb) => ((onLive = cb), disp),
    onState: () => disp,
    subscribe: noop,
    unsubscribe: noop,
    state: { state: 'live' },
    isLive: true,
    out: { appendLine: noop },
    publish: noop,
    async fetch(filters) {
      calls.fetch++;
      const f = filters[0];
      fetchLog.push(f);
      if (f.search) {
        // Buzz's search over the live connection: the newest matches, relevance order is not simulated
        let pool = f['#h'] ? allEvents.filter((e) => f['#h'].includes(e.tags[0][1])) : allEvents;
        const hits = pool.filter((e) => e.content.includes(f.search)).sort((a, b) => b.created_at - a.created_at);
        return { events: hits.slice(0, f.limit || 300), complete: true, reason: 'eose' };
      }
      if (f.ids) return { events: f.ids.map((id) => byIdAll.get(id)).filter(Boolean), complete: true, reason: 'eose' };
      if (f['#e']) {
        const root = f['#e'][0];
        const pool = (data[f['#h'][0]] || []).filter((e) => rootOf(e) === root && (f.until === undefined || e.created_at <= f.until));
        pool.sort((a, b) => b.created_at - a.created_at);
        return { events: pool.slice(0, f.limit || THREAD_PAGE), complete: true, reason: 'eose' };
      }
      if (f['#h']) {
        const pool = (data[f['#h'][0]] || []).filter((e) => f.until === undefined || e.created_at <= f.until);
        pool.sort((a, b) => b.created_at - a.created_at);
        return { events: pool.slice(0, f.limit || 200), complete: true, reason: 'eose' };
      }
      return undefined;
    },
  };
  const state = { 'buzz.lastChannel': chId(1) }; // the session starts on a small channel; the big one is selected explicitly
  const ext = {
    workspaceState: { get: (k) => state['ws:' + k], update: async (k, v) => void (state['ws:' + k] = v) },
    globalState: { get: (k) => state[k], update: async (k, v) => void (state[k] = v) },
    extensionUri: { toString: () => '' },
  };

  const posted = [];
  const stamps = []; // [type, performance.now()] of every post, so timings do not depend on polling
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
        posted.push(m);
        stamps.push([m.type, performance.now(), m]);
      },
    },
    isVisible: () => true,
    onVisibility: () => disp,
    onDispose: () => disp,
    reveal: noop,
  });
  const mb = (b) => b / 1024 / 1024;
  const heap = () => {
    global.gc();
    global.gc();
    return process.memoryUsage().heapUsed;
  };
  const settle = async (n = 12) => {
    for (let i = 0; i < n; i++) await sleep(25);
  };
  const lastOf = (type) => [...posted].reverse().find((m) => m.type === type);

  // ---------------------------------------------------------------- ready on the small channel
  await onMsg({ type: 'ready' });
  await settle();
  const chs = lastOf('channels');
  ok(
    'ready: the channel list carries 50 channels',
    chs && chs.ready && chs.items.length === N_CHANNELS,
    chs && { ready: chs.ready, n: chs.items && chs.items.length },
  );
  ok(
    'ready: the last channel (a small one) opened',
    c.current && c.current.id === chId(1) && lastOf('threads') && lastOf('threads').channelId === chId(1),
    c.current && c.current.id,
  );
  const h0 = heap();

  // ---------------------------------------------------------------- select the big channel: first list, the fill
  posted.length = 0;
  stamps.length = 0;
  const tSel = performance.now();
  await onMsg({ type: 'select', id: BIG });
  const firstList = stamps.find((s) => s[0] === 'threads');
  await settle(20); // the fill: older pages until 30 threads show, then the first messages by id
  let guard = 0;
  while (guard++ < 40 && stamps.length && performance.now() - stamps[stamps.length - 1][1] < 150) await sleep(50); // wait until posts stop
  const listPosts = posted.filter((m) => m.type === 'threads');
  const finalList = listPosts[listPosts.length - 1];
  metric('select -> first threads post', firstList ? firstList[1] - tSel : NaN, 'ms');
  ok(
    'select: the first list is marked initial and belongs to the big channel',
    firstList && firstList[2].initial === true && firstList[2].channelId === BIG,
    firstList && firstList[2],
  );
  metric('threads posts during the fill', listPosts.length, 'posts');
  metric('threads shown after the fill', finalList ? finalList.items.length : 0, 'threads');
  ok('fill: at least 30 threads show (MIN_THREADS) after the fill', finalList && finalList.items.length >= 30, finalList && finalList.items.length);
  const noRoot = finalList ? finalList.items.filter((t) => /older|eski/i.test(t.snippet)).length : -1;
  metric('threads still without their first message after the fill', noRoot, 'threads');
  console.log(`  calls so far: messages ${calls.messages}, thread ${calls.thread}, live fetch ${calls.fetch}; byId ${c.byId.size}`);

  // ---------------------------------------------------------------- open the 1,500-reply thread
  posted.length = 0;
  stamps.length = 0;
  agentsMdReads = 0;
  const tOpen = performance.now();
  await onMsg({ type: 'openThread', id: bigRoot });
  await settle(8);
  const full = stamps.find((s) => s[0] === 'thread' && s[2].id === bigRoot && s[2].items.filter((x) => !x.isRoot).length >= BIG_REPLIES);
  const threadPosts = posted.filter((m) => m.type === 'thread');
  const lastThread = threadPosts[threadPosts.length - 1];
  metric('open the 1,500-reply thread -> thread post with all replies', full ? full[1] - tOpen : NaN, 'ms');
  ok(
    'the big thread arrives with all 1,500 replies and its first message',
    !!full && full[2].items.some((x) => x.isRoot) && full[2].items.length === BIG_REPLIES + 1,
    {
      posts: threadPosts.map((m) => m.items.length),
      root: lastThread && lastThread.items.some((x) => x.isRoot),
      partial: lastThread && lastThread.partial,
    },
  );
  ok(
    'the big thread is not marked partial (every page over the live connection was complete)',
    lastThread && !lastThread.partial,
    lastThread && { partial: lastThread.partial },
  );
  ok(
    'every message of the big thread carries rendered html',
    !!full && full[2].items.every((x) => typeof x.html === 'string' && x.html.length > 0),
    full && full[2].items.filter((x) => !x.html).length,
  );
  console.log(`  thread reads: CLI ${calls.thread}, live #e pages ${fetchLog.filter((f) => f['#e']).length}`);
  metric('synchronous reads of ~/.buzz/AGENTS.md while opening that thread', agentsMdReads, 'reads');
  ok('opening a thread does not read a config file from disk once per message (relayUrl() behind imageHost())', agentsMdReads <= 1, {
    reads: agentsMdReads,
    messages: BIG_REPLIES + 1,
  });
  const firstThreadPost = stamps.find((s) => s[0] === 'thread' && s[2].id === bigRoot);
  metric('open the big thread -> first (partial) thread post', firstThreadPost ? firstThreadPost[1] - tOpen : NaN, 'ms');
  metric('items in that first (partial) post', firstThreadPost ? firstThreadPost[2].items.length : -1, 'items');
  {
    // the render of the thread without its cache (what the full post cost): group + order + 1,501 items
    c.renderer.clear();
    const tR = performance.now();
    c.postThread();
    metric('postThread() with an empty render cache (1,501 items: markdown, blocks, snippets)', performance.now() - tR, 'ms');
    // the pieces of that: grouping, ordering, and the renderer alone
    const tG = performance.now();
    const g = c.group(bigRoot);
    metric('  group(): groupThreads over byId', performance.now() - tG, 'ms');
    const tE = performance.now();
    const entries = c.threadEntries();
    metric('  threadEntries(): group() again + threadOrder', performance.now() - tE, 'ms');
    c.renderer.clear();
    const tI = performance.now();
    for (const x of entries) c.item(x.ev, x);
    metric('  renderer.item() over the entries, empty cache', performance.now() - tI, 'ms');
    const tI2 = performance.now();
    for (const x of entries) c.item(x.ev, x);
    metric('  renderer.item() over the entries, cached', performance.now() - tI2, 'ms');
    const tW = performance.now();
    c.postWorking();
    metric('  postWorking()', performance.now() - tW, 'ms');
    void g;
  }
  {
    // where that time goes: markdown-it over the same 1,501 contents, outside the controller
    const { renderMarkdown } = require(path.join(PROJ, 'out', 'markdown.js'));
    const contents = data[BIG].filter((e) => e.id === bigRoot || rootOf(e) === bigRoot).map((e) => e.content);
    const tMd = performance.now();
    let n = 0;
    for (const t of contents) n += renderMarkdown(t, {}).length;
    metric('renderMarkdown alone over the 1,501 contents of that thread', performance.now() - tMd, 'ms');
    void n;
  }

  // ---------------------------------------------------------------- load everything
  posted.length = 0;
  guard = 0;
  const tAll = performance.now();
  while (!posted.some((m) => m.type === 'olderDone') && guard++ < 80) await onMsg({ type: 'older' });
  await settle(8);
  metric('load all pages (older until olderDone)', performance.now() - tAll, 'ms');
  ok('older: olderDone arrives and every message of the channel is loaded', posted.some((m) => m.type === 'olderDone') && c.byId.size === TOTAL, {
    olderDone: posted.some((m) => m.type === 'olderDone'),
    byId: c.byId.size,
    clicks: guard,
  });
  const listAll = lastOf('threads');
  ok('the list shows all 400 threads once everything is loaded', listAll && listAll.items.length === THREADS, listAll && listAll.items.length);
  const hAll = heap();
  metric('heap with everything loaded (over the baseline)', mb(hAll - h0), 'MB');

  // ---------------------------------------------------------------- live messages: list rebuild with 5,000 loaded
  // the open thread is the big one; the live replies go to another thread, so the rebuild is the list (plus the
  // 'elsewhere' notice), not a thread append
  posted.length = 0;
  stamps.length = 0;
  const LIVE_BATCH_MS = 120;
  const liveTimes = [];
  const target = mkId(0, 5, 0);
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    onLive(c.subId, ev(mkId(0xee, 0, i + 1), BIG, now + i, 'live ' + LONG, people[1], target));
    await sleep(LIVE_BATCH_MS + 150);
    const s = stamps.find((x) => x[0] === 'threads' && x[1] > t0);
    liveTimes.push(s ? s[1] - t0 - LIVE_BATCH_MS : NaN);
    stamps.length = 0;
  }
  const liveListPosts = posted.filter((m) => m.type === 'threads').length;
  const avgLive = liveTimes.reduce((a, b) => a + b, 0) / liveTimes.length;
  const maxLive = Math.max(...liveTimes);
  ok('every live message produced one list rebuild', liveListPosts === 20 && liveTimes.every((x) => !isNaN(x)), {
    posts: liveListPosts,
    times: liveTimes.map((x) => x.toFixed(0)),
  });
  metric('per-live-message list rebuild (avg, 5,020 loaded)', Math.max(0, avgLive), 'ms', 100);
  metric('per-live-message list rebuild (max)', Math.max(0, maxLive), 'ms');
  const tDirect = performance.now();
  c.postThreads();
  metric('postThreads() alone (group 5,020 messages into 400 rows)', performance.now() - tDirect, 'ms');
  const tGroup = performance.now();
  c.postThread();
  metric('postThread() alone (the open 1,501-message thread, cached html)', performance.now() - tGroup, 'ms');

  // ---------------------------------------------------------------- search answered from the live connection: 300 matches
  posted.length = 0;
  stamps.length = 0;
  const tSearch = performance.now();
  await onMsg({ type: 'search', query: 'alpha', scope: 'channel' });
  await settle(4);
  const sr = stamps.find((s) => s[0] === 'searchResults');
  const srMsg = sr && sr[2];
  const sf = fetchLog.filter((f) => f.search);
  metric('search (300 live matches) -> searchResults', sr ? sr[1] - tSearch : NaN, 'ms', 300);
  ok(
    'search went over the live connection with the 300 cap and this channel',
    sf.length === 1 && sf[0].limit === 300 && JSON.stringify(sf[0]['#h']) === JSON.stringify([BIG]) && calls.search === 0,
    { live: sf, cli: calls.search },
  );
  ok(
    'searchResults: grouped by thread, newest first, reported as capped at 300',
    srMsg &&
      !srMsg.error &&
      srMsg.capped === true &&
      srMsg.cap === 300 &&
      srMsg.items.length > 0 &&
      srMsg.items.length <= 300 &&
      srMsg.items.every((r, i, a) => i === 0 || a[i - 1].ts >= r.ts) &&
      srMsg.items.reduce((a, r) => a + r.matches, 0) === 300,
    srMsg && { error: srMsg.error, capped: srMsg.capped, n: srMsg.items.length, sum: srMsg.items.reduce((a, r) => a + r.matches, 0) },
  );

  // ---------------------------------------------------------------- 30 channel switches: memory must come back
  await onMsg({ type: 'select', id: chId(1) });
  await settle();
  const hA = heap();
  const tSw = performance.now();
  for (let i = 1; i <= 30; i++) {
    const id = i === 30 ? chId(1) : i % 6 === 0 ? BIG : chId(2 + (i % 47));
    await onMsg({ type: 'select', id });
    await settle(id === BIG ? 16 : 8);
  }
  const swMs = performance.now() - tSw;
  const hB = heap();
  metric('30 channel switches (5 of them to the big channel), wall time', swMs, 'ms');
  metric('heap growth over 30 channel switches', mb(hB - hA), 'MB', 8);
  ok(
    'after the switches the small channel is on screen with its own list',
    c.current && c.current.id === chId(1) && lastOf('threads').channelId === chId(1) && c.byId.size === data[chId(1)].length,
    { cur: c.current && c.current.id, byId: c.byId.size },
  );
  metric('heap at the end (over the baseline)', mb(hB - h0), 'MB');
  console.log(`  calls total: messages ${calls.messages}, thread ${calls.thread}, live fetch ${calls.fetch}, cli search ${calls.search}`);

  c.dispose();
  await sleep(50);
  ok('controller: no unhandled rejections or uncaught exceptions', !unexpected.length, unexpected);
  console.log('METRICS ' + JSON.stringify(metrics));
  console.log(`CONTROLLER ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ======================================================================================= webview (parent process)
async function webview() {
  const puppeteer = require('puppeteer-core');
  const i18n = require(path.join(PROJ, 'out/i18n.js'));
  i18n.setLang('en');
  const S = i18n.webviewStrings();
  const { renderMarkdown } = require(path.join(PROJ, 'out/markdown.js'));
  const tpl = /return `(<!DOCTYPE html>[\s\S]*?<\/html>)`;/.exec(fs.readFileSync(path.join(PROJ, 'src/chatHtml.ts'), 'utf8'))[1];
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const tx = (k) => `data-i18n="${k}">${esc(S[k] ?? k)}`;
  const ti = (k) => `data-i18n-title="${k}" title="${esc(S[k] ?? k)}"`;
  const page0 = new Function('s', 'esc', 'tx', 'ti', 'cur', 'n', 'css', 'js', 'img', 'w', 'return `' + tpl + '`;')(S, esc, tx, ti, 'en', 'x', '', '', '', {
    cspSource: '',
  });
  const body = /<body class="app">\n([\s\S]*?)<script nonce=/.exec(page0)[1];
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fs.readFileSync(path.join(PROJ, 'media/chat.css'), 'utf8')}</style>
<script>window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(m),getState:()=>({}),setState:()=>{}});</script>
</head><body class="app">${body}<script>${fs.readFileSync(path.join(PROJ, 'media/chat.js'), 'utf8')}</script></body></html>`;
  const file = path.join(require('os').tmpdir(), 'stress_scale.html');
  fs.writeFileSync(file, html);

  const htmlOf = renderMarkdown(LONG, { jiraUrl: 'https://jira.example', jiraKeys: ['ABC'] });
  const htmlAlpha = renderMarkdown('alpha ' + LONG, { jiraUrl: 'https://jira.example', jiraKeys: ['ABC'] });
  const thread = (i) => ({
    id: 't' + i,
    pubkey: 'p' + (i % 9),
    author: 'agent_' + (i % 9),
    initials: 'A' + (i % 9),
    isAgent: true,
    isMe: false,
    snippet: 'Thread ' + i + ' ' + LONG.slice(0, 120),
    replies: 6,
    lastAuthor: 'agent_1',
    people: [1, 2, 3].map((k) => ({ pubkey: 'p' + k, initials: 'A' + k, isAgent: true, name: 'agent_' + k })),
    time: '10:00',
    ts: 1_000_000 - i,
  });
  const item = (i) => ({
    id: 'm' + i,
    pubkey: 'p' + (i % 9),
    author: 'agent_' + (i % 9),
    initials: 'A',
    isMe: i % 7 === 0,
    isAgent: true,
    isRoot: i === 0,
    time: '10:00',
    ts: 1_700_000_000 + i * 60,
    html: i % 10 === 0 ? htmlAlpha : htmlOf,
    patches: [],
    depth: i % 5 === 0 ? 1 : 0,
    parentId: i % 5 === 0 ? 'm' + (i - 1) : undefined,
    parentAuthor: i % 5 === 0 ? 'agent_1' : undefined,
    snippet: 'x',
  });
  const threads = Array.from({ length: 500 }, (_, i) => thread(i));
  const items = Array.from({ length: 1500 }, (_, i) => item(i));
  const alphaCount = items.filter((_, i) => i % 10 === 0).length;

  const browser = await puppeteer.launch(require('./browser').launchOptions(['--js-flags=--expose-gc']));
  try {
    const pg = await browser.newPage();
    const errors = [];
    pg.on('pageerror', (e) => errors.push(e.message));
    await pg.setViewport({ width: 1200, height: 800 });
    await pg.goto('file:///' + file.split(path.sep).join('/'));
    const send = (m) => pg.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), m);
    const timed = (m) =>
      pg.evaluate((m) => {
        const t0 = performance.now();
        window.dispatchEvent(new MessageEvent('message', { data: m }));
        return performance.now() - t0;
      }, m);
    const ev = (fn, ...a) => pg.evaluate(fn, ...a);
    const heap = async () => {
      await ev(() => window.gc && window.gc());
      await sleep(50);
      await ev(() => window.gc && window.gc());
      return (await pg.metrics()).JSHeapUsedSize / 1024 / 1024;
    };
    await send({ type: 'i18n', lang: 'en', strings: S });
    await send({ type: 'host', kind: 'panel' });
    await send({ type: 'channels', ready: true, items: [{ id: 'A', name: 'a', isDm: false, color: 1 }] });
    await send({ type: 'channel', id: 'A', name: 'a', isDm: false, color: 1 });
    const h0 = await heap();

    await ev((threads) => void (window.__threads = threads), threads);
    // the first list of the channel: timed in the page, with a MutationObserver counting rows built and thrown away
    const first = await ev(() => {
      const list = document.getElementById('threadList');
      const mo = new MutationObserver(() => undefined);
      mo.observe(list, { childList: true });
      const t0 = performance.now();
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'threads', channelId: 'A', items: window.__threads, initial: true } }));
      const ms = performance.now() - t0;
      const recs = mo.takeRecords();
      mo.disconnect();
      let added = 0;
      let removed = 0;
      for (const r of recs) {
        added += [...r.addedNodes].filter((n) => n.classList && n.classList.contains('titem')).length;
        removed += [...r.removedNodes].filter((n) => n.classList && n.classList.contains('titem')).length;
      }
      return { ms, added, removed, posted: window.__posted.map((m) => m.type) };
    });
    metric('webview: threads list of 500 rows, first render', first.ms, 'ms', 750);
    metric('webview: rows built during the first threads message', first.added, 'rows');
    metric('webview: rows built and thrown away during the first threads message', first.removed, 'rows');
    ok('webview: the first list of a channel is built once (no rows thrown away before the first paint)', first.removed === 0, first);
    ok(
      'webview: 500 rows are in the list and the first thread was opened',
      (await ev(() => document.querySelectorAll('#threadList .titem').length)) === 500 && first.posted.includes('openThread'),
      first,
    );
    const reruns = await ev(() => {
      const out = [];
      for (let k = 0; k < 5; k++) {
        const t0 = performance.now();
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'threads', channelId: 'A', items: window.__threads } }));
        out.push(performance.now() - t0);
      }
      return out.sort((a, b) => a - b);
    });
    metric('webview: threads list of 500 rows, re-render (median of 5)', reruns[2], 'ms', 750);
    metric('webview: first render / median re-render', first.ms / reruns[2], 'x');

    await ev(() => document.querySelector('#threadList .titem').click()); // openThread(t0): the page asks the extension
    const tThread = await timed({ type: 'thread', id: 't0', title: 'Thread 0', items });
    metric('webview: thread of 1,500 messages with markdown html, render', tThread, 'ms', 3000);
    const nMsg = await ev(() => document.querySelectorAll('#log .msg').length);
    ok('webview: 1,500 messages are in the thread', nMsg === 1500, nMsg);
    const nodes1 = await ev(() => document.getElementsByTagName('*').length);
    metric('webview: DOM nodes with the list and the thread on screen', nodes1, 'nodes');

    // the filter: 'alpha' typed over 1,500 messages, measured per keystroke in the page (what one keystroke costs)
    await ev(() => document.getElementById('filterBtn').click());
    ok('webview: the filter row opens', !(await ev(() => document.getElementById('filterRow').hidden)));
    const keys = await ev(() => {
      const box = document.getElementById('filterBox');
      const out = [];
      let v = '';
      for (const ch of 'alpha') {
        v += ch;
        box.value = v;
        const t0 = performance.now();
        box.dispatchEvent(new Event('input', { bubbles: true }));
        out.push(performance.now() - t0);
      }
      return out;
    });
    const fst = await ev(() => ({
      shown: [...document.querySelectorAll('#log .msg')].filter((m) => !m.classList.contains('filtered-out')).length,
      count: document.getElementById('filterCount').textContent,
    }));
    metric("webview: filter typing 'alpha' over 1,500 messages, slowest keystroke", Math.max(...keys), 'ms', 150);
    metric(
      "webview: filter typing 'alpha', all five keystrokes",
      keys.reduce((a, b) => a + b, 0),
      'ms',
    );
    ok(`webview: the filter shows the ${alphaCount} matching messages with a count`, fst.shown === alphaCount && fst.count === `${alphaCount} of 1500`, fst);
    await ev(() => {
      const box = document.getElementById('filterBox');
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    ok(
      'webview: Escape clears the filter',
      (await ev(() => document.querySelectorAll('#log .msg.filtered-out').length)) === 0 && (await ev(() => document.getElementById('filterRow').hidden)),
    );

    // 40 list + 40 thread re-renders, driven from inside the page (the data is sent once): memory must come back
    await ev((items) => void (window.__items = items), items);
    const h1 = await heap();
    const re = await ev(async () => {
      const out = { list: [], thread: [] };
      const tick = () => new Promise((r) => setTimeout(r, 0));
      for (let i = 0; i < 40; i++) {
        let t0 = performance.now();
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'threads', channelId: 'A', items: window.__threads } }));
        out.list.push(performance.now() - t0);
        await tick();
        t0 = performance.now();
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'thread', id: 't' + (i % 3), title: 'x', items: window.__items } }));
        out.thread.push(performance.now() - t0);
        await tick();
      }
      return out;
    });
    await ev(() => void (delete window.__threads, delete window.__items));
    const h2 = await heap();
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    metric('webview: list re-render of 500 rows, avg of 40', avg(re.list), 'ms', 750);
    metric('webview: thread re-render of 1,500 messages, avg of 40', avg(re.thread), 'ms', 3000);
    metric('webview: thread re-render of 1,500 messages, max of 40', Math.max(...re.thread), 'ms');
    metric('webview: heap growth over 40 list + 40 thread re-renders', h2 - h1, 'MB', 10);
    metric('webview: heap empty -> rendered', h1 - h0, 'MB');
    const nodes2 = await ev(() => document.getElementsByTagName('*').length);
    metric('webview: DOM nodes after the re-renders', nodes2, 'nodes');
    ok('webview: the DOM does not accumulate across re-renders', Math.abs(nodes2 - nodes1) <= 50, { before: nodes1, after: nodes2 });
    const tAppend = await timed({ type: 'threadAppend', id: 't0', items: [item(1500)] });
    metric('webview: append one message to the 1,500-message thread', tAppend, 'ms');
    ok('webview: no script errors', !errors.length, errors);
  } finally {
    await browser.close();
  }
}

// ======================================================================================= main
function runController() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--expose-gc', __filename, PROJ, '--controller-child'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let childMetrics = [];
    let counts;
    const killer = setTimeout(() => {
      console.log('FAIL controller child did not finish within 150 s');
      fail++;
      child.kill();
    }, 150_000);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.startsWith('METRICS ')) childMetrics = JSON.parse(line.slice(8));
        else if (line.startsWith('CONTROLLER ')) counts = /(\d+) passed, (\d+) failed/.exec(line);
        else console.log(line);
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => {
      clearTimeout(killer);
      if (buf.trim()) console.log(buf);
      if (counts) {
        pass += Number(counts[1]);
        fail += Number(counts[2]);
      } else {
        fail++;
        console.log(`FAIL controller child ended without a summary (exit ${code})`);
      }
      metrics.push(...childMetrics);
      resolve();
    });
  });
}

(async () => {
  if (CHILD) return controller();
  console.log('== controller (node --expose-gc) ==');
  await runController();
  console.log('\n== webview (headless Chrome) ==');
  await webview();
  ok('harness: no unhandled rejections or uncaught exceptions', !unexpected.length, unexpected);
  console.log('\n== metrics ==');
  const w = Math.max(...metrics.map((m) => m.name.length));
  for (const m of metrics) {
    const v = typeof m.value === 'number' ? (Number.isInteger(m.value) ? String(m.value) : m.value.toFixed(1)) : String(m.value);
    const lim = m.limit === undefined ? '' : `  (limit < ${m.limit})`;
    const verdict = m.limit === undefined ? '' : typeof m.value === 'number' && m.value < m.limit ? '  ok' : '  MISSED';
    console.log(`${m.name.padEnd(w)}  ${v.padStart(8)} ${m.unit}${lim}${verdict}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
