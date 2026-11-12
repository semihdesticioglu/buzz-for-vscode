// Where a message goes when Enter and a channel switch cross: the real ChatController (out/chat.js) with a fake
// vscode module, a fake Buzz client and a fake webview. The rule under test: a message goes where the composer showed
// it going, into the conversation its thread lives in (a DM note stands for several conversations with the same
// people), and no answer is awaited in a channel the user moved on to.
//   node test/harness/send_route_check.js [repo]
const Module = require('module');
const path = require('path');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');

let pass = 0;
let fail = 0;
const stray = [];
process.on('unhandledRejection', (e) => stray.push('unhandledRejection: ' + ((e && e.stack) || e)));
process.on('uncaughtException', (e) => stray.push('uncaughtException: ' + ((e && e.stack) || e)));
const ok = (name, cond, info) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info)));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
const noop = () => undefined;
const disp = { dispose: noop };
const fakeVscode = {
  workspace: {
    getConfiguration: () => ({ get: (_k, d) => d, update: async () => undefined }),
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
  return req === 'vscode' ? fakeVscode : origLoad.apply(this, arguments);
};
const { ChatController } = require(path.join(PROJ, 'out', 'chat.js'));

const hex = (s) => (s + '0'.repeat(64)).slice(0, 64);
const ME = hex('ff');
const AG = hex('ee');
const P = hex('dd');
const D1 = hex('d1'); // the DM note's newest conversation (its id)
const D2 = hex('d2'); // an older conversation with the same person, folded into the same note
const Y = hex('ab'); // another channel
const now = Math.floor(Date.now() / 1000);
const mk = (id, ch, ts, content, pk, root) => ({
  id,
  pubkey: pk,
  kind: 9,
  created_at: ts,
  content,
  tags: [['h', ch], ...(root ? [['e', root, '', 'root']] : [])],
});
const R1 = hex('a1'); // a thread in d1
const R2 = hex('a2'); // a thread in d2, with a reply
const R2r = hex('a3');
const YR = hex('b1');
const data = {
  [D1]: [mk(R1, D1, now - 100, 'd1 root', P)],
  [D2]: [mk(R2, D2, now - 200, 'd2 root', P), mk(R2r, D2, now - 190, 'd2 reply', ME, R2)],
  [Y]: [mk(YR, Y, now - 50, 'y root', P)],
};
let dmListed = true;
let agentOnline = true;
const sends = [];
const client = {
  myPubkey: ME,
  me: async () => ({ pubkey: ME }),
  allChannels: async () => {
    await sleep(5);
    return [...(dmListed ? [{ id: D1, ids: [D1, D2], name: 'Ada', isDm: true, peers: [P] }] : []), { id: Y, name: 'why', isDm: false }];
  },
  async messages(ch, o = {}) {
    await sleep(10);
    let evs = (data[ch] || []).slice();
    if (o.since !== undefined) evs = evs.filter((e) => e.created_at >= o.since);
    if (o.before !== undefined) evs = evs.filter((e) => e.created_at < o.before);
    return evs.sort((a, b) => b.created_at - a.created_at).slice(0, o.limit ?? 50);
  },
  async thread(ch, id) {
    await sleep(10);
    const all = data[ch] || [];
    const rootOf = (e) => (e.tags.find((t) => t[0] === 'e') || [])[1] || e.id;
    const hit = all.find((e) => e.id === id);
    return hit ? all.filter((e) => rootOf(e) === rootOf(hit)) : [];
  },
  async send(ch, content, o = {}) {
    await sleep(30);
    const id = hex('f0' + sends.length.toString(16));
    sends.push({ ch, content, mentions: o.mentions, replyTo: o.replyTo, id });
    return { event_id: id, accepted: true };
  },
  async members() {
    await sleep(5);
    return [
      { pubkey: AG, name: 'agent', isAgent: true },
      { pubkey: P, name: 'Ada', isAgent: false },
    ];
  },
  async presence() {
    await sleep(5);
    // as the real CLI: only who has a live presence entry is listed
    return agentOnline ? { [AG]: 'online', [P]: 'online' } : { [P]: 'online' };
  },
  nameOf: (pk) => (pk === ME ? 'me' : pk === AG ? 'agent' : pk === P ? 'Ada' : pk.slice(0, 6)),
  isAgent: (pk) => pk === AG,
  ensureProfiles: async () => {
    await sleep(2);
  },
  async search() {
    return [];
  },
};
const live = {
  onEvent: () => disp,
  onState: () => disp,
  subscribe: noop,
  unsubscribe: noop,
  state: { state: 'off' },
  isLive: false,
  publish: noop,
  async fetch() {
    return undefined;
  },
};
const ext = {
  workspaceState: { get: () => undefined, update: async () => undefined },
  globalState: {
    get: () => undefined,
    update: async () => {
      await sleep(5); // a Memento write crosses to the main process: the window in which Enter and a switch cross
    },
  },
  extensionUri: { toString: () => '' },
};

const posted = [];
let onMsg;
let onPost = null; // run inside postMessage: an Enter already on its way when the controller posts something
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
      if (onPost) onPost(m);
    },
  },
  isVisible: () => true,
  onVisibility: () => disp,
  onDispose: () => disp,
  reveal: noop,
  close: noop,
});
const send = (m) => {
  const p = onMsg(m);
  p.catch((e) => stray.push('onMessage rejected: ' + ((e && e.stack) || e)));
  return p;
};
const take = () => posted.splice(0);
const ofType = (ms, t) => ms.filter((m) => m.type === t);
const lastOf = (ms, t) => [...ms].reverse().find((m) => m.type === t);
async function settle(quiet = 120, max = 4000) {
  const start = Date.now();
  let n = posted.length;
  let last = Date.now();
  for (;;) {
    await sleep(15);
    if (posted.length !== n) {
      n = posted.length;
      last = Date.now();
    } else if (Date.now() - last >= quiet) return;
    if (Date.now() - start > max) return;
  }
}
const label = (id) => ({ [D1]: 'd1', [D2]: 'd2', [Y]: 'Y' })[id] || (typeof id === 'string' ? id.slice(0, 6) : id);
const route = () => sends.map((s) => ({ to: label(s.ch), replyTo: s.replyTo && label(s.replyTo) }));
/** Enter pressed in the composer showing `from`, delivered while the controller posts 'channel <to>'. */
const enterDuringSwitch = (to, msg) => {
  onPost = (m) => {
    if (m.type === 'channel' && m.id === to) {
      onPost = null;
      send(msg);
    }
  };
  send({ type: 'select', id: to });
};

