// Runs out/agentRepo.js's Show diff ranges (a merged branch, an open branch, one commit) and what Show diff opens from
// them (out/gitChanges.js) against a demo repository made by demo_repo.js, and compares every answer with git itself.
// Read-only on that repository.
const Module = require('module');
const path = require('path');
const { execFileSync } = require('child_process');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');

const noop = () => undefined;
const disp = { dispose: noop };
const commands = []; // every executeCommand: [command, ...arguments]
let failChanges = false; // true: VS Code without the changes editor
let pickRow = () => undefined; // what the user picks in the fallback's file list
class FileSystemError extends Error {
  static FileNotFound(u) {
    const e = new FileSystemError('FileNotFound ' + u);
    e.code = 'FileNotFound';
    return e;
  }
  static NoPermissions(u) {
    const e = new FileSystemError('NoPermissions ' + u);
    e.code = 'NoPermissions';
    return e;
  }
}
const Uri = {
  from: (o) => ({ scheme: o.scheme, path: o.path, query: o.query || '', toString: () => `${o.scheme}:${o.path}${o.query ? '?' + o.query : ''}` }),
  joinPath: (...a) => ({ toString: () => a.join('/'), fsPath: a.join('/') }),
};
const fakeVscode = {
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }), onDidChangeConfiguration: () => disp, textDocuments: [], asRelativePath: (u) => String(u) },
  window: {
    createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop }),
    onDidChangeActiveTextEditor: () => disp,
    activeTextEditor: undefined,
    showQuickPick: async (items) => pickRow(items),
    showInformationMessage: noop,
  },
  commands: {
    executeCommand: async (cmd, ...args) => {
      commands.push([cmd, ...args]);
      if (cmd === 'vscode.changes' && failChanges) throw new Error("command 'vscode.changes' not found");
    },
  },
  EventEmitter: class {
    constructor() {
      this.l = [];
      this.event = (f) => (this.l.push(f), disp);
    }
    fire(v) {
      this.l.forEach((f) => f(v));
    }
    dispose() {}
  },
  Disposable: class {
    constructor(f) {
      this.dispose = f;
    }
  },
  Uri,
  FileType: { File: 1, Directory: 2 },
  FileChangeType: { Changed: 1 },
  FileSystemError,
  StatusBarAlignment: { Left: 1, Right: 2 },
  env: { language: 'en' },
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') return fakeVscode;
  return origLoad.apply(this, arguments);
};
const ar = require(path.join(PROJ, 'out', 'agentRepo.js'));

// a demo agents' repository in a temporary home: a merged branch, an open branch, a single commit
const demo = require('./demo_repo').makeDemoHome();
const repo = demo.repo;
const gitOut = (args) => execFileSync('git', args, { cwd: repo }).toString();
const before = { head: gitOut(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), status: gitOut(['status', '--porcelain']) };
let pass = 0;
let fail = 0;
const ok = (n, c, info) => {
  c ? pass++ : fail++;
  console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(info)));
};
const sorted = (out) => out.split('\n').filter(Boolean).sort();

