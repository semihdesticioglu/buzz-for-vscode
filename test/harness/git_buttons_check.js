// The agent's git bar on the controller side: the real ChatController (out/chat.js) with a fake vscode module and
// a fake Buzz client. A message carries the branch and commit the agent reported, a proposal is offered as Show diff
// only (applying locally is off by default), and the retired Apply / Approve / Request changes messages do nothing.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (s) => (s + '0'.repeat(64)).slice(0, 64);
const ME = hex('ff');
const ev = (id, ch, ts, content, root, pk = hex('aa')) => ({
  id: hex(id),
  pubkey: pk,
  kind: 9,
  created_at: ts,
  content,
  tags: [['h', ch], ...(root ? [['e', hex(root), '', 'root']] : [])],
});

const A = 'chA',
  B = 'chB';
const now = Math.floor(Date.now() / 1000);
const pageA = [1, 2, 3, 4].map((i) => ev('a' + i, A, now - 1000 + i, 'A thread ' + i));
pageA.push(ev('gg', A, now - 950, "Dev düzeltme commit'i 9c4e2b7 (3d81a5e üstüne, aynı dal feature/abc-1201-rank-ties).", 'a1', hex('ll')));
pageA.push(ev('pp', A, now - 900, ['Fix `sql/x.sql:3`:', '```diff', '-a', '+b', '```'].join(String.fromCharCode(10)), 'a1', hex('rr')));
const olderA = [ev('a0', A, now - 5000, 'A very old thread')];
const pageB = [ev('b1', B, now - 900, 'B thread 1')];
const delay = { messages: 50, older: 50, thread: 30, send: 80, members: 10, membersA: 10 };
let sent = [];
let sendResult = null; // override per test
let onLive = null;
const client = {
  myPubkey: ME,
  me: async () => ({}),
  channels: async () => [
    { id: A, name: 'backend-dev' },
    { id: B, name: 'ops' },
  ],
  allChannels: async () => [
    { id: A, name: 'backend-dev' },
    { id: B, name: 'ops' },
  ],
  dms: async () => [],
  async messages(ch, o) {
    if (o && o.before) {
      await sleep(delay.older);
      return ch === A ? olderA.filter((e) => e.created_at < o.before) : [];
    }
    await sleep(delay.messages);
    return ch === A ? pageA.slice() : pageB.slice();
  },
  async thread(ch, id) {
    await sleep(delay.thread);
    const all = ch === A ? [...pageA, ...olderA] : pageB;
    const rootOf = (e) => (e.tags.find((t) => t[3] === 'root') || [])[1] || e.id;
    const hit = all.find((e) => e.id === id);
    if (!hit) return [];
    return all.filter((e) => rootOf(e) === rootOf(hit));
  },
  async send(ch, content, o) {
    const id = hex('s' + sent.length);
    sent.push({ ch, content, o, id });
    // my root arrives over the live connection before the CLI returns
    if (!o.replyTo && onLive) setTimeout(() => onLive('LIVE', ev('s' + (sent.length - 1), ch, Math.floor(Date.now() / 1000), content, undefined, ME)), 10);
    await sleep(delay.send);
    return sendResult || { event_id: id, accepted: true };
  },
  async members(ch) {
    await sleep(ch === A ? delay.membersA : delay.members);
    return [
      { pubkey: hex('dd'), name: 'dev_agent_claude', isAgent: true },
      { pubkey: hex('rr'), name: 'review_agent_claude', isAgent: true },
    ];
  },
  presence: async () => ({}),
  nameOf: (pk) => (pk === ME ? 'me' : pk === hex('ll') ? 'engineering_lead_agent_claude' : 'agent'),
  isAgent: (pk) => pk !== ME,
  ensureProfiles: async () => undefined,
};
const subs = {};
const live = {
  onEvent: (cb) => ((onLive = (sub, e) => cb(sub === 'LIVE' ? Object.keys(subs).find((k) => !/-(typing|other)$/.test(k)) : sub, e)), disp),
  onState: () => disp,
  subscribe: (id, f) => (subs[id] = f),
  unsubscribe: (id) => delete subs[id],
  state: { state: 'live' },
  isLive: true,
  fetch: async () => undefined,
  out: { appendLine: noop },
  publish: noop,
};
const ext = {
  workspaceState: { get: () => undefined, update: async () => undefined },
  globalState: { get: () => undefined, update: async () => undefined },
  extensionUri: { toString: () => '' },
};

const log = [];
let onMsg;
let c = new ChatController(ext, client, live, {}, {}, { available: false });
c.attach({
  kind: 'panel',
  webview: {
    options: {},
    html: '',
    asWebviewUri: (u) => u,
    cspSource: '',
    onDidReceiveMessage: (cb) => ((onMsg = cb), disp),
    postMessage: async (m) => log.push(m),
  },
  isVisible: () => true,
  onVisibility: () => disp,
  onDispose: () => disp,
  reveal: noop,
});
const take = () => log.splice(0);
let pass = 0;
const ok = (name, cond, info) => {
  if (cond) pass++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info).slice(0, 300)));
};

(async () => {
  await onMsg({ type: 'ready' });
  await sleep(200);
  await onMsg({ type: 'openThread', id: hex('a1') });
  await sleep(100);
  const th = log.filter((x) => x.type === 'thread' && x.id === hex('a1')).pop();
  const it = th && th.items.find((x) => x.id === hex('gg'));
  ok(
    'the message carries its branch and commit',
    it && it.git && it.git.branches[0] === 'feature/abc-1201-rank-ties' && it.git.commits[0] === '9c4e2b7',
    it && it.git,
  );
  const pp = th && th.items.find((x) => x.id === hex('pp'));
  ok('a proposal is marked as not local (only Show diff)', pp && pp.patches[0] && pp.patches[0].local === false, pp && pp.patches);
  take();
  await onMsg({ type: 'patchApply', id: hex('pp'), block: 0 });
  await onMsg({ type: 'gitApprove', id: hex('gg') });
  await onMsg({ type: 'gitChange', id: hex('gg') });
  const m = take();
  ok(
    'Apply / Approve / Request changes no longer do anything',
    !m.some((x) => x.type === 'compose' || x.type === 'toast' || x.type === 'error'),
    m.map((x) => x.type),
  );
  console.log(`
${pass} checks passed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
