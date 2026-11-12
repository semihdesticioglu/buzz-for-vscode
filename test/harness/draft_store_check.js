// The extension's side of drafts: the real ChatController (out/chat.js) keeps what the webview sends in workspaceState,
// checked, and hands it to every webview that opens (the side bar and the editor tab share it; a reload keeps it).
//   node test/harness/draft_store_check.js [repo]
const Module = require('module');
const path = require('path');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');

let pass = 0;
let fail = 0;
const stray = [];
process.on('unhandledRejection', (e) => stray.push('unhandledRejection: ' + ((e && e.stack) || e)));
const ok = (name, cond, info) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info)));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { Active: -1, Beside: -2 },
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
const CH = hex('c1');
const now = Math.floor(Date.now() / 1000);
const client = {
  myPubkey: ME,
  me: async () => ({ pubkey: ME }),
  allChannels: async () => [{ id: CH, name: 'general', isDm: false }],
  messages: async () => [{ id: hex('a1'), pubkey: ME, kind: 9, created_at: now - 10, content: 'hello', tags: [['h', CH]] }],
  thread: async () => [],
  send: async () => ({ event_id: hex('e1'), accepted: true }),
  members: async () => [],
  presence: async () => ({}),
  nameOf: () => 'me',
  isAgent: () => false,
  ensureProfiles: async () => undefined,
  search: async () => [],
};
const live = {
  onEvent: () => disp,
  onState: () => disp,
  subscribe: noop,
  unsubscribe: noop,
  state: { state: 'off' },
  isLive: false,
  publish: noop,
  fetch: async () => undefined,
};
// one workspaceState for the window: what the side bar and the editor tab share
const store = new Map();
const writes = [];
const ext = {
  workspaceState: { get: (k) => store.get(k), update: async (k, v) => (writes.push([k, v]), store.set(k, v)) },
  globalState: { get: () => undefined, update: async () => undefined },
  extensionUri: { toString: () => '' },
};
function host(kind) {
  const posted = [];
  let onMsg;
  const c = new ChatController(ext, client, live, {}, {}, { available: false });
  c.attach({
    kind,
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
  return { c, posted, msg: (m) => onMsg(m) };
}

(async () => {
  // ---------------------------------------------------------------- the side bar
  const side = host('view');
  await side.msg({ type: 'ready' });
  await sleep(100);
  const types = side.posted.map((m) => m.type);
  const first = side.posted.find((m) => m.type === 'drafts');
  ok('on ready the webview gets the drafts (none yet)', !!first && JSON.stringify(first.items) === '{}', first);
  // the webview asks for the first thread itself once the list is there: the drafts are in before the channel and its list
  ok(
    'before the channel and its thread list',
    types.indexOf('drafts') >= 0 && types.indexOf('drafts') < types.indexOf('channel') && types.indexOf('drafts') < types.indexOf('threads'),
    types,
  );

  const T1 = CH + ':' + hex('a1');
  await side.msg({
    type: 'drafts',
    items: {
      [T1]: { text: 'half a reply', mentions: [['Ada', hex('ad')]], replyTo: { id: hex('a1'), author: 'me', snippet: 'hello' }, at: 2000 },
      [CH + ':new']: { text: 'a new thread', at: 1000 },
      'x:empty': { text: '   ', at: 3000 },
      'x:broken': { text: 42, at: 3000 },
      'x:junk': 'not a draft',
    },
  });
  const saved = store.get('buzz.drafts');
  ok(
    'the drafts are kept in the workspace state',
    !!saved && Object.keys(saved).sort().join() === [CH + ':new', T1].sort().join(),
    saved && Object.keys(saved),
  );
  ok('with their mentions and reply target', !!saved && saved[T1].mentions[0][0] === 'Ada' && saved[T1].replyTo.id === hex('a1'), saved && saved[T1]);
  ok('empty and malformed ones are dropped', !!saved && !saved['x:empty'] && !saved['x:broken'] && !saved['x:junk'], saved);

  // more than 30: the newest are kept
  const many = {};
  for (let i = 0; i < 40; i++) many['k' + i] = { text: 't' + i, at: i };
  await side.msg({ type: 'drafts', items: many });
  const capped = store.get('buzz.drafts');
  ok('at most 30 drafts are kept, the newest', Object.keys(capped).length === 30 && !!capped.k39 && !capped.k9 && !!capped.k10, Object.keys(capped).length);
  const big = { k: { text: 'x'.repeat(200000), at: 1 } };
  await side.msg({ type: 'drafts', items: big });
  ok('a draft longer than a message can be is cut to 64 KB', store.get('buzz.drafts').k.text.length === 65536, store.get('buzz.drafts').k.text.length);
  await side.msg({ type: 'drafts', items: 'nonsense' });
  ok(
    'a malformed drafts message stores nothing rather than throwing',
    JSON.stringify(store.get('buzz.drafts')) === '{}' && !side.posted.some((m) => m.type === 'error'),
    store.get('buzz.drafts'),
  );

  // ---------------------------------------------------------------- the editor tab (⤢) and a reload read the same store
  await side.msg({ type: 'drafts', items: { [T1]: { text: 'typed in the side bar', at: 5 } } });
  side.c.dispose();
  const tab = host('panel');
  await tab.msg({ type: 'ready' });
  await sleep(100);
  const got = tab.posted.find((m) => m.type === 'drafts');
  ok('the editor tab opens with the drafts typed in the side bar', !!got && got.items[T1] && got.items[T1].text === 'typed in the side bar', got);
  tab.c.dispose();
  // something else wrote junk under the key (an older build, a hand edit): read back checked
  store.set('buzz.drafts', { a: { text: 'fine', at: 1 }, b: null, c: { text: 7 } });
  const again = host('view');
  await again.msg({ type: 'ready' });
  await sleep(100);
  const got2 = again.posted.find((m) => m.type === 'drafts');
  ok('what is read back is checked too', !!got2 && JSON.stringify(Object.keys(got2.items)) === '["a"]', got2);
  again.c.dispose();

  ok('no unhandled rejection', stray.length === 0, stray);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('FAIL the harness itself threw  ' + ((e && e.stack) || e));
  process.exit(1);
});
