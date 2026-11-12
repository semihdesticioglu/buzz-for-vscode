// A DM note that stands for several conversations with the same person: all of them are read, live subscriptions
// cover every id, a reply goes where its thread lives, a new thread goes to the newest conversation, and a
// notification naming an older conversation still opens.
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
// two conversations with the same agent: D1 (older) holds a thread with a reply; D2 (newest) holds one root
const data = {
  D1: [ev('r1', 'D1', now - 5000, 'old question', ME), ev('r1x', 'D1', now - 4900, 'old answer', AG, 'r1')],
  D2: [ev('r2', 'D2', now - 100, 'new question', ME)],
  C: [ev('c1', 'C', now - 50, 'channel root', AG)],
};
const sent = [];
const subs = {};
const client = {
  myPubkey: ME,
  me: async () => ({}),
  channels: async () => [{ id: 'C', name: 'general', isDm: false }],
  allChannels: async () => [
    { id: 'C', name: 'general', isDm: false },
    { id: 'D2', ids: ['D2', 'D1'], name: 'review_agent', isDm: true, peers: [AG] },
  ],
  dms: async () => [{ id: 'D2', ids: ['D2', 'D1'], name: 'review_agent', isDm: true, peers: [AG] }],
  messages: async (ch, o = {}) => (data[ch] || []).filter((e) => (o.since ? e.created_at >= o.since : true)).slice(-(o.limit || 100)),
  thread: async (ch, id) => {
    const all = data[ch] || [];
    const rootOf = (e) => (e.tags.find((t) => t[3] === 'root') || [])[1] || e.id;
    const hit = all.find((e) => e.id === id);
    return hit ? all.filter((e) => rootOf(e) === rootOf(hit)) : [];
  },
  send: async (ch, content, o) => {
    sent.push({ ch, content, o });
    return { event_id: hex('s' + sent.length), accepted: true };
  },
  members: async () => [{ pubkey: AG, name: 'review_agent', isAgent: true }],
  presence: async () => ({ [AG]: 'online' }),
  nameOf: (pk) => (pk === ME ? 'me' : 'review_agent'),
  isAgent: (pk) => pk === AG,
  ensureProfiles: async () => undefined,
};
let onLive;
const live = {
  onEvent: (cb) => ((onLive = cb), disp),
  onState: () => disp,
  subscribe: (id, f) => (subs[id] = f),
  unsubscribe: (id) => delete subs[id],
  state: { state: 'live' },
  isLive: true,
  publish: (draft) => (sent.push({ typing: draft }), true),
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
let pass = 0;
let fail = 0;
const ok = (name, cond, info) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info)));
};
const lastThreads = () => [...posted].reverse().find((m) => m.type === 'threads');

(async () => {
  await onMsg({ type: 'ready' });
  await sleep(200);
  await onMsg({ type: 'select', id: 'D2' });
  await sleep(300);
  let t = lastThreads();
  ok(
    'the DM note shows the threads of both conversations',
    t && t.channelId === 'D2' && t.items.length === 2 && t.items.some((x) => x.id === hex('r1')) && t.items.some((x) => x.id === hex('r2')),
    t && t.items.map((x) => x.id.slice(0, 4)),
  );
  const mainSub = Object.entries(subs).find(([k]) => !/-(typing|other)$/.test(k));
  ok(
    'the live subscription covers every conversation of the note',
    mainSub && JSON.stringify(mainSub[1][0]['#h']) === JSON.stringify(['D2', 'D1']),
    mainSub && mainSub[1],
  );

  // reply in the old thread -> the old conversation; a new thread -> the newest conversation
  await onMsg({ type: 'openThread', id: hex('r1') });
  await sleep(200);
  await onMsg({ type: 'send', text: 'follow-up', mentions: [], thread: hex('r1') });
  await sleep(200);
  ok(
    'a reply goes into the conversation its thread lives in',
    sent.some((s) => s.ch === 'D1' && s.content === 'follow-up' && s.o.replyTo === hex('r1')),
    sent,
  );
  await onMsg({ type: 'newThread' });
  await onMsg({ type: 'send', text: 'brand new', mentions: [], thread: null });
  await sleep(200);
  ok(
    'a new thread goes into the newest conversation',
    sent.some((s) => s.ch === 'D2' && s.content === 'brand new'),
    sent,
  );
  await onMsg({ type: 'typing' });
  ok(
    'the typing signal names the conversation of the thread on screen',
    sent.some((s) => s.typing && s.typing.tags[0][1] === 'D2'),
    sent.filter((s) => s.typing),
  );

  // a live message in the older conversation is shown
  posted.length = 0;
  onLive(mainSub[0], ev('r1y', 'D1', now + 1, 'another old-thread answer', AG, 'r1'));
  await sleep(250);
  t = lastThreads();
  ok(
    'a live message of the older conversation lands in the list',
    t && t.items.find((x) => x.id === hex('r1')).replies === 2,
    t && t.items.map((x) => [x.id.slice(0, 4), x.replies]),
  );

  // a notification about a message in the older conversation (its id is the raw conversation id)
  await onMsg({ type: 'select', id: 'C' });
  await sleep(250);
  posted.length = 0;
  await c.openChannel('D1', hex('r1x'));
  await sleep(300);
  const th = [...posted].reverse().find((m) => m.type === 'thread');
  ok(
    'opening by an older conversation id resolves to the note and focuses the thread',
    c.channel && c.channel.id === 'D2' && th && th.id === hex('r1') && th.items.length >= 2,
    { ch: c.channel && c.channel.id, th: th && th.id.slice(0, 4) },
  );

  c.dispose();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
