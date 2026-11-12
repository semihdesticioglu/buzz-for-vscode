// Search (controller side): matches grouped by thread, newest first, scoped to the channel or to all, over the live
// connection with the CLI as fallback; opening a result in another channel switches to it.
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
const ev = (id, ch, ts, content, pk, root) => ({
  id: hex(id),
  pubkey: pk,
  kind: 9,
  created_at: ts,
  content,
  tags: [['h', ch], ...(root ? [['e', hex(root), '', 'root']] : [])],
});
// three threads mention "rollup": two in A (one of them twice), one in B
const hits = [
  ev('a1', 'A', now - 5000, 'rollup base question', ME),
  ev('a1x', 'A', now - 4000, 'answer about rollup', AG, 'a1'),
  ev('a2', 'A', now - 1000, 'another rollup thread', AG),
  ev('b1', 'B', now - 2000, 'ops: rollup deploy', AG),
];
let liveMode = 'on';
const liveCalls = [];
const cliCalls = [];
const client = {
  myPubkey: ME,
  me: async () => ({}),
  channels: async () => [
    { id: 'A', name: 'general', isDm: false },
    { id: 'B', name: 'ops', isDm: false },
  ],
  allChannels: async () => [
    { id: 'A', name: 'general', isDm: false },
    { id: 'B', name: 'ops', isDm: false },
  ],
  dms: async () => [],
  messages: async () => [],
  thread: async (ch, id) =>
    hits.filter((e) => e.tags.find((t) => t[0] === 'h')[1] === ch && (e.id === id || (e.tags.find((t) => t[3] === 'root') || [])[1] === id)),
  search: async (q, limit) => {
    cliCalls.push({ q, limit });
    return hits;
  },
  send: async () => ({ event_id: hex('s1'), accepted: true }),
  members: async () => [],
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
    if (!f.search) return undefined;
    liveCalls.push(f);
    if (liveMode === 'off') return undefined;
    const inScope = f['#h'] ? hits.filter((e) => f['#h'].includes(e.tags[0][1])) : hits;
    return { events: inScope, complete: true, reason: 'eose' };
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
const last = () => [...posted].reverse().find((m) => m.type === 'searchResults');

(async () => {
  await onMsg({ type: 'ready' });
  await sleep(250);
  await onMsg({ type: 'search', query: ' rollup ', scope: 'channel' });
  await sleep(100);
  let r = last();
  ok(
    'live search filter: kinds, the query, this channel only',
    liveCalls[0] && Array.isArray(liveCalls[0].kinds) && liveCalls[0].search === 'rollup' && JSON.stringify(liveCalls[0]['#h']) === JSON.stringify(['A']),
    liveCalls[0],
  );
  ok(
    'this channel: two threads, newest first, grouped with match counts',
    r && r.items.length === 2 && r.items[0].id === hex('a2') && r.items[1].id === hex('a1') && r.items[1].matches === 2 && r.items[1].matchId === hex('a1x'),
    r && r.items,
  );
  ok(
    'rows carry the author of the newest match and the channel name',
    r && r.items[1].author === 'agent' && r.items[1].channelName === '#general' && r.items[0].snippet.includes('another rollup'),
    r && r.items[1],
  );

  await onMsg({ type: 'search', query: 'rollup', scope: 'all' });
  await sleep(100);
  r = last();
  ok(
    'all channels: the ops thread too, with its channel',
    r && r.scope === 'all' && r.items.length === 3 && r.items.some((x) => x.channelId === 'B' && x.channelName === '#ops'),
    r && r.items.map((x) => x.channelName),
  );

  liveMode = 'off';
  await onMsg({ type: 'search', query: 'rollup', scope: 'channel' });
  await sleep(100);
  r = last();
  ok(
    'no live connection: the CLI search answers and the scope is applied locally',
    cliCalls.length === 1 && cliCalls[0].limit >= 100 && r && r.items.length === 2 && r.items.every((x) => x.channelId === 'A'),
    { cliCalls, items: r && r.items.length },
  );

  posted.length = 0;
  await onMsg({ type: 'openResult', channel: 'B', id: hex('b1') });
  await sleep(300);
  const th = [...posted].reverse().find((m) => m.type === 'thread');
  ok('opening a result in another channel switches to it and shows that thread', c.channel && c.channel.id === 'B' && th && th.id === hex('b1'), {
    ch: c.channel && c.channel.id,
    th: th && th.id.slice(0, 4),
  });

  c.dispose();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