(async () => {
  await send({ type: 'ready' });
  await settle();
  take();
  ok('the DM note stands for two conversations (d1 newest, d2 older)', c.channel && c.channel.id === D1 && c.channel.ids.join() === [D1, D2].join(), c.channel);

  // ---------------------------------------------------------------- A. the ordinary path
  await send({ type: 'openThread', id: R2 });
  await settle();
  take();
  sends.length = 0;
  await send({ type: 'send', text: 'normal reply', mentions: [], thread: R2, channel: D1 });
  await settle();
  ok(
    'A. a reply to a thread of the older conversation goes into that conversation',
    sends.length === 1 && sends[0].ch === D2 && sends[0].replyTo === R2,
    route(),
  );

  // ---------------------------------------------------------------- B. Enter on its way while the switch clears the channel's messages
  take();
  sends.length = 0;
  enterDuringSwitch(Y, { type: 'send', text: 'late reply', mentions: [], thread: R2, channel: D1 });
  await settle();
  let m = take();
  ok(
    "B. a reply typed in the DM note, arriving after the switch cleared its messages, goes into its thread's own conversation",
    sends.length === 1 && sends[0].ch === D2 && sends[0].replyTo === R2,
    route(),
  );
  ok(
    'B. no error; the composer is told it was sent, then unlocked',
    !ofType(m, 'error').length && ofType(m, 'sent').length === 1 && lastOf(m, 'sending').on === false,
    m.map((x) => x.type),
  );
  ok('B. the controller is on the channel picked', c.channel.id === Y, label(c.channel.id));

  // ---------------------------------------------------------------- B2. the channel picked is opened again while it loads (a search hit, a notification)
  await send({ type: 'select', id: D1 });
  await settle();
  await send({ type: 'openThread', id: R2 });
  await settle();
  take();
  sends.length = 0;
  let ys = 0;
  onPost = (m) => {
    if (m.type !== 'channel' || m.id !== Y) return;
    ys++;
    if (ys === 1) send({ type: 'openResult', channel: Y, id: YR }); // Y is read again from scratch while it loads
    if (ys === 2) {
      onPost = null;
      send({ type: 'send', text: 'later still', mentions: [], thread: R2, channel: D1 }); // the Enter typed in the note
    }
  };
  send({ type: 'select', id: Y });
  await settle();
  ok(
    "B2. a second clear while the new channel loads does not forget where the note's threads live",
    ys === 2 && sends.length === 1 && sends[0].ch === D2 && sends[0].replyTo === R2,
    { selectsOfY: ys, sends: route() },
  );

  // ---------------------------------------------------------------- C. Enter a moment earlier: the controller switched, its messages not cleared yet
  await send({ type: 'select', id: D1 });
  await settle();
  await send({ type: 'openThread', id: R2 });
  await settle();
  take();
  sends.length = 0;
  send({ type: 'select', id: Y });
  while (!(c.channel && c.channel.id === Y)) await tick();
  send({ type: 'send', text: 'early reply', mentions: [], thread: R2, channel: D1 });
  await settle();
  ok('C. the same Enter before the messages were cleared goes to the same place', sends.length === 1 && sends[0].ch === D2 && sends[0].replyTo === R2, route());

  // ---------------------------------------------------------------- C2. a new thread typed in the DM note during the switch
  await send({ type: 'select', id: D1 });
  await settle();
  await send({ type: 'newThread' });
  await settle();
  take();
  sends.length = 0;
  enterDuringSwitch(Y, { type: 'send', text: 'a new thread in the note', mentions: [], thread: null, channel: D1 });
  await settle();
  ok(
    'C2. a new thread typed in the DM note during the switch starts in its newest conversation',
    sends.length === 1 && sends[0].ch === D1 && !sends[0].replyTo,
    route(),
  );

  // ---------------------------------------------------------------- D. a code chip travels with a message sent elsewhere
  await send({ type: 'select', id: D1 });
  await settle();
  await send({ type: 'openThread', id: R1 });
  await settle();
  c.addContext({ kind: 'code', relPath: 'a.ts', startLine: 1, endLine: 2, languageId: 'ts', code: 'let x = 1;' });
  take();
  sends.length = 0;
  enterDuringSwitch(Y, { type: 'send', text: 'with chip', mentions: [], thread: R1, channel: D1 });
  await settle();
  m = take();
  ok(
    'D. a chip goes with the message sent to the channel on screen',
    sends.length === 1 && sends[0].ch === D1 && /```/.test(sends[0].content) && /let x = 1;/.test(sends[0].content),
    route(),
  );
  const ctx = lastOf(m, 'contexts');
  ok("D. the chip leaves the composer and 'sent' carries the text", !!ctx && ctx.items.length === 0 && (lastOf(m, 'sent') || {}).text === 'with chip', {
    ctx,
    sent: lastOf(m, 'sent'),
  });

  // ---------------------------------------------------------------- E. Enter just before the switch (the normal path), @agent: nothing awaited in the new channel
  data[Y] = []; // the channel picked has no threads: its view is "New thread"
  await send({ type: 'select', id: D1 });
  await settle();
  await send({ type: 'newThread' });
  await settle();
  take();
  sends.length = 0;
  send({ type: 'select', id: Y });
  send({ type: 'send', text: '@agent a new thread in the note', mentions: [AG], thread: null, channel: D1 });
  await settle();
  await send({ type: 'newThread' }); // what the webview asks for on an empty list (wide layout)
  await settle();
  m = take();
  ok('E. a message sent just before the switch goes to the channel it was typed in', sends.length === 1 && sends[0].ch === D1, route());
  const w = lastOf(m, 'working');
  ok("E. the channel switched to does not show the agent as asked ('working' has no one)", !!w && w.items.length === 0 && w.busy.length === 0, w);
  ok('E. no answer is awaited there (no fast polling for it)', c.tracker.expecting === false && c.expectUntil <= Math.floor(Date.now() / 1000), {
    expecting: c.tracker.expecting,
    expectUntilIn: c.expectUntil - Math.floor(Date.now() / 1000),
  });
  await sleep(2800); // a poll while expecting would come every 2.5 s
  m = take();
  const w2 = lastOf(m, 'working');
  ok('E. still nobody shown as asked after a poll interval', !w2 || (w2.items.length === 0 && w2.busy.length === 0), w2);
  data[Y] = [mk(YR, Y, now - 50, 'y root', P)];

  // ---------------------------------------------------------------- E2. an offline agent asked, then another channel picked at once
  agentOnline = false;
  await send({ type: 'select', id: D1 });
  await settle(); // the members and their presence are read with the channel: the agent is offline now
  await send({ type: 'newThread' });
  await settle();
  take();
  sends.length = 0;
  send({ type: 'send', text: '@agent are you there?', mentions: [AG], thread: null, channel: D1 });
  send({ type: 'select', id: Y });
  await settle();
  m = take();
  ok(
    'E2. asking an offline agent says so, even when another channel was picked while the message went',
    sends.length === 1 && ofType(m, 'toast').some((x) => /agent/.test(x.message)),
    { sends: route(), toasts: ofType(m, 'toast') },
  );
  agentOnline = true;

  // ---------------------------------------------------------------- F. the channel typed in is gone from the list
  dmListed = false;
  await send({ type: 'select', id: D1 });
  await settle();
  take();
  sends.length = 0;
  enterDuringSwitch(Y, { type: 'send', text: 'to a gone channel', mentions: [], thread: null, channel: D1 });
  await send({ type: 'refresh' }); // the list is read again: the DM is gone, Y is picked
  await settle();
  m = take();
  ok('F. a message typed in a channel that left the list is not sent anywhere', sends.length === 0, route());
  ok(
    "F. the user is told, and the composer keeps the text (no 'sent'), unlocked",
    ofType(m, 'error').some((x) => /no longer in the list/.test(x.message)) && !ofType(m, 'sent').length && lastOf(m, 'sending').on === false,
    m.filter((x) => x.type === 'error' || x.type === 'sent' || x.type === 'sending'),
  );
  dmListed = true;
  await send({ type: 'refresh' });
  await settle();

  // ---------------------------------------------------------------- G. a webview message without the channel (the fallback)
  await send({ type: 'select', id: D1 });
  await settle();
  await send({ type: 'openThread', id: R2 });
  await settle();
  take();
  sends.length = 0;
  await send({ type: 'send', text: 'no channel field', mentions: [] });
  await settle();
  ok('G. without the channel field the open thread decides, as before', sends.length === 1 && sends[0].ch === D2 && sends[0].replyTo === R2, route());

  // ---------------------------------------------------------------- H. away and straight back to the same note
  take();
  sends.length = 0;
  send({ type: 'select', id: Y });
  send({ type: 'select', id: D1 });
  await settle();
  await send({ type: 'openThread', id: R2 });
  await settle();
  await send({ type: 'send', text: 'after coming back', mentions: [], thread: R2, channel: D1 });
  await settle();
  ok(
    "H. after a switch away and back, a reply still goes into the thread's conversation",
    sends.length === 1 && sends[0].ch === D2 && sends[0].replyTo === R2,
    route(),
  );

  c.dispose();
  await sleep(50);
  ok('no unhandled rejection, uncaught exception or rejected message handler', stray.length === 0, stray);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('FAIL the harness itself threw  ' + ((e && e.stack) || e));
  process.exit(1);
});
