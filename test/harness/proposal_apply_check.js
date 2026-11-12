// Applying an agent's proposal to the workspace (out/proposals.js) with a fake vscode module that keeps the workspace's
// files and open documents in memory. The safety rules under test: only paths inside the workspace and outside .git are
// written; a line-number proposal for a file changed since the message asks first; a file that changes while the user
// answers is not overwritten; a diff over several files is all or nothing; the edit is left unsaved and Undo restores
// only files untouched since; Show diff never writes; and the chat (out/chat.js) applies nothing unless
// buzz.proposals.applyLocally is on.
//   node test/harness/proposal_apply_check.js [repo]
const Module = require('module');
const path = require('path');
const PROJ = process.argv[2] || path.resolve(__dirname, '..', '..');

const noop = () => undefined;
const disp = { dispose: noop };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = '\n';

// ------------------------------------------------------------------------------ an in-memory workspace folder at /ws
class Uri {
  constructor(scheme, p, query = '') {
    this.scheme = scheme;
    this.path = p;
    this.query = query;
  }
  static file(p) {
    return new Uri('file', p.replace(/\\/g, '/'));
  }
  static from(o) {
    return new Uri(o.scheme, o.path || '/', o.query || '');
  }
  static joinPath(base, ...parts) {
    return new Uri(base.scheme, path.posix.join(base.path, ...parts));
  }
  get fsPath() {
    return this.path;
  }
  toString() {
    return `${this.scheme}://${this.path}${this.query ? '?' + this.query : ''}`;
  }
}
class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class TextRange {
  constructor(a, b, c, d) {
    this.start = new Position(a, b);
    this.end = new Position(c, d);
  }
}
class WorkspaceEdit {
  constructor() {
    this.ops = [];
  }
  replace(uri, range, text) {
    this.ops.push({ op: 'replace', uri, range, text });
  }
  insert(uri, pos, text) {
    this.ops.push({ op: 'insert', uri, pos, text });
  }
  createFile(uri) {
    this.ops.push({ op: 'create', uri });
  }
  deleteFile(uri) {
    this.ops.push({ op: 'delete', uri });
  }
}

const HOUR_AGO = Date.now() - 3600_000;
const disk = new Map(); // path -> { text, mtime }
const opened = new Map(); // path -> the open document
const written = []; // one entry per applyEdit: its operations as "op path"
const looked = []; // every path the extension stat()ed or opened
const asked = []; // warnings shown: { msg, modal, items }
const offered = []; // information messages shown after applying
const diffs = []; // vscode.diff calls: [left, right, title]
let onWarning = () => undefined; // what the user answers a warning (undefined: closes it)
let onOffer = () => undefined; // what the user answers "Applied to … Save / Undo"
const settings = {};
const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 };

function put(rel, text, mtime = HOUR_AGO) {
  disk.set('/ws/' + rel, { text, mtime });
  opened.delete('/ws/' + rel);
}
function docFor(uri) {
  looked.push(uri.path);
  let d = opened.get(uri.path);
  if (d) return d;
  const f = disk.get(uri.path);
  if (!f) throw Object.assign(new Error('file not found: ' + uri.path), { code: 'FileNotFound' });
  d = {
    uri,
    text: f.text,
    version: 1,
    isDirty: false,
    saves: 0,
    getText() {
      return this.text;
    },
    get lineCount() {
      return this.text.split(NL).length;
    },
    lineAt(i) {
      return { text: this.text.split(NL)[i] ?? '' };
    },
    async save() {
      disk.set(this.uri.path, { text: this.text, mtime: Date.now() });
      this.isDirty = false;
      this.saves++;
      return true;
    },
  };
  opened.set(uri.path, d);
  return d;
}
const textOf = (rel) => (opened.get('/ws/' + rel) || disk.get('/ws/' + rel) || {}).text;
const onDisk = (rel) => (disk.get('/ws/' + rel) || {}).text;

