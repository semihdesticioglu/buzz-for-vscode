// Mention notifications (out/mentions.js) with a fake vscode module, a fake Buzz client and a fake live connection:
// history is not announced on the first run; a new mention is announced once, whether polling or the live connection
// brings it first, with who, where and what; a second mention in the same second is not lost and none is repeated; my
// own messages are not announced; a window in the background waits for focus and drops what another window already
// showed; Open goes to the message; buzz.mentionSeconds 0 turns it all off; a failed read is retried quietly; dispose
// stops everything.
//   node test/harness/mentions_check.js [repo]
const Module = require('module');
const path = require('path');
const PROJ = process.argv[2] || path.resolve(__dirname, '..', '..');

const noop = () => undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(40);
const hex = (s) => (s + '0'.repeat(64)).slice(0, 64);

// ------------------------------------------------------------------------------ fake vscode
const settings = { mentionSeconds: 3600 }; // rounds are started by hand with start(0); the timer itself never fires
let focused = true;
const toasts = []; // every notification: { msg, items }
let answer = () => undefined; // what the user clicks on a notification (undefined: closes it)
const errors = [];
const commands = [];
let failCommand = false;
const bars = [];
const listen = (list) => (cb) => {
  list.push(cb);
  return {
    dispose: () => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
  };
};
const windowState = []; // one listener per window (MentionWatcher)

const fakeVscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  ThemeIcon: class {},
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose: noop });
    }
    fire() {}
    dispose() {}
  },
  Uri: { file: (p) => ({ fsPath: p, path: p }), joinPath: (...a) => ({ fsPath: a.join('/'), path: a.join('/') }) },
  env: { language: 'en' },
  window: {
    createStatusBarItem: () => {
      const b = {
        text: '',
        tooltip: '',
        command: '',
        visible: false,
        disposed: false,
        show() {
          this.visible = true;
        },
        dispose() {
          this.disposed = true;
        },
      };
      bars.push(b);
      return b;
    },
    onDidChangeWindowState: listen(windowState),
    get state() {
      return { focused };
    },
    showInformationMessage: async (msg, ...items) => {
      toasts.push({ msg, items });
      return answer(msg, items);
    },
    showErrorMessage: async (msg) => void errors.push(msg),
    showWarningMessage: async () => undefined,
    createOutputChannel: () => ({ appendLine: noop }),
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d), update: async () => undefined }),
    onDidChangeConfiguration: () => ({ dispose: noop }),
  },
  commands: {
    executeCommand: async (...a) => {
      commands.push(a);
      if (failCommand) throw new Error('command failed');
    },
    registerCommand: () => ({ dispose: noop }),
  },
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') return fakeVscode;
  return origLoad.apply(this, arguments);
};

const { t } = require(path.join(PROJ, 'out', 'i18n.js'));
const { CHANNEL_MESSAGE_KINDS } = require(path.join(PROJ, 'out', 'core.js'));
const { MentionWatcher } = require(path.join(PROJ, 'out', 'mentions.js'));

// ------------------------------------------------------------------------------ fake Buzz and live connection
const ME = hex('ee');
const ADA = hex('ad');
const NAMES = { [ME]: 'me', [ADA]: 'Ada' };

/** Global state shared by every VS Code window, as VS Code's own is. */
function memento() {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => void m.set(k, v) };
}

/** The CLI's `feed get --since`: every mention at or after `since`, newest rows included as they are added. */
function fakeClient() {
  return {
    myPubkey: undefined,
    rows: [],
    feedCalls: 0,
    feedError: undefined,
    channelsFail: false,
    async me() {
      this.myPubkey = ME;
      return { pubkey: ME, name: 'me' };
    },
    async feed(since) {
      this.feedCalls++;
      if (this.feedError) throw this.feedError;
      return this.rows.filter((e) => e.created_at >= since);
    },
    ensureProfiles: async () => undefined,
    nameOf: (pk) => NAMES[pk] || pk.slice(0, 8),
    async allChannels() {
      if (this.channelsFail) throw new Error('relay unreachable');
      return [
        { id: 'ch-data', name: 'data-dev' },
        { id: 'dm-ada', ids: ['dm-ada', 'dm-ada-old'], name: 'Ada', isDm: true },
      ];
    },
  };
}

function fakeLive() {
  const events = [];
  const states = [];
  return {
    isLive: false,
    subs: {},
    unsubscribed: [],
    onEvent: listen(events),
    onState: listen(states),
    subscribe(id, filters) {
      this.subs[id] = filters;
    },
    unsubscribe(id) {
      delete this.subs[id];
      this.unsubscribed.push(id);
    },
    emit: (id, ev) => events.slice().forEach((f) => f(id, ev)),
    setState: (s) => states.slice().forEach((f) => f(s)),
  };
}

