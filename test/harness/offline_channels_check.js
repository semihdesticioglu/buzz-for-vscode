// The agents-offline bar on the controller side: the real ChatController (out/chat.js) with a fake vscode module and
// a fake Buzz client. The bar names the channel's agents when all of them are offline and goes when they are back,
// mentioning an offline agent warns, "Open Buzz Desktop" and "+" (the channel menu) run their commands, and
// someone Buzz no longer lists is not shown online.
const Module = require('module');
const path = require('path');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');

const noop = () => undefined;
const disp = { dispose: noop };
const executed = [];
let desktopResult = true;
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
  commands: {
    executeCommand: async (cmd) => {
      executed.push(cmd);
      return cmd === 'buzz.openDesktop' ? desktopResult : undefined;
    },
    registerCommand: () => disp,
  },
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
const A1 = hex('a1');
const A2 = hex('a2');
const P1 = hex('b1');
const names = { [ME]: 'me', [A1]: 'lead_agent', [A2]: 'qa_agent', [P1]: 'Ada' };
let presenceMap = { [A1]: 'offline', [A2]: 'offline', [P1]: 'online' };
const client = {
  myPubkey: ME,
  me: async () => ({}),
  channels: async () => [{ id: 'A', name: 'a', isDm: false }],
  allChannels: async () => [{ id: 'A', name: 'a', isDm: false }],
  dms: async () => [],
  messages: async () => [],
  thread: async () => [],
  send: async () => ({ event_id: hex('s1'), accepted: true }),
  members: async () => [
    { pubkey: A1, name: 'lead_agent', isAgent: true },
    { pubkey: A2, name: 'qa_agent', isAgent: true },
    { pubkey: P1, name: 'Ada', isAgent: false },
  ],
  // as the real CLI: only who has a live presence entry is listed; offline people are left out of the answer
  presence: async () => Object.fromEntries(Object.entries(presenceMap).filter(([, s]) => s !== 'offline')),
  nameOf: (pk) => names[pk] || pk.slice(0, 6),
  isAgent: (pk) => pk === A1 || pk === A2,
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
const lastOffline = () => [...posted].reverse().find((m) => m.type === 'agentsOffline');

(async () => {
  await onMsg({ type: 'ready' });
  await sleep(300);
  let m = lastOffline();
  ok(
    'every agent of the channel offline -> the bar, with the agents by name',
    m && m.offline === true && JSON.stringify(m.names) === JSON.stringify(['lead_agent', 'qa_agent']),
    m,
  );
  ok('the controller exposes the open channel for the channel menu', c.channel && c.channel.id === 'A', c.channel);

  posted.length = 0;
  await onMsg({ type: 'send', text: '@lead_agent can you look?', mentions: [A1], thread: null });
  await sleep(200);
  ok(
    'mentioning an offline agent -> a toast says it is offline',
    posted.some((x) => x.type === 'toast' && /lead_agent/.test(x.message) && /offline/i.test(x.message)),
    posted.filter((x) => x.type === 'toast'),
  );
  ok('no "working…" guess for an agent that is offline', !posted.some((x) => x.type === 'working' && x.items.some((i) => i.name === 'lead_agent')));

  posted.length = 0;
  await onMsg({ type: 'refresh' });
  await sleep(300);
  ok(
    'an unchanged state is not posted again',
    !posted.some((x) => x.type === 'agentsOffline'),
    posted.filter((x) => x.type === 'agentsOffline'),
  );

  posted.length = 0;
  await onMsg({ type: 'openDesktop' });
  await sleep(100);
  ok('"Open Buzz Desktop" runs the command', executed.includes('buzz.openDesktop'), executed);
  presenceMap = { [A1]: 'online', [A2]: 'online', [P1]: 'online' };
  await sleep(4400); // the first look after starting Buzz Desktop comes at 4 s
  m = lastOffline();
  ok('agents back online -> the bar goes away', m && m.offline === false, m);

  // the start fails (not found, cancelled): the bar gets its button back
  presenceMap = { [A1]: 'offline', [A2]: 'offline', [P1]: 'online' };
  posted.length = 0;
  await onMsg({ type: 'refresh' });
  await sleep(300);
  ok('agents offline again -> the bar is back', lastOffline() && lastOffline().offline === true);
  desktopResult = false;
  posted.length = 0;
  await onMsg({ type: 'openDesktop' });
  await sleep(100);
  ok(
    'a start that did not happen re-posts the bar (button back)',
    posted.some((x) => x.type === 'agentsOffline' && x.offline === true),
    posted,
  );

  // someone online a moment ago whose entry lapsed (Buzz Desktop closed): left out of the answer -> not online
  presenceMap = { [A1]: 'offline', [A2]: 'offline', [P1]: 'online' };
  await onMsg({ type: 'refresh' });
  await sleep(300);
  presenceMap = { [A1]: 'offline', [A2]: 'offline', [P1]: 'offline' };
  posted.length = 0;
  await onMsg({ type: 'refresh' });
  await sleep(300);
  const lastPresence = [...posted].reverse().find((x) => x.type === 'presence');
  ok(
    'a person Buzz no longer lists (gone offline) is not shown online any more',
    !!lastPresence && lastPresence.map[P1] !== 'online' && lastPresence.map[A1] === 'offline',
    lastPresence && lastPresence.map,
  );

  executed.length = 0;
  await onMsg({ type: 'channelMenu' });
  ok('"+" opens the channel menu command', executed.includes('buzz.channelMenu'), executed);

  c.dispose();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