const fakeVscode = {
  Uri,
  Range: TextRange,
  Position,
  WorkspaceEdit,
  Selection: class {},
  ThemeIcon: class {},
  ViewColumn: { Active: -1, Beside: -2 },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  ConfigurationTarget: { Global: 1 },
  EventEmitter: class {
    constructor() {
      this.event = () => disp;
    }
    fire() {}
    dispose() {}
  },
  env: { language: 'en', openExternal: noop },
  workspace: {
    workspaceFolders: [folder],
    getWorkspaceFolder: (u) => (u.scheme === 'file' && u.path.startsWith('/ws/') ? folder : undefined),
    getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d), update: async () => undefined }),
    onDidChangeConfiguration: () => disp,
    asRelativePath: (u) => String(u.path || u).replace(/^\/ws\//, ''),
    fs: {
      stat: async (u) => {
        looked.push(u.path);
        const f = disk.get(u.path);
        if (!f) throw Object.assign(new Error('file not found: ' + u.path), { code: 'FileNotFound' });
        return { type: 1, size: f.text.length, ctime: f.mtime, mtime: f.mtime };
      },
    },
    findFiles: async (glob) => {
      const rel = glob.replace(/^\*\*\//, '');
      return [...disk.keys()].filter((p) => p.endsWith('/' + rel) && !/\/\.git\//.test(p)).map((p) => Uri.file(p));
    },
    openTextDocument: async (u) => docFor(u),
    applyEdit: async (edit) => {
      written.push(edit.ops.map((o) => `${o.op} ${o.uri.path}`));
      for (const o of edit.ops) {
        if (o.op === 'create') {
          if (!disk.has(o.uri.path)) disk.set(o.uri.path, { text: '', mtime: Date.now() });
        } else if (o.op === 'delete') {
          disk.delete(o.uri.path);
          opened.delete(o.uri.path);
        } else {
          const d = docFor(o.uri);
          if (o.op === 'replace') {
            // proposals.ts replaces whole documents: Range(0, 0, lineCount, 0)
            if (o.range.start.line || o.range.start.character || o.range.end.line < d.lineCount) throw new Error('partial replace is not modelled');
            d.text = o.text;
          } else {
            if (o.pos.line || o.pos.character) throw new Error('insert is modelled at the start only');
            d.text = o.text + d.text;
          }
          d.version++;
          d.isDirty = true;
        }
      }
      return true;
    },
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createOutputChannel: () => ({ appendLine: noop }),
    showErrorMessage: noop,
    showWarningMessage: async (msg, ...rest) => {
      const opts = rest.length && typeof rest[0] === 'object' ? rest.shift() : {};
      asked.push({ msg, modal: !!opts.modal, items: rest });
      return onWarning(msg, rest);
    },
    showInformationMessage: async (msg, ...items) => {
      offered.push({ msg, items });
      return onOffer(msg, items);
    },
    showQuickPick: async (items) => items[0],
    showTextDocument: async () => ({ revealRange: noop }),
  },
  commands: {
    executeCommand: async (cmd, ...args) => {
      if (cmd === 'vscode.diff') diffs.push(args);
    },
    registerCommand: () => disp,
  },
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') return fakeVscode;
  return origLoad.apply(this, arguments);
};

const { t } = require(path.join(PROJ, 'out', 'i18n.js'));
const { planFor } = require(path.join(PROJ, 'out', 'patch.js'));
const { applyProposal, showProposalDiff, ProposalDocuments, PROPOSAL_SCHEME } = require(path.join(PROJ, 'out', 'proposals.js'));
const { ChatController } = require(path.join(PROJ, 'out', 'chat.js'));

let pass = 0;
let fail = 0;
const ok = (name, cond, info) => {
  if (cond) pass++;
  else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info).slice(0, 400)));
};
// the Save / Undo offer runs after applyProposal returns (it is not awaited): let it finish
const settle = () => sleep(20);
const diff = (...lines) => planFor({ index: 0, lang: 'diff', content: lines.join(NL) });
const LOAD = ['import os', '', 'def load():', '    return 1', ''].join(NL);
const SAVE = ['def save():', '    pass', ''].join(NL);
const SQL = ['select 1;', 'select 2;', 'select 3;', ''].join(NL);
const toTwo = () => diff('--- a/etl/load.py', '+++ b/etl/load.py', '@@ -3,2 +3,2 @@', ' def load():', '-    return 1', '+    return 2');
const replace2 = { kind: 'replace', path: 'sql/report.sql', start: 2, end: 2, newLines: ['select 22;'] };
const nowS = () => Math.floor(Date.now() / 1000);
const agents = { available: false, resolve: async () => [] };
// a call that throws is a failed step, not the end of the run: the checks after it still report
const apply = (...a) => applyProposal(...a).catch((e) => 'threw: ' + e.message);
const showDiff = (...a) => showProposalDiff(...a).catch((e) => 'threw: ' + e.message);

