// Stress scenario "first_run": a first-time installer on a machine where things are missing or broken.
// Real ChatController (out/chat.js) with a fake vscode module, a fake Buzz client whose failures are the real
// error classes (SetupError, BuzzError from out/core.js), a fake live manager and a fake webview that records
// what the extension posts. Also exercises out/agentGit.js without git and out/core.js desktopCandidates.
//
//   node test/harness/stress_first_run.js
const Module = require('module');
const path = require('path');
const { execFile } = require('child_process');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');
if (!PROJ) {
  console.error('usage: node stress_first_run.js <repo path>');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const ok = (name, cond, info) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info === undefined ? null : info).slice(0, 400)));
};
const unexpected = [];
process.on('unhandledRejection', (e) => unexpected.push('unhandledRejection: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))));
process.on('uncaughtException', (e) => unexpected.push('uncaughtException: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))));

// ------------------------------------------------------------------ fake vscode
const noop = () => undefined;
const disp = { dispose: noop };
const executed = [];
const fakeVscode = {
  workspace: {
    getConfiguration: () => ({ get: (_k, d) => d }),
    onDidChangeConfiguration: () => disp,
    asRelativePath: (u) => String(u),
    workspaceFolders: undefined, // a first run: no folder open
    findFiles: async () => [],
    fs: {
      stat: async () => {
        throw new Error('ENOENT');
      },
    },
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    showInformationMessage: noop,
    showErrorMessage: noop,
    showWarningMessage: noop,
    showQuickPick: async () => undefined,
    withProgress: async (_o, fn) => fn(),
    createOutputChannel: () => ({ appendLine: noop }),
  },
  commands: {
    executeCommand: async (cmd, ...args) => {
      executed.push([cmd, ...args]);
      return undefined;
    },
    registerCommand: () => disp,
  },
  Uri: { joinPath: (...a) => ({ toString: () => a.join('/'), fsPath: a.join('/') }), file: (p) => ({ fsPath: p }), parse: (s) => ({ toString: () => s }) },
  EventEmitter: class {
    constructor() {
      this.event = () => disp;
    }
    fire() {}
    dispose() {}
  },
  env: { language: 'en', openExternal: noop, clipboard: { writeText: async () => undefined } },
  ViewColumn: { Active: -1, Beside: -2 },
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
const { BuzzError, SetupError, CliExit, desktopCandidates } = require(path.join(PROJ, 'out', 'core.js'));
const { t } = require(path.join(PROJ, 'out', 'i18n.js'));
const agentGit = require(path.join(PROJ, 'out', 'agentGit.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (s) => (s + '0'.repeat(64)).slice(0, 64);
const ME = hex('ff');
const AG = hex('a1');
const AG2 = hex('a2');
const ev = (id, ch, ts, content, root, pk = AG) => ({
  id: hex(id),
  pubkey: pk,
  kind: 9,
  created_at: ts,
  content,
  tags: [['h', ch], ...(root ? [['e', hex(root), '', 'root']] : [])],
});
const now = Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ a configurable fake client
// mode: 'setup' (every call rejects with SetupError), 'auth' (BuzzError 3), 'network' (BuzzError 2), 'ok'
function makeClient(opts = {}) {
  const st = {
    mode: opts.mode || 'ok',
    calls: {},
    channels: opts.channels || [{ id: 'A', name: 'general', isDm: false }],
    pages: opts.pages || {},
    members: opts.members || {},
    presence: opts.presence || {},
    membersReject: false,
    presenceReject: false,
  };
  const fails = () => {
    if (st.mode === 'setup') return new SetupError('Buzz CLI not found. Run "Buzz: Setup" to install it.');
    if (st.mode === 'auth') return new BuzzError(CliExit.Auth, 'auth', 'relay refused the key');
    if (st.mode === 'network') return new BuzzError(CliExit.Network, 'network', 'connect ECONNREFUSED 127.0.0.1:7777');
    return undefined;
  };
  const count = (name) => (st.calls[name] = (st.calls[name] || 0) + 1);
  const gate = async (name) => {
    count(name);
    const e = fails();
    if (e) throw e;
  };
  const client = {
    get myPubkey() {
      return st.mode === 'ok' && st.me ? ME : undefined;
    },
    async me() {
      await gate('me');
      st.me = true;
      return { pubkey: ME, name: 'me' };
    },
    async channels() {
      await gate('channels');
      return st.channels.slice();
    },
    async allChannels() {
      await gate('allChannels');
      return st.channels.slice();
    },
    async dms() {
      await gate('dms');
      return [];
    },
    async messages(ch, o) {
      await gate('messages');
      const page = (st.pages[ch] || []).slice();
      if (o && o.before) return page.filter((e) => e.created_at < o.before);
      if (o && o.since) return page.filter((e) => e.created_at >= o.since);
      return page;
    },
    async thread(ch, id) {
      await gate('thread');
      const all = st.pages[ch] || [];
      const rootOf = (e) => (e.tags.find((x) => x[3] === 'root') || [])[1] || e.id;
      const hit = all.find((e) => e.id === id);
      return hit ? all.filter((e) => rootOf(e) === rootOf(hit)) : [];
    },
    async send() {
      await gate('send');
      return { event_id: hex('s1'), accepted: true };
    },
    async members(ch) {
      count('members');
      if (st.membersReject) throw new BuzzError(CliExit.Network, 'network', 'members: timeout');
      const e = fails();
      if (e) throw e;
      return (st.members[ch] || []).slice();
    },
    async presence() {
      count('presence');
      if (st.presenceReject) throw new BuzzError(CliExit.Network, 'network', 'presence: timeout');
      const e = fails();
      if (e) throw e;
      return { ...st.presence };
    },
    nameOf: (pk) => (pk === ME ? 'me' : pk === AG ? 'lead_agent' : pk === AG2 ? 'qa_agent' : pk.slice(0, 6)),
    isAgent: (pk) => pk === AG || pk === AG2,
    async ensureProfiles() {
      await gate('ensureProfiles');
    },
    async search() {
      await gate('search');
      return [];
    },
  };
  return { client, st };
}

function makeLive() {
  const subs = {};
  const live = {
    onEvent: () => disp,
    onState: () => disp,
    subscribe: (id, f) => (subs[id] = f),
    unsubscribe: (id) => delete subs[id],
    state: { state: 'offline', detail: 'no relay' },
    isLive: false,
    publish: noop,
    fetch: async () => undefined,
    out: { appendLine: noop },
  };
  return { live, subs };
}

// the shape of AgentRepos when ~/.buzz/REPOS is missing: nothing available, resolve() finds nothing
const NO_REPOS = { available: false, resolve: async () => [] };

function makeController(client, live, repos = NO_REPOS) {
  const ext = {
    workspaceState: { get: () => undefined, update: async () => undefined },
    globalState: { get: () => undefined, update: async () => undefined },
    extensionUri: { toString: () => '' },
  };
  const posted = [];
  let onMsg;
  const c = new ChatController(ext, client, live, {}, {}, repos);
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
    close: noop,
  });
  return { c, posted, send: (m) => onMsg(m) };
}
const types = (msgs) => msgs.map((m) => m.type);
const lastOf = (msgs, type) => [...msgs].reverse().find((m) => m.type === type);
const errorish = (msgs) => msgs.filter((m) => m.type === 'error' || m.type === 'toast' || (m.type === 'status' && m.text));
const totalCalls = (st) => Object.values(st.calls).reduce((a, b) => a + b, 0);

// ------------------------------------------------------------------ scenarios
async function scenarioSetupError() {
  console.log('\n# 1. nothing set up: the client throws SetupError');
  const { client, st } = makeClient({ mode: 'setup' });
  const { live, subs } = makeLive();
  const h = makeController(client, live);
  await h.send({ type: 'ready' });
  await sleep(300);
  const chans = h.posted.filter((m) => m.type === 'channels');
  ok('S1 exactly one "channels" message after ready', chans.length === 1, chans);
  const m = chans[0];
  ok('S1 channels.ready === false', m && m.ready === false, m);
  ok('S1 channels.setup === true (SetupError)', m && m.setup === true, m);
  ok('S1 channels.error carries the SetupError text', m && typeof m.error === 'string' && /Buzz CLI not found/.test(m.error), m);
  const errs = errorish(h.posted);
  ok('S1 no error storm: at most one error/toast/status post', errs.length <= 1, errs);
  ok('S1 no duplicate "error" toast beside the setup card (same text twice)', !errs.some((e) => e.type === 'error' && e.message === m.error), errs);
  ok('S1 no "threads" / "channel" posted without channels', !h.posted.some((x) => x.type === 'threads' || x.type === 'channel'), types(h.posted));
  ok('S1 no live subscriptions were made', Object.keys(subs).length === 0, Object.keys(subs));
  const before = totalCalls(st);
  const callsBefore = { ...st.calls };
  await sleep(5000);
  const after = totalCalls(st);
  ok('S1 polling does not spin: no client calls over 5 s', after === before, { before: callsBefore, after: st.calls });
  ok('S1 the first attempt made only a few client calls', before <= 3, st.calls);
  // the user clicks "Start setup": the command runs, nothing else
  h.posted.length = 0;
  await h.send({ type: 'setup' });
  await sleep(50);
  ok(
    'S1 "Start setup" runs buzz.setup',
    executed.some((x) => x[0] === 'buzz.setup'),
    executed.map((x) => x[0]),
  );
  // a stray 'select' / 'older' / 'search' while nothing is set up must not crash
  await h.send({ type: 'select', id: 'A' });
  await h.send({ type: 'older' });
  await h.send({ type: 'search', query: 'hello', scope: 'all' });
  await h.send({ type: 'send', text: 'hello', mentions: [], thread: null });
  await sleep(300);
  const sr = lastOf(h.posted, 'searchResults');
  ok('S1 search with nothing set up answers (with an error text), does not hang', sr && sr.items.length === 0 && typeof sr.error === 'string', sr);
  ok(
    'S1 send with nothing set up: composer unlocked, an error',
    lastOf(h.posted, 'sending') && lastOf(h.posted, 'sending').on === false && h.posted.some((x) => x.type === 'error'),
    types(h.posted),
  );
  const chans2 = h.posted.filter((m) => m.type === 'channels');
  ok(
    'S1 "select" while not set up re-reads channels once and reports setup again, no crash',
    chans2.every((x) => x.ready === false && x.setup === true) && chans2.length <= 2,
    chans2,
  );
  h.c.dispose();
}

async function scenarioAuthAndNetwork() {
  console.log('\n# 2. auth failure (code 3) and network failure (code 2)');
  {
    const { client } = makeClient({ mode: 'auth' });
    const { live } = makeLive();
    const h = makeController(client, live);
    await h.send({ type: 'ready' });
    await sleep(200);
    const m = lastOf(h.posted, 'channels');
    ok('S2 auth: channels.ready === false', m && m.ready === false, m);
    ok('S2 auth: channels.setup === true', m && m.setup === true, m);
    ok('S2 auth: error text mentions the key', m && /key/i.test(m.error), m);
    ok('S2 auth: no error storm', errorish(h.posted).length <= 1, errorish(h.posted));
    h.c.dispose();
  }
  {
    const { client } = makeClient({ mode: 'network' });
    const { live } = makeLive();
    const h = makeController(client, live);
    await h.send({ type: 'ready' });
    await sleep(200);
    const m = lastOf(h.posted, 'channels');
    ok('S2 network: channels.ready === false', m && m.ready === false, m);
    ok('S2 network: channels.setup === false (webview offers "Try again", not setup)', m && m.setup === false, m);
    ok('S2 network: error text is the friendly network text with details', m && /relay/i.test(m.error) && /ECONNREFUSED/.test(m.error), m);
    ok('S2 network: no error storm', errorish(h.posted).length <= 1, errorish(h.posted));
    ok('S2 network: setContext buzz.ready not set true', !executed.some((x) => x[0] === 'setContext' && x[1] === 'buzz.ready' && x[2] === true), executed);
    h.c.dispose();
  }
  {
    // a key_error category (the CLI could not use the key): friendlyError's key text, setup not offered unless auth
    const { client, st } = makeClient({ mode: 'network' });
    st.mode = 'ok';
    client.me = async () => {
      throw new BuzzError(CliExit.Other, 'key_error', 'bad hex');
    };
    const { live } = makeLive();
    const h = makeController(client, live);
    await h.send({ type: 'ready' });
    await sleep(200);
    const m = lastOf(h.posted, 'channels');
    ok('S2 key_error: ready:false, a friendly "invalid key" text', m && m.ready === false && /key/i.test(m.error), m);
    h.c.dispose();
  }
}

async function scenarioRecovery() {
  console.log('\n# 3. recovery: the failure goes away, "Try again" (refresh)');
  const pages = { A: [ev('a1', 'A', now - 100, 'first thread'), ev('a2', 'A', now - 50, 'reply', 'a1', AG2)] };
  const { client, st } = makeClient({ mode: 'network', pages, members: { A: [{ pubkey: AG, name: 'lead_agent', isAgent: true }] } });
  const { live, subs } = makeLive();
  const h = makeController(client, live);
  executed.length = 0;
  await h.send({ type: 'ready' });
  await sleep(200);
  ok('S3 before recovery: ready:false', lastOf(h.posted, 'channels') && lastOf(h.posted, 'channels').ready === false, lastOf(h.posted, 'channels'));
  ok('S3 before recovery: no live subscriptions', Object.keys(subs).length === 0, Object.keys(subs));
  // the relay comes back
  st.mode = 'ok';
  h.posted.length = 0;
  await h.send({ type: 'refresh' });
  await sleep(400);
  const ch = lastOf(h.posted, 'channels');
  ok('S3 after refresh: channels ready:true with the channel', ch && ch.ready === true && ch.items.length === 1 && ch.items[0].id === 'A', ch);
  ok('S3 after refresh: "channel" posted', lastOf(h.posted, 'channel') && lastOf(h.posted, 'channel').id === 'A', lastOf(h.posted, 'channel'));
  const th = lastOf(h.posted, 'threads');
  ok('S3 after refresh: threads arrive', th && th.channelId === 'A' && th.items.length === 1 && th.items[0].replies === 1, th);
  const ids = Object.keys(subs);
  ok(
    'S3 after refresh: three live subscriptions (messages, typing, other)',
    ids.length === 3 && ids.some((i) => /-typing$/.test(i)) && ids.some((i) => /-other$/.test(i)),
    ids,
  );
  const main = ids.find((i) => !/-(typing|other)$/.test(i));
  ok('S3 the message subscription filters on the channel', main && JSON.stringify(subs[main]).includes('"#h":["A"]'), subs[main]);
  ok(
    'S3 setContext buzz.ready true after recovery',
    executed.some((x) => x[0] === 'setContext' && x[1] === 'buzz.ready' && x[2] === true),
    executed,
  );
  ok('S3 members posted after recovery', lastOf(h.posted, 'members') && lastOf(h.posted, 'members').items.length === 1, lastOf(h.posted, 'members'));
  ok('S3 no error/toast after a clean recovery', errorish(h.posted).length === 0, errorish(h.posted));
  // the thread opens
  h.posted.length = 0;
  await h.send({ type: 'openThread', id: hex('a1') });
  await sleep(100);
  const t1 = lastOf(h.posted, 'thread');
  ok('S3 the thread opens with both messages', t1 && t1.id === hex('a1') && t1.items.length === 2, t1 && t1.items.map((i) => i.id.slice(0, 2)));
  h.c.dispose();
}

async function scenarioMembersPresenceBroken() {
  console.log('\n# 4. members() and presence() reject forever');
  const pages = {
    A: [ev('a1', 'A', now - 100, 'thread in A'), ev('a2', 'A', now - 50, 'reply', 'a1', AG2)],
    B: [ev('b1', 'B', now - 100, 'thread in B')],
  };
  const { client, st } = makeClient({
    mode: 'ok',
    channels: [
      { id: 'A', name: 'alpha', isDm: false },
      { id: 'B', name: 'beta', isDm: false },
    ],
    pages,
    members: {
      A: [
        { pubkey: AG, name: 'lead_agent', isAgent: true },
        { pubkey: AG2, name: 'qa_agent', isAgent: true },
      ],
    },
    presence: { [AG]: 'offline', [AG2]: 'offline' },
  });
  const { live } = makeLive();
  const h = makeController(client, live);
  // first A works and says every agent is offline (Buzz Desktop closed) ...
  await h.send({ type: 'ready' });
  await sleep(300);
  const bar = lastOf(h.posted, 'agentsOffline');
  ok('S4 setup: channel A shows the agents-offline bar (its agents are offline)', bar && bar.offline === true && bar.names.length === 2, bar);
  // ... then members and presence break for good, and B is selected
  st.membersReject = true;
  st.presenceReject = true;
  h.posted.length = 0;
  await h.send({ type: 'select', id: 'B' });
  await sleep(400);
  const th = lastOf(h.posted, 'threads');
  ok('S4 B: threads still show', th && th.channelId === 'B' && th.items.length === 1, th);
  const bars = h.posted.filter((m) => m.type === 'agentsOffline');
  ok("S4 B: no agents-offline bar from A's stale members", !bars.some((b) => b.offline === true), bars);
  ok('S4 B: no "members" posted (the read failed)', !h.posted.some((m) => m.type === 'members'), types(h.posted));
  ok('S4 B: no error/toast for a failed members/presence read', errorish(h.posted).length === 0, errorish(h.posted));
  // a refresh with everything still broken: the chat keeps working
  h.posted.length = 0;
  await h.send({ type: 'refresh' });
  await sleep(400);
  ok('S4 refresh with broken members/presence: threads again, no error', lastOf(h.posted, 'threads') && errorish(h.posted).length === 0, {
    types: types(h.posted),
    errs: errorish(h.posted),
  });
  ok(
    'S4 refresh: still no offline bar',
    !h.posted.some((m) => m.type === 'agentsOffline' && m.offline === true),
    h.posted.filter((m) => m.type === 'agentsOffline'),
  );
  // the thread opens and the "working" guess does not break without presence
  h.posted.length = 0;
  await h.send({ type: 'openThread', id: hex('b1') });
  await sleep(100);
  ok('S4 thread opens without presence', lastOf(h.posted, 'thread') && lastOf(h.posted, 'thread').id === hex('b1'), lastOf(h.posted, 'thread'));
  // a presence failure is not retried on every poll: count presence calls over 2 s
  const before = st.calls.presence || 0;
  await h.send({ type: 'refresh' });
  await sleep(300);
  await h.send({ type: 'refresh' });
  await sleep(300);
  ok('S4 a broken presence read is not asked again on every refresh (backoff)', (st.calls.presence || 0) - before <= 1, { before, after: st.calls.presence });
  h.c.dispose();
}

async function scenarioNoChannels() {
  console.log('\n# 5. brand-new workspace: allChannels() returns []');
  const { client, st } = makeClient({ mode: 'ok', channels: [] });
  const { live, subs } = makeLive();
  const h = makeController(client, live);
  await h.send({ type: 'ready' });
  await sleep(200);
  const ch = lastOf(h.posted, 'channels');
  ok('S5 channels ready:true with an empty list', ch && ch.ready === true && Array.isArray(ch.items) && ch.items.length === 0, ch);
  ok('S5 no "channel" / "threads" posted for no channel', !h.posted.some((m) => m.type === 'channel' || m.type === 'threads'), types(h.posted));
  ok('S5 no error/toast', errorish(h.posted).length === 0, errorish(h.posted));
  ok('S5 no live subscriptions', Object.keys(subs).length === 0, Object.keys(subs));
  h.posted.length = 0;
  await h.send({ type: 'select', id: 'does-not-exist' });
  await sleep(200);
  ok(
    'S5 select of a missing id: a toast, no crash',
    h.posted.some((m) => m.type === 'toast' && m.message === t('chat.channelUnavailable')),
    h.posted,
  );
  ok('S5 select of a missing id: no "error" post', !h.posted.some((m) => m.type === 'error'), h.posted);
  h.posted.length = 0;
  await h.send({ type: 'openThread', id: hex('zz') });
  await h.send({ type: 'older' });
  await h.send({ type: 'newThread' });
  await h.send({ type: 'typing' });
  await sleep(100);
  ok('S5 openThread/older/newThread/typing with no channel: no error', !h.posted.some((m) => m.type === 'error'), h.posted);
  h.posted.length = 0;
  await h.send({ type: 'search', query: 'anything', scope: 'all' });
  await sleep(100);
  const sr = lastOf(h.posted, 'searchResults');
  ok('S5 search with no channel is answered with a hint', sr && sr.items.length === 0 && sr.error === t('chat.pickChannelFirst'), sr);
  h.posted.length = 0;
  await h.send({ type: 'send', text: 'hello', mentions: [], thread: null });
  await sleep(100);
  ok(
    'S5 send with no channel: error + composer unlocked, nothing sent',
    h.posted.some((m) => m.type === 'error' && m.message === t('chat.pickChannelFirst')) && lastOf(h.posted, 'sending').on === false && !st.calls.send,
    h.posted,
  );
  const before = totalCalls(st);
  await sleep(1500);
  ok('S5 no polling with no channel', totalCalls(st) === before, st.calls);
  // a channel appears later (created in Buzz Desktop): select it by id -> the list is re-read and it opens
  st.channels = [{ id: 'N', name: 'new-channel', isDm: false }];
  st.pages.N = [];
  h.posted.length = 0;
  await h.send({ type: 'select', id: 'N' });
  await sleep(300);
  ok('S5 a channel that appears later opens on select (list re-read)', lastOf(h.posted, 'channel') && lastOf(h.posted, 'channel').id === 'N', types(h.posted));
  const th = lastOf(h.posted, 'threads');
  ok('S5 an empty channel posts an empty thread list, more:false', th && th.items.length === 0 && th.more === false, th);
  h.c.dispose();
}

async function scenarioNoRepos() {
  console.log("\n# 6. the agents' repository is absent (repos.available === false)");
  const pages = {
    A: [
      ev('a1', 'A', now - 100, 'Pushed branch feature/login-fix, commit `1a2b3c4d5e6`', undefined, AG),
      ev('a2', 'A', now - 50, 'plain text, no code block', 'a1', AG2),
      ev('a3', 'A', now - 40, ['Here:', '```js', 'console.log(1)', '```'].join('\n'), 'a1', AG2),
    ],
  };
  const { client } = makeClient({ mode: 'ok', pages });
  const { live } = makeLive();
  const h = makeController(client, live, NO_REPOS);
  await h.send({ type: 'ready' });
  await sleep(300);
  h.posted.length = 0;
  await h.send({ type: 'gitDiff', id: hex('a1') });
  await sleep(100);
  ok(
    'S6 gitDiff without a repository posts the "no repository" toast',
    h.posted.some((m) => m.type === 'toast' && m.message === t('agent.none')),
    h.posted,
  );
  ok('S6 gitDiff: no "error" post', !h.posted.some((m) => m.type === 'error'), h.posted);
  h.posted.length = 0;
  await h.send({ type: 'gitDiff', id: hex('a2') });
  await sleep(50);
  ok('S6 gitDiff on a message without git refs: silently nothing', h.posted.length === 0, h.posted);
  h.posted.length = 0;
  await h.send({ type: 'patchDiff', id: hex('a2'), block: 0 });
  await sleep(50);
  ok(
    'S6 patchDiff with no plan (no code block) posts the "no file" toast',
    h.posted.some((m) => m.type === 'toast' && m.message === t('patch.noFile')),
    h.posted,
  );
  h.posted.length = 0;
  await h.send({ type: 'patchDiff', id: hex('a3'), block: 0 });
  await sleep(50);
  ok(
    'S6 patchDiff on a code block that is not a proposal posts the "no file" toast',
    h.posted.some((m) => m.type === 'toast' && m.message === t('patch.noFile')),
    h.posted,
  );
  h.posted.length = 0;
  await h.send({ type: 'patchDiff', id: hex('nope'), block: 0 });
  await h.send({ type: 'patchApply', id: hex('nope'), block: 0 });
  await sleep(50);
  ok(
    'S6 patchDiff/patchApply on an unknown message: toasts, no error',
    h.posted.filter((m) => m.type === 'toast').length === 2 && !h.posted.some((m) => m.type === 'error'),
    h.posted,
  );
  h.posted.length = 0;
  await h.send({ type: 'openRef', path: 'src/x.ts', line: 3 });
  await sleep(200);
  ok(
    'S6 openRef without a repository or workspace: the "not found" toast, no error',
    h.posted.some((m) => m.type === 'toast' && m.message === t('ref.notFound', 'src/x.ts')) && !h.posted.some((m) => m.type === 'error'),
    h.posted,
  );
  h.c.dispose();
}

function runNode(script, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['-e', script, PROJ], { env, windowsHide: true, timeout: 30000 }, (err, out, errOut) =>
      resolve({ err, out: String(out), errOut: String(errOut) }),
    );
  });
}

async function scenarioGitMissing() {
  console.log('\n# 7. git missing from PATH / a folder that does not exist');
  // 7a. git present (maybe), folder missing
  let r;
  try {
    r = await agentGit.changeRange(['C:\\nonexistent'], 'main', 'branch', 'buzz');
    ok('S7 changeRange on a missing folder resolves with a message', typeof r === 'string' && r === t('git.notFound', 'main'), r);
  } catch (e) {
    ok('S7 changeRange on a missing folder resolves with a message', false, String(e));
  }
  try {
    r = await agentGit.changeRange(['C:\\nonexistent'], '1a2b3c4d5e6', 'commit', 'buzz');
    ok('S7 changeRange (commit) on a missing folder resolves with a message', typeof r === 'string', r);
  } catch (e) {
    ok('S7 changeRange (commit) on a missing folder resolves with a message', false, String(e));
  }
  try {
    r = await agentGit.worktrees('C:\\nonexistent');
    ok('S7 worktrees on a missing folder resolves with []', Array.isArray(r) && r.length === 0, r);
  } catch (e) {
    ok('S7 worktrees on a missing folder resolves with []', false, String(e));
  }
  try {
    r = await agentGit.worktreeChanges('C:\\nonexistent');
    ok('S7 worktreeChanges on a missing folder: rejects or resolves (either is handled by callers)', true, r);
  } catch (e) {
    ok("S7 worktreeChanges on a missing folder: rejects with git's message, not a crash", e instanceof Error, String(e));
  }
  // 7b. git really not on PATH: a child process with an empty PATH, cwd = an existing folder (the repo's own folder,
  // so the failure is "git not found", not "cwd missing")
  const script = `
    const path = require('path');
    const g = require(path.join(process.argv[1], 'out', 'agentGit.js'));
    const dir = process.argv[1];
    (async () => {
      const out = {};
      try { out.change = await g.changeRange([dir], 'main', 'branch', 'buzz'); } catch (e) { out.changeErr = String(e); }
      try { out.wt = await g.worktrees(dir); } catch (e) { out.wtErr = String(e); }
      try { out.found = await g.findRef([dir], 'main', 'branch'); } catch (e) { out.foundErr = String(e); }
      try { out.co = await g.checkedOut(dir); } catch (e) { out.coErr = String(e); }
      process.stdout.write(JSON.stringify(out));
    })();
    process.on('unhandledRejection', (e) => { process.stdout.write(JSON.stringify({ unhandled: String(e) })); process.exit(3); });
  `;
  const env = { PATH: '', Path: '', SystemRoot: process.env.SystemRoot || 'C:\\Windows', TEMP: process.env.TEMP || '', TMP: process.env.TMP || '' };
  const res = await runNode(script, env);
  let parsed;
  try {
    parsed = JSON.parse(res.out);
  } catch {
    parsed = undefined;
  }
  ok('S7 no-git child process exits cleanly with a result', !res.err && parsed && !parsed.unhandled, {
    err: res.err && res.err.message,
    out: res.out.slice(0, 300),
    errOut: res.errOut.slice(0, 300),
  });
  if (parsed) {
    ok('S7 no git: changeRange resolves with a message', typeof parsed.change === 'string' && !parsed.changeErr, parsed);
    ok('S7 no git: worktrees resolves with []', Array.isArray(parsed.wt) && parsed.wt.length === 0 && !parsed.wtErr, parsed);
    ok('S7 no git: findRef resolves undefined', parsed.found === undefined && !parsed.foundErr, parsed);
    ok('S7 no git: checkedOut resolves ""', parsed.co === '' && !parsed.coErr, parsed);
  }
}

function scenarioDesktopCandidates() {
  console.log('\n# 8. desktopCandidates with an empty env and a home with spaces');
  const sane = (list, sep) => list.every((p) => typeof p === 'string' && p.length > 0 && !/undefined|null/.test(p) && !p.includes(sep + sep) && !/\s$/.test(p));
  const win = desktopCandidates({}, 'win32', 'C:\\Users\\John Smith');
  ok('S8 win32: non-empty, sane paths', win.length > 0 && sane(win, '\\'), win);
  ok(
    'S8 win32: falls back to <home>\\AppData\\Local when LOCALAPPDATA is unset',
    win.some((p) => p.startsWith('C:\\Users\\John Smith\\AppData\\Local\\')),
    win,
  );
  ok('S8 win32: no Program Files entries without the env', !win.some((p) => /Program Files/.test(p)), win);
  ok('S8 win32: no duplicates', new Set(win).size === win.length, win);
  const winEnv = desktopCandidates(
    { LOCALAPPDATA: 'D:\\My Apps\\Local', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    'win32',
    'C:\\Users\\x',
  );
  ok(
    'S8 win32 with env: LOCALAPPDATA first, both Program Files',
    winEnv[0].startsWith('D:\\My Apps\\Local\\') &&
      winEnv.some((p) => p.startsWith('C:\\Program Files\\')) &&
      winEnv.some((p) => p.startsWith('C:\\Program Files (x86)\\')),
    winEnv,
  );
  const mac = desktopCandidates({}, 'darwin', '/Users/John Smith');
  ok('S8 darwin: sane paths, home with spaces kept as is', mac.length > 0 && sane(mac, '/') && mac.includes('/Users/John Smith/Applications/Buzz.app'), mac);
  const macApps = desktopCandidates({}, 'darwin', '/Users/x', ['/Applications/Buzz Desktop 2.app']);
  ok('S8 darwin: found app bundles come first', macApps[0] === '/Applications/Buzz Desktop 2.app', macApps);
  const lin = desktopCandidates({}, 'linux', '/home/john smith');
  ok(
    'S8 linux: sane paths with an empty PATH, home with spaces',
    lin.length > 0 && sane(lin, '/') && lin.includes('/home/john smith/.local/bin/buzz-desktop') && !lin.includes('/buzz-desktop'),
    lin,
  );
  const linPath = desktopCandidates({ PATH: '/usr/bin::/opt/x/:' }, 'linux', '/home/x');
  ok(
    'S8 linux: PATH entries, empty ones skipped, trailing slash trimmed, no duplicates',
    linPath.includes('/opt/x/buzz-desktop') && !linPath.includes('/buzz-desktop') && new Set(linPath).size === linPath.length,
    linPath,
  );
  const un = desktopCandidates({}, 'freebsd', '/home/x');
  ok('S8 unknown platform: the unix list, no crash', Array.isArray(un) && un.length > 0, un);
}

(async () => {
  const t0 = Date.now();
  await scenarioSetupError();
  await scenarioAuthAndNetwork();
  await scenarioRecovery();
  await scenarioMembersPresenceBroken();
  await scenarioNoChannels();
  await scenarioNoRepos();
  await scenarioGitMissing();
  scenarioDesktopCandidates();
  await sleep(200);
  ok('no unhandled rejections / uncaught exceptions during the run', unexpected.length === 0, unexpected);
  console.log(`\n${pass} passed, ${fail} failed  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS CRASH', e);
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