const mention = (id, at, content, o = {}) => ({
  id: hex(id),
  pubkey: o.from || ADA,
  kind: 9,
  created_at: at,
  content,
  tags: [...(o.ch === null ? [] : [['h', o.ch || 'ch-data']]), ['p', ME]],
});

let pass = 0;
let fail = 0;
const ok = (name, cond, info) => {
  if (cond) pass++;
  else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info).slice(0, 400)));
};
const round = async (w) => {
  w.start(0);
  await settle();
};
const count = (bar) => Number((/Buzz (\d+)/.exec(bar.text) || [0, 0])[1]);
const last = (list) => list[list.length - 1];

(async () => {
  const ctx = { globalState: memento() };
  const client = fakeClient();
  const live = fakeLive();
  const w = new MentionWatcher(ctx, client, live);
  const bar = bars[0];

  // ---------------------------------------------------------------------------- polling
  const now = Math.floor(Date.now() / 1000);
  client.rows = [mention('old1', now - 3600, 'an old mention'), mention('old2', now - 60, 'another old one')];
  await round(w);
  const start = ctx.globalState.get('buzz.mentionCursor');
  ok(
    'the first run announces no history: it only stores where to start reading',
    toasts.length === 0 && client.feedCalls === 0 && !!start && start.since >= now && start.ids.length === 0 && bar.visible,
    { toasts, start },
  );

  const T = start.since;
  client.rows.push(mention('n1', T + 1, 'Can you   look at\nthe ranking query?'));
  await round(w);
  ok(
    'a new mention shows one notification with who, where and what, and counts on the status bar',
    toasts.length === 1 &&
      toasts[0].msg === 'Buzz · Ada · #data-dev: Can you look at the ranking query?' &&
      toasts[0].items.join() === t('mention.open') &&
      bar.text === '$(bell-dot) Buzz 1',
    { toasts, bar: bar.text },
  );

  await round(w);
  ok('the same mention read again is not announced twice', toasts.length === 1, toasts.length);

  client.rows.push(mention('n2', T + 1, 'One more thing, same second'));
  await round(w);
  ok(
    'a second mention in the same second is still announced, not lost',
    toasts.length === 2 && toasts[1].msg.endsWith('One more thing, same second') && count(bar) === 2,
    { toasts: toasts.slice(1), bar: bar.text },
  );

  client.rows.push(mention('mine', T + 2, 'I mention myself', { from: ME }));
  await round(w);
  ok('my own messages are not announced', toasts.length === 2, toasts.slice(2));

  client.rows.push(mention('m1', T + 3, 'first'), mention('m2', T + 5, 'newest of three'), mention('m3', T + 4, 'second'));
  await round(w);
  ok(
    'several new mentions make one notification that names the newest, and all of them count',
    toasts.length === 3 && toasts[2].msg === 'Buzz · ' + t('mention.many', 3, 'Ada · #data-dev: newest of three') && count(bar) === 5,
    { toast: toasts[2], bar: bar.text },
  );

  client.rows.push(mention('long', T + 6, 'x'.repeat(300)));
  await round(w);
  ok(
    'a long message is cut to 120 characters in the notification',
    toasts.length === 4 && toasts[3].msg === 'Buzz · Ada · #data-dev: ' + 'x'.repeat(120),
    toasts[3],
  );

  client.rows.push(mention('dm1', T + 7, 'ping in a DM', { ch: 'dm-ada-old' }));
  await round(w);
  ok(
    'a mention in a direct message is named after the person, also in an older conversation of the same DM',
    toasts.length === 5 && toasts[4].msg === 'Buzz · Ada · Ada: ping in a DM',
    toasts[4],
  );

  client.channelsFail = true;
  client.rows.push(mention('nc', T + 8, 'channel list unavailable', { ch: 'ch-new' }));
  await round(w);
  ok(
    'when the channel list cannot be read, the notification still shows, without the channel',
    toasts.length === 6 && toasts[5].msg === 'Buzz · Ada: channel list unavailable',
    toasts[5],
  );
  client.channelsFail = false;

  // ---------------------------------------------------------------------------- Open
  answer = () => t('mention.open');
  client.rows.push(mention('op', T + 9, 'open me'));
  await round(w);
  ok(
    'Open goes to the message in its channel and clears the count',
    JSON.stringify(last(commands)) === JSON.stringify(['buzz.openChannel', 'ch-data', hex('op')]) && bar.text === '$(comment-discussion) Buzz',
    { command: last(commands), bar: bar.text },
  );

  client.rows.push(mention('nochan', T + 10, 'no channel tag', { ch: null }));
  await round(w);
  ok('a mention without a channel opens the chat', JSON.stringify(last(commands)) === JSON.stringify(['buzz.showChat']), last(commands));

  failCommand = true;
  client.rows.push(mention('cf', T + 11, 'the command fails'));
  await round(w);
  ok('if opening fails, an error message says so', errors.length === 1 && /^Buzz: /.test(errors[0]), errors);
  failCommand = false;
  answer = () => undefined;

  // ---------------------------------------------------------------------------- a failed read
  client.feedError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
  const before = { toasts: toasts.length, errors: errors.length, calls: client.feedCalls };
  settings.mentionSeconds = 0.1;
  w.settingsChanged();
  await sleep(700);
  settings.mentionSeconds = 3600;
  w.settingsChanged();
  ok(
    'a failed read is tried again on the next round, without a notification or an error',
    client.feedCalls - before.calls >= 2 && toasts.length === before.toasts && errors.length === before.errors,
    { reads: client.feedCalls - before.calls, toasts: toasts.slice(before.toasts), errors },
  );
  client.feedError = undefined;

  // ---------------------------------------------------------------------------- live
  live.isLive = true;
  live.setState({ state: 'live' });
  await settle();
  const f = live.subs.mentions && live.subs.mentions[0];
  ok(
    'when the live connection is up, it subscribes to new messages that mention me',
    !!f &&
      JSON.stringify(f.kinds) === JSON.stringify(CHANNEL_MESSAGE_KINDS) &&
      JSON.stringify(f['#p']) === JSON.stringify([ME]) &&
      Math.abs(f.since - Math.floor(Date.now() / 1000)) <= 2,
    f,
  );

  const L1 = mention('live1', T + 20, 'over the live connection');
  const t0 = toasts.length;
  live.emit('mentions', L1);
  live.emit('mentions', L1); // a relay may deliver it twice
  await settle();
  client.rows.push(L1);
  await round(w); // and the next poll reads it too
  ok(
    'a mention that arrives live is announced once, also when it comes twice and the next poll reads it again',
    toasts.length === t0 + 1 && toasts[t0].msg.endsWith('over the live connection'),
    toasts.slice(t0),
  );

  live.emit('mentions', mention('live-mine', T + 21, 'my own, live', { from: ME }));
  live.emit('other', mention('live-other', T + 22, 'from another subscription'));
  await settle();
  ok('live events of my own, or of another subscription, are not announced', toasts.length === t0 + 1, toasts.slice(t0 + 1));

  // ---------------------------------------------------------------------------- windows in the background
  focused = false;
  const t1 = toasts.length;
  const c1 = count(bar);
  live.emit('mentions', mention('bg', T + 30, 'while you were away'));
  await settle();
  const waited = toasts.length === t1 && count(bar) === c1 + 1;
  focused = true;
  windowState[0]({ focused: true });
  await settle();
  ok(
    'a window in the background counts the mention at once and shows it when it gets focus',
    waited && toasts.length === t1 + 1 && toasts[t1].msg.endsWith('while you were away'),
    { waited, toasts: toasts.slice(t1) },
  );

  const live2 = fakeLive();
  const w2 = new MentionWatcher(ctx, client, live2); // a second VS Code window: its own live connection, the same global state
  const both = mention('both', T + 40, 'seen by two windows');
  const t2 = toasts.length;
  focused = false;
  live2.emit('mentions', both); // the second window is in the background
  await settle();
  focused = true;
  live.emit('mentions', both); // the first window is in front and shows it
  await settle();
  windowState[1]({ focused: true }); // then the second window comes to the front
  await settle();
  ok('a notification another window already showed is not shown again when this window gets focus', toasts.length === t2 + 1, toasts.slice(t2));

  // ---------------------------------------------------------------------------- turning it off, and dispose
  const t3 = toasts.length;
  settings.mentionSeconds = 0;
  w.settingsChanged();
  const calls0 = client.feedCalls;
  w.start(0);
  live.emit('mentions', mention('off', T + 50, 'while notifications are off'));
  await settle();
  ok(
    'buzz.mentionSeconds 0 turns notifications off: no reading, no live subscription, nothing shown',
    !live.subs.mentions && live.unsubscribed.includes('mentions') && client.feedCalls === calls0 && toasts.length === t3,
    { subs: live.subs, reads: client.feedCalls - calls0, toasts: toasts.slice(t3) },
  );
  settings.mentionSeconds = 3600;
  w.settingsChanged();
  await settle();
  ok('switched back on, it subscribes again', !!live.subs.mentions, live.subs);

  w.dispose();
  w2.dispose();
  const calls1 = client.feedCalls;
  const t4 = toasts.length;
  w.start(0);
  live.emit('mentions', mention('after', T + 60, 'after dispose'));
  await settle();
  ok(
    'after dispose nothing reads, listens or shows, and the status bar item is gone',
    client.feedCalls === calls1 && toasts.length === t4 && bar.disposed && !live.subs.mentions,
    { reads: client.feedCalls - calls1, toasts: toasts.slice(t4), bar: bar.disposed, subs: live.subs },
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('FAIL the harness itself: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