(async () => {
  const repos = new ar.AgentRepos();
  const g = (args) => gitOut(args).trim();
  // 1) a branch already merged into buzz: what its merge brought in
  const merged = await repos.changeRange(demo.merged, 'branch');
  const mergeCommit = g(['log', '--first-parent', '--merges', '--format=%H', '-n', '1', '--grep', demo.merged, 'buzz']);
  const wantMerged = sorted(g(['diff', '--name-only', mergeCommit + '^1', mergeCommit]));
  ok(
    'merged branch: shows what its merge brought in',
    typeof merged !== 'string' && JSON.stringify(merged.files.map((f) => f.path).sort()) === JSON.stringify(wantMerged),
    { got: merged.files && merged.files.map((f) => f.path), want: wantMerged, note: merged.note },
  );
  console.log('     ' + (merged.label || '') + ' · ' + (merged.note || '') + ' · ' + (merged.files || []).map((f) => f.status + ' ' + f.path).join(', '));
  // 2) a branch in progress (not in buzz): everything since it left buzz
  const r = await repos.changeRange(demo.open, 'branch');
  const want = sorted(g(['diff', '--name-only', 'buzz...' + demo.open]));
  ok('open branch: same files as git diff buzz...branch', typeof r !== 'string' && JSON.stringify(r.files.map((f) => f.path).sort()) === JSON.stringify(want), {
    got: r.files && r.files.map((f) => f.path),
    want,
  });
  // 3) one commit: against its first parent
  const c = await repos.changeRange(demo.commit, 'commit');
  const wantC = sorted(g(['diff', '--name-only', demo.commit + '^1', demo.commit]));
  ok('commit: same files as git show', typeof c !== 'string' && JSON.stringify(c.files.map((f) => f.path).sort()) === JSON.stringify(wantC), {
    got: c.files && c.files.map((f) => f.path),
    want: wantC,
  });
  console.log('     ' + c.label);
  // 4) a file at a commit reads exactly that version
  const f0 = c.files[0];
  const u = ar.agentRefUri(c.name, f0.path, c.tip);
  const fsP = new ar.AgentFs(repos);
  const st = await fsP.stat(u);
  const bytes = await fsP.readFile(u);
  const want4 = execFileSync('git', ['show', c.tip + ':' + f0.path], { cwd: repo });
  ok('a file pinned to a commit reads that version', Buffer.compare(Buffer.from(bytes), want4) === 0 && st.size === want4.length);
  // 5) unknown refs
  ok('an unknown branch is reported, not guessed', typeof (await repos.changeRange('feature/does-not-exist', 'branch')) === 'string');
  ok('names with ".." are refused', (await repos.findRef('feature/../buzz', 'branch')) === undefined);
  // 6) what Show diff opens (out/gitChanges.js): one row per changed file in VS Code's changes editor, the old side at
  //    the base (a renamed file under its old name), the new side at the tip, no old side for an added file and no
  //    new side for a deleted one; every side reads exactly what git has there
  const { showChanges } = require(path.join(PROJ, 'out', 'gitChanges.js'));
  const { ProposalDocuments } = require(path.join(PROJ, 'out', 'proposals.js'));
  const docs = new ProposalDocuments();
  const renamed = await repos.changeRange(g(['log', '--format=%H', '-n', '1', '--grep', 'move rollup', 'buzz']), 'commit');
  const kinds = (rg) =>
    typeof rg === 'string'
      ? rg
      : rg.files
          .map((f) => f.status)
          .sort()
          .join('');
  ok('the ranges hold an added, a changed, a deleted and a renamed file', kinds(r) === 'ADM' && kinds(renamed) === 'R', {
    open: kinds(r),
    renamed: kinds(renamed),
  });
  const show = (rev, p) => execFileSync('git', ['show', `${rev}:${p}`], { cwd: repo });
  // a side that cannot be read is a wrong side, not the end of the run
  const read = async (u) => {
    try {
      return Buffer.from(await fsP.readFile(u));
    } catch (e) {
      return Buffer.from('unreadable: ' + e.message);
    }
  };
  const same = (a, b) => (a === undefined || b === undefined ? a === b : Buffer.compare(a, b) === 0);
  const sides = [];
  let sidesOk = typeof renamed !== 'string';
  for (const rg of typeof renamed === 'string' ? [r] : [r, renamed]) {
    commands.length = 0;
    const err = await showChanges(rg, docs);
    const call = commands.find((x) => x[0] === 'vscode.changes');
    const rows = call ? call[2] : [];
    if (err || rows.length !== rg.files.length) sidesOk = false;
    for (const [i, f] of rg.files.entries()) {
      const [, before, after] = rows[i] || [];
      const gotBefore = before && (await read(before));
      const gotAfter = after && (await read(after));
      const good =
        same(gotBefore, f.status === 'A' ? undefined : show(rg.base, f.oldPath || f.path)) &&
        same(gotAfter, f.status === 'D' ? undefined : show(rg.tip, f.path));
      if (!good) sidesOk = false;
      sides.push(`${f.status} ${f.oldPath ? f.oldPath + ' -> ' : ''}${f.path}: ${good ? 'ok' : 'WRONG'}`);
    }
  }
  ok('Show diff: one row per file, each side reads what git has at the base and at the tip', sidesOk, sides);
  console.log('     ' + sides.join(', '));
  failChanges = true;
  pickRow = (items) => items.find((it) => it.r.f.status === 'D');
  commands.length = 0;
  const errF = await showChanges(r, docs);
  const two = commands.find((x) => x[0] === 'vscode.diff');
  ok(
    "without the changes editor the picked file opens in the two-file diff view, a deleted file's new side empty",
    !errF && !!two && !!two[1] && two[1].query === r.base && !!two[2] && two[2].scheme === 'buzz-proposal' && docs.provideTextDocumentContent(two[2]) === '',
    { errF, two: two && two.slice(1, 3).map(String) },
  );
  failChanges = false;
  const after = { head: gitOut(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), status: gitOut(['status', '--porcelain']) };
  ok("the agents' folder is untouched", after.head === before.head && after.status === before.status, { before, after });
  repos.dispose();
  demo.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
