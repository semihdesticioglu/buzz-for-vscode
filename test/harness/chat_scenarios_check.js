// Race and error scenarios of the real ChatController (out/chat.js) with a fake vscode module and a fake Buzz client:
// an unknown channel or a missing thread, a stale "Load older" or late answers from a channel the user has left, a
// thread root that arrives live before the CLI returns, refused and too-long sends, deletions (only the author's
// own count) and a disposed controller.
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
const AG = hex('ag');
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
    return [{ pubkey: ch === A ? hex('ma') : hex('mb'), name: ch === A ? 'memberA' : 'memberB', isAgent: true }];
  },
  presence: async () => ({}),
  nameOf: (pk) => (pk === ME ? 'me' : 'agent'),
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
const lastOf = (msgs, type) => [...msgs].reverse().find((m) => m.type === type);
let pass = 0;
const ok = (name, cond, info) => {
  if (cond) pass++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info).slice(0, 300)));
};

(async () => {
  await onMsg({ type: 'ready' });
  await sleep(150);
  take();

  // 1. a channel that is not in the list: no fallback to another channel
  await c.openChannel('chX', hex('zz'));
  let m = take();
  ok(
    'unknown channel: toast, no channel switch',
    m.some((x) => x.type === 'toast') && !m.some((x) => x.type === 'channel'),
    m.map((x) => x.type),
  );

  // 2. a deleted / unreachable thread: a notice instead of an endless "Loading"
  await c.openChannel(A, hex('dead'));
  m = take();
  const th = lastOf(m, 'thread');
  ok('missing thread: notice, not an empty thread', th && th.id === null && /could not be opened/.test(th.notice || ''), th);

  // 3. "Load older" in A, then switch to B before it returns: B's list stays B's
  delay.older = 200;
  const older = onMsg({ type: 'older' });
  await sleep(20);
  await c.openChannel(B);
  await older;
  await sleep(50);
  m = take();
  const lastThreads = lastOf(m, 'threads');
  ok(
    'stale "Load older" does not leak into another channel',
    lastThreads && lastThreads.channelId === B && lastThreads.items.every((t) => t.id.startsWith('b1')),
    lastThreads && lastThreads.items.map((t) => t.id.slice(0, 2)),
  );
  delay.older = 50;

  // 4. the "Load older" cursor is the page, not an old root opened meanwhile
  await c.openChannel(A);
  await sleep(50);
  take();
  await onMsg({ type: 'older' });
  m = take();
  ok(
    '"Load older" brings the next page',
    lastOf(m, 'threads').items.some((t) => t.id.startsWith('a0')),
    lastOf(m, 'threads').items.map((t) => t.id.slice(0, 2)),
  );

  // 5. late members() of A does not overwrite B
  delay.membersA = 300;
  await c.openChannel(B); // B is on screen
  await c.openChannel(A); // A's members are slow
  await c.openChannel(B);
  await sleep(400);
  m = take();
  const mem = lastOf(m, 'members');
  ok('late members of another channel are ignored', mem && mem.items[0].name === 'memberB', mem);
  delay.membersA = 10;

  // 6. a new thread whose root arrives live before the CLI returns opens at once
  await c.openChannel(A);
  await sleep(50);
  await onMsg({ type: 'newThread' });
  take();
  await onMsg({ type: 'send', text: '@agent hello', mentions: [AG], replyTo: undefined });
  await sleep(200);
  m = take();
  const opened = m.filter((x) => x.type === 'thread' && x.id);
  ok(
    'new thread opens even when the root arrives before the CLI returns',
    opened.length && opened[opened.length - 1].id === sent[sent.length - 1].id,
    m.map((x) => x.type + (x.id ? ':' + x.id.slice(0, 2) : '')),
  );
  const sentMsg = lastOf(m, 'sent');
  ok('"sent" carries the sent text', sentMsg && sentMsg.text === '@agent hello', sentMsg);
  ok('composer unlocked after send', lastOf(m, 'sending') && lastOf(m, 'sending').on === false);

  // 7. a refused message: error shown, composer unlocked, nothing cleared
  sendResult = { event_id: hex('rj'), accepted: false, message: 'rate-limited' };
  await onMsg({ type: 'send', text: 'again', mentions: [] });
  m = take();
  ok(
    'refused send: error, unlocked, composer kept',
    m.some((x) => x.type === 'error' && /rate-limited/.test(x.message)) && !m.some((x) => x.type === 'sent') && lastOf(m, 'sending').on === false,
    m.map((x) => x.type),
  );
  sendResult = null;

  // 8. too long: refused before sending, composer still unlocked
  await onMsg({ type: 'send', text: 'x'.repeat(70000), mentions: [] });
  m = take();
  ok(
    'too-long message: unlocked again',
    lastOf(m, 'sending') && lastOf(m, 'sending').on === false,
    m.map((x) => x.type),
  );

  // 9. a live message of A queued just before switching to B is not added to B
  onLive('LIVE', ev('lq', A, Math.floor(Date.now() / 1000), 'late A message'));
  await c.openChannel(B);
  await sleep(250);
  m = take();
  const tb = lastOf(m, 'threads');
  ok(
    "A's queued live message stays out of B",
    tb && tb.channelId === B && !tb.items.some((t) => t.id.startsWith('lq')),
    tb && tb.items.map((t) => t.id.slice(0, 2)),
  );

  // 10. a deletion (kind 5) by someone else does not remove my message
  await c.openChannel(A);
  await sleep(500); // the list fills itself with more pages first
  take();
  const other = Object.keys(subs).find((k) => k.endsWith('-other'));
  onLive(other, {
    id: hex('d1'),
    pubkey: hex('bb'),
    kind: 5,
    created_at: now,
    content: '',
    tags: [
      ['h', A],
      ['e', hex('a1')],
    ],
  });
  await sleep(20);
  m = take();
  ok(
    "someone else's kind-5 deletion is ignored",
    !m.some((x) => x.type === 'threads'),
    m.map((x) => x.type),
  );
  onLive(other, {
    id: hex('d2'),
    pubkey: hex('aa'),
    kind: 5,
    created_at: now,
    content: '',
    tags: [
      ['h', A],
      ['e', hex('a1')],
    ],
  });
  await sleep(20);
  m = take();
  const t10 = lastOf(m, 'threads');
  ok("the author's own deletion removes it", t10 && !t10.items.some((t) => t.id.startsWith('a1')), t10 && t10.items.map((t) => t.id.slice(0, 2)));

  // 11. after dispose, a reload does nothing (no new subscriptions)
  const before = JSON.stringify(subs);
  c.dispose();
  await c.reload();
  ok('disposed controller does not reload or subscribe', JSON.stringify(subs) === before || Object.keys(subs).length === 0);

  console.log(`\n${pass} checks passed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