(async () => {
  // -------------------------------------------------------------------------------- applying, saving, undoing
  put('etl/load.py', LOAD);
  let o0 = offered.length;
  const r1 = await apply(toTwo());
  await settle();
  const d1 = opened.get('/ws/etl/load.py');
  ok(
    'a proposal goes into the open document unsaved: the file on disk is unchanged until the user saves',
    r1 === undefined && textOf('etl/load.py').includes('return 2') && onDisk('etl/load.py') === LOAD && d1.isDirty && d1.saves === 0,
    { r1, text: textOf('etl/load.py') },
  );
  ok(
    'Save and Undo are offered after applying',
    offered.length === o0 + 1 && offered[o0].items.join() === [t('patch.save'), t('patch.undo')].join(),
    offered.slice(o0),
  );

  put('etl/load.py', LOAD);
  onOffer = () => t('patch.undo');
  await apply(toTwo());
  await settle();
  ok('Undo puts the file back as it was', textOf('etl/load.py') === LOAD, textOf('etl/load.py'));

  put('etl/load.py', LOAD);
  onOffer = () => t('patch.save');
  await apply(toTwo());
  await settle();
  ok('Save writes the change to disk', onDisk('etl/load.py').includes('return 2') && !opened.get('/ws/etl/load.py').isDirty, onDisk('etl/load.py'));
  onOffer = () => undefined;

  let w0 = written.length;
  const r3 = await apply(toTwo());
  ok('applying the same change again is reported, and nothing is written', r3 === t('patch.alreadyApplied', 'etl/load.py') && written.length === w0, { r3 });

  put('etl/load.py', LOAD);
  let answer;
  onOffer = () => new Promise((r) => (answer = r));
  await apply(toTwo());
  const d4 = opened.get('/ws/etl/load.py');
  d4.text += '# typed after applying' + NL; // the user keeps editing before answering the offer
  d4.version++;
  let a0 = asked.length;
  answer(t('patch.undo'));
  await settle();
  ok(
    'Undo leaves a file the user edited after applying, and says so',
    textOf('etl/load.py').includes('# typed after applying') &&
      textOf('etl/load.py').includes('return 2') &&
      asked.slice(a0).some((a) => a.msg === t('patch.undoSkipped', 'etl/load.py')),
    { text: textOf('etl/load.py'), asked: asked.slice(a0) },
  );
  onOffer = () => undefined;

  // -------------------------------------------------------------------------------- where a proposal may write
  const hunk = [{ oldStart: 1, oldLines: ['a'], newLines: ['b'] }];
  const outside = ['../secrets.py', 'etl/../../x.py', 'C:\\Users\\x\\y.py', '\\\\srv\\share\\x.py', 'file:///etc/passwd'];
  w0 = written.length;
  let l0 = looked.length;
  const r5 = [];
  for (const p of outside) r5.push(await apply({ kind: 'unified', files: [{ path: p, isNew: false, hunks: hunk }] }));
  ok(
    'a path outside the workspace (.., a drive, a network share, a URI) is refused before any file is read',
    r5.every((r, i) => r === t('ref.outside', outside[i])) && written.length === w0 && looked.length === l0,
    { r5, looked: looked.slice(l0) },
  );

  put('.git/config', '[core]' + NL);
  const gitPaths = ['.git/config', 'sub/.GIT/hooks/pre-commit', '.git\\hooks\\post-checkout'];
  const hook = [{ oldStart: 0, oldLines: [], newLines: ['#!/bin/sh', 'echo hook'] }];
  const r6 = [];
  for (const p of gitPaths) r6.push(await apply({ kind: 'unified', files: [{ path: p, isNew: true, hunks: hook }] }));
  r6.push(await apply({ kind: 'replace', path: '.git/config', start: 1, end: 1, newLines: ['[core] hooksPath = x'] }));
  ok(
    'nothing is written inside .git, as a new file or as a change (any letter case, either slash)',
    r6.every((r, i) => r === t('ref.outside', [...gitPaths, '.git/config'][i])) && written.length === w0 && onDisk('.git/config') === '[core]' + NL,
    { r6 },
  );

  const dd0 = diffs.length;
  const r5b = await showDiff(new ProposalDocuments(), { kind: 'unified', files: [{ path: '../secrets.py', isNew: false, hunks: hunk }] }, 't5', agents);
  ok('Show diff refuses the same paths', r5b === t('ref.outside', '../secrets.py') && diffs.length === dd0, { r5b });

  w0 = written.length;
  const r7 = await apply(diff('--- /dev/null', '+++ b/etl/steps/new_step.py', '@@ -0,0 +1,2 @@', '+def step():', '+    return 0'));
  await settle();
  ok(
    'a new file is created exactly where the diff names it, inside the workspace folder, unsaved',
    r7 === undefined &&
      written.length === w0 + 1 &&
      written[w0].join() === 'create /ws/etl/steps/new_step.py,insert /ws/etl/steps/new_step.py' &&
      textOf('etl/steps/new_step.py') === ['def step():', '    return 0'].join(NL),
    { r7, last: written[w0], text: textOf('etl/steps/new_step.py') },
  );

  put('etl/load.py', LOAD);
  w0 = written.length;
  const r7b = await apply(diff('--- /dev/null', '+++ b/etl/load.py', '@@ -0,0 +1 @@', '+print("replaced")'));
  ok(
    'a "new file" proposal for a file that already exists is refused, not overwritten',
    r7b === t('patch.exists', 'etl/load.py') && written.length === w0 && textOf('etl/load.py') === LOAD,
    { r7b },
  );

  // -------------------------------------------------------------------------------- line numbers that may have moved
  put('sql/report.sql', SQL, HOUR_AGO);
  a0 = asked.length;
  const r8a = await apply(replace2, undefined, '', { createdAt: nowS() });
  ok(
    'a line-number proposal newer than the file applies without asking',
    r8a === undefined && asked.length === a0 && textOf('sql/report.sql') === ['select 1;', 'select 22;', 'select 3;', ''].join(NL),
    { r8a, text: textOf('sql/report.sql') },
  );

  put('sql/report.sql', SQL, Date.now());
  a0 = asked.length;
  w0 = written.length;
  const r8b = await apply(replace2, undefined, '', { createdAt: Math.floor(HOUR_AGO / 1000) });
  ok(
    'a line-number proposal for a file changed since the message asks first (modal); closing the question writes nothing',
    r8b === undefined &&
      asked.length === a0 + 1 &&
      asked[a0].modal &&
      asked[a0].msg === t('patch.changedSince', 'sql/report.sql') &&
      written.length === w0 &&
      textOf('sql/report.sql') === SQL,
    { r8b, asked: asked.slice(a0) },
  );

  const docs = new ProposalDocuments();
  onWarning = () => t('patch.showDiff');
  const dd1 = diffs.length;
  await apply(replace2, docs, 't8', { createdAt: Math.floor(HOUR_AGO / 1000) });
  ok('"Show diff" in that question opens the diff and writes nothing', diffs.length === dd1 + 1 && written.length === w0 && textOf('sql/report.sql') === SQL, {
    diffs: diffs.length - dd1,
  });

  onWarning = () => t('patch.applyAnyway');
  await apply(replace2, docs, 't8', { createdAt: Math.floor(HOUR_AGO / 1000) });
  ok('"Apply anyway" applies it', textOf('sql/report.sql').includes('select 22;'), textOf('sql/report.sql'));

  put('sql/report.sql', SQL, HOUR_AGO);
  docFor(Uri.file('/ws/sql/report.sql')).isDirty = true;
  onWarning = () => undefined;
  a0 = asked.length;
  await apply(replace2, undefined, '', { createdAt: nowS() });
  ok('unsaved changes in the editor count as a change too', asked.length === a0 + 1 && textOf('sql/report.sql') === SQL, {
    asked: asked.slice(a0),
  });

  put('sql/report.sql', SQL, Date.now());
  onWarning = () => {
    const d = docFor(Uri.file('/ws/sql/report.sql'));
    d.text = ['select 1;', '-- typed while the question was open', ''].join(NL);
    d.version++;
    d.isDirty = true;
    return t('patch.applyAnyway');
  };
  w0 = written.length;
  const r9 = await apply(replace2, undefined, '', { createdAt: Math.floor(HOUR_AGO / 1000) });
  ok(
    'a file that changes while the question is open is not overwritten',
    r9 === t('patch.changedMeanwhile', 'sql/report.sql') && written.length === w0 && textOf('sql/report.sql').includes('typed while'),
    { r9 },
  );
  onWarning = () => undefined;

  // -------------------------------------------------------------------------------- several files, and Show diff
  put('etl/load.py', LOAD);
  put('etl/save.py', SAVE);
  const loadHunk = ['--- a/etl/load.py', '+++ b/etl/load.py', '@@ -3,2 +3,2 @@', ' def load():', '-    return 1', '+    return 2'];
  w0 = written.length;
  const r10 = await apply(
    diff(...loadHunk, '--- a/etl/save.py', '+++ b/etl/save.py', '@@ -1,2 +1,2 @@', ' def save():', '-    return None', '+    return True'),
  );
  ok(
    'a diff over several files is all or nothing: one file that does not match stops the others',
    r10 === t('patch.notFound', 'etl/save.py') && written.length === w0 && textOf('etl/load.py') === LOAD && textOf('etl/save.py') === SAVE,
    { r10 },
  );
  const r10b = await apply(diff(...loadHunk, '--- a/etl/save.py', '+++ b/etl/save.py', '@@ -1,2 +1,2 @@', ' def save():', '-    pass', '+    return True'));
  await settle();
  ok(
    'when every file matches, all of them change in one edit',
    r10b === undefined &&
      written.length === w0 + 1 &&
      written[w0].length === 2 &&
      textOf('etl/load.py').includes('return 2') &&
      textOf('etl/save.py').includes('return True'),
    { r10b, last: written[w0] },
  );

  put('etl/load.py', LOAD);
  w0 = written.length;
  const dd2 = diffs.length;
  const r11 = await showDiff(docs, toTwo(), 't11', agents);
  const [left, right] = diffs[dd2] || [];
  ok(
    'Show diff opens the file next to a read-only buzz-proposal: document holding the proposed text, and writes nothing',
    r11 === undefined &&
      diffs.length === dd2 + 1 &&
      left.path === '/ws/etl/load.py' &&
      right.scheme === PROPOSAL_SCHEME &&
      docs.provideTextDocumentContent(right).includes('return 2') &&
      written.length === w0 &&
      textOf('etl/load.py') === LOAD,
    { r11, left, right },
  );

  // -------------------------------------------------------------------------------- the chat's switch (off by default)
  const hex = (s) => (s + '0'.repeat(64)).slice(0, 64);
  const CH = 'chA';
  const at = nowS();
  const msg = (id, ts, content, root) => ({
    id: hex(id),
    pubkey: hex('aa'),
    kind: 9,
    created_at: ts,
    content,
    tags: [['h', CH], ...(root ? [['e', hex(root), '', 'root']] : [])],
  });
  const page = [
    msg('a1', at - 100, 'Report query'),
    msg('bb', at - 50, ['Fix `sql/gate.sql:2`:', '```diff', '-select 2;', '+select 20;', '```'].join(NL), 'a1'),
  ];
  const client = {
    myPubkey: hex('ff'),
    me: async () => ({}),
    channels: async () => [{ id: CH, name: 'data-dev' }],
    allChannels: async () => [{ id: CH, name: 'data-dev' }],
    dms: async () => [],
    messages: async (_ch, o) => (o && o.before ? [] : page.slice()),
    thread: async () => page.slice(),
    send: async () => ({ event_id: hex('51'), accepted: true }),
    members: async () => [],
    presence: async () => ({}),
    nameOf: () => 'agent',
    isAgent: () => true,
    ensureProfiles: async () => undefined,
  };
  const live = {
    onEvent: () => disp,
    onState: () => disp,
    subscribe: noop,
    unsubscribe: noop,
    state: { state: 'live' },
    isLive: true,
    fetch: async () => undefined,
    out: { appendLine: noop },
    publish: noop,
  };
  const ext = {
    workspaceState: { get: () => undefined, update: async () => undefined },
    globalState: { get: () => undefined, update: async () => undefined },
    extensionUri: Uri.file('/ext'),
  };
  let onMsg;
  const chat = new ChatController(ext, client, live, {}, new ProposalDocuments(), agents);
  chat.attach({
    kind: 'panel',
    webview: {
      options: {},
      html: '',
      asWebviewUri: (u) => u,
      cspSource: '',
      onDidReceiveMessage: (cb) => ((onMsg = cb), disp),
      postMessage: async () => true,
    },
    isVisible: () => true,
    onVisibility: () => disp,
    onDispose: () => disp,
    reveal: noop,
  });
  await onMsg({ type: 'ready' });
  await sleep(200);
  await onMsg({ type: 'openThread', id: hex('a1') });
  await sleep(100);
  put('sql/gate.sql', SQL);
  w0 = written.length;
  await onMsg({ type: 'patchApply', id: hex('bb'), block: 0 });
  await settle();
  const whileOff = { written: written.length - w0, text: textOf('sql/gate.sql') };
  settings['proposals.applyLocally'] = true;
  await onMsg({ type: 'patchApply', id: hex('bb'), block: 0 });
  await settle();
  ok(
    'the chat applies nothing while buzz.proposals.applyLocally is off (the default); switched on, the same Apply writes',
    whileOff.written === 0 && whileOff.text === SQL && written.length === w0 + 1 && textOf('sql/gate.sql').includes('select 20;'),
    { whileOff, after: textOf('sql/gate.sql') },
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('FAIL the harness itself: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
