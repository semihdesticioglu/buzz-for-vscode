// A thread longer than the CLI's page: the CLI gives the newest 500, the live connection the older pages by `until`,
// and the open thread shows all of them once, in order.
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
const ME = hex('ff');
const AG = hex('a1');
const now = Math.floor(Date.now() / 1000);
const ROOT = hex('r1');
const ev = (id, ts, content, pk, root) => ({
  id: hex(id),
  pubkey: pk,
  kind: 9,
  created_at: ts,
  content,
  tags: [['h', 'C'], ...(root ? [['e', root, '', 'root']] : [])],
});
const TOTAL = 1275; // replies
const root = ev('r1', now - 100000, 'the question', ME);
const replies = Array.from({ length: TOTAL }, (_, i) =>
  ev('x' + i.toString(16).padStart(4, '0'), now - 100000 + 10 + i * 10, 'reply ' + i, i % 2 ? AG : ME, ROOT),
);
const everything = [root, ...replies].sort((a, b) => a.created_at - b.created_at); // the channel, oldest first: a page is its newest N
const cliCalls = [];
const liveCalls = [];
const client = {
  myPubkey: ME,
  me: async () => ({}),
  channels: async () => [{ id: 'C', name: 'general', isDm: false }],
  allChannels: async () => [{ id: 'C', name: 'general', isDm: false }],
  dms: async () => [],
  messages: async (_ch, o = {}) => (o.before ? [] : everything.slice(-(o.limit || 100))),
  thread: async (ch, id) => {
    cliCalls.push({ ch, id });
    // the newest 500 of the thread (replies plus the root), as the CLI does with --limit 500
    return [root, ...replies.slice(-499)];
  },
  send: async () => ({ event_id: hex('s1'), accepted: true }),
  members: async () => [{ pubkey: AG, name: 'agent', isAgent: true }],
  presence: async () => ({}),
  nameOf: (pk) => (pk === ME ? 'me' : 'agent'),
  isAgent: (pk) => pk === AG,
  ensureProfiles: async () => undefined,
};
const live = {
  onEvent: () => disp,
  onState: () => disp,
  subscribe: noop,
  unsubscribe: noop,
  state: { state: 'live' },
  isLive: true,
  publish: noop,
  fetch: async (filters) => {
    const f = filters[0];
    liveCalls.push(f);
    if (!f['#e']) return undefined;
    const page = replies
      .filter((e) => e.created_at <= f.until)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, f.limit);
    return { events: page, complete: true, reason: 'eose' };
  },
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
let pass = 0;
let fail = 0;
const ok = (name, cond, info) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info)));
};

(async () => {
  await onMsg({ type: 'ready' });
  await sleep(300);
  posted.length = 0;
  await onMsg({ type: 'openThread', id: ROOT });
  await sleep(600);
  const th = [...posted].reverse().find((m) => m.type === 'thread' && m.id === ROOT);
  ok('the CLI was asked for the thread (and once more for the missing root)', cliCalls.length <= 2, cliCalls);
  ok(
    'older pages were read over the live connection by the root with until',
    liveCalls.filter((f) => f['#e']).length >= 2 && liveCalls.every((f) => !f['#e'] || (f['#e'][0] === ROOT && f['#h'][0] === 'C' && Array.isArray(f.kinds))),
    liveCalls.map((f) => [f.until, f.limit]),
  );
  ok(`the open thread shows the root and all ${TOTAL} replies`, th && th.items.length === TOTAL + 1, th && th.items.length);
  const ids = th ? th.items.map((x) => x.id) : [];
  ok('every message once, oldest first', new Set(ids).size === ids.length && th.items.every((x, i) => i === 0 || x.ts >= th.items[i - 1].ts), ids.length);
  const row = [...posted].reverse().find((m) => m.type === 'threads');
  ok('the list row counts every reply', row && row.items.find((t) => t.id === ROOT).replies === TOTAL, row && row.items.map((t) => t.replies));
  c.dispose();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
