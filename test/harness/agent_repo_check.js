// Runs out/agentRepo.js (the agents' repositories: discovery, path resolution, the read-only file system) against a
// demo repository made by demo_repo.js, with a fake vscode module. Checks that the agents' working folder is untouched.
const Module = require('module');
const path = require('path');
const { execFileSync } = require('child_process');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');

const noop = () => undefined;
const disp = { dispose: noop };
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
  from: (o) => ({ scheme: o.scheme, path: o.path, toString: () => `${o.scheme}:${o.path}` }),
  joinPath: (...a) => ({ toString: () => a.join('/'), fsPath: a.join('/') }),
};
const fakeVscode = {
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }), onDidChangeConfiguration: () => disp, textDocuments: [], asRelativePath: (u) => String(u) },
  window: {
    createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop }),
    onDidChangeActiveTextEditor: () => disp,
    activeTextEditor: undefined,
    showQuickPick: async () => undefined,
    showInformationMessage: noop,
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

// a demo agents' repository in a temporary home: nothing of the user's is read, and it runs the same everywhere
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

(async () => {
  const dirs = ar.agentRepoDirs();
  ok(
    'finds the agents repository under ~/.buzz/REPOS',
    dirs.some((d) => d.toLowerCase() === repo.toLowerCase()),
    dirs,
  );
  const repos = new ar.AgentRepos();
  const snap = await repos.snapshot(dirs[0]);
  const buzzSha = gitOut(['rev-parse', 'buzz']).trim();
  ok('reads the buzz branch (not the folder): same commit as git', snap && snap.sha === buzzSha, snap && snap.sha);
  console.log(`     ${snap.files.size} files on buzz @ ${snap.sha.slice(0, 7)}; the folder itself is on "${before.head}"`);

  const a = await repos.resolve('pipeline/steps/rollup.py');
  const b = await repos.resolve(`${demo.name}/pipeline/steps/rollup.py`);
  ok(
    'a path from a message resolves to the agents file',
    a.length === 1 && a[0].path === `/${demo.name}/pipeline/steps/rollup.py`,
    a.map((u) => u.path),
  );
  ok(
    'the same path with the repo folder in front resolves too',
    b.length === 1 && b[0].path === a[0].path,
    b.map((u) => u.path),
  );
  const c = await repos.resolve('steps/rollup.py');
  ok(
    'a shorter path resolves by its end',
    c.length >= 1 && c.some((u) => u.path === a[0].path),
    c.map((u) => u.path),
  );
  ok('".." and absolute paths never resolve', (await repos.resolve('../secrets/x')).length === 0 && (await repos.resolve('C:/Windows/win.ini')).length === 0);
  ok('a file that does not exist resolves to nothing', (await repos.resolve('pipeline/steps/does_not_exist.py')).length === 0);

  const fsP = new ar.AgentFs(repos);
  const st = await fsP.stat(a[0]);
  const bytes = await fsP.readFile(a[0]);
  const viaGit = execFileSync('git', ['show', 'buzz:pipeline/steps/rollup.py'], { cwd: repo });
  const inFolder = require('fs').readFileSync(path.join(repo, 'pipeline', 'steps', 'rollup.py'));
  ok(
    'file content is exactly the buzz version, not the folder (which is on another branch)',
    Buffer.compare(Buffer.from(bytes), viaGit) === 0 && Buffer.compare(viaGit, inFolder) !== 0 && st.type === 1 && st.size === viaGit.length,
    { size: st.size, got: bytes.length, want: viaGit.length },
  );
  const root = await fsP.readDirectory(Uri.from({ scheme: ar.AGENT_SCHEME, path: `/${demo.name}/` }));
  ok(
    'the repository root can be listed',
    root.some(([n, t]) => n === 'pipeline' && t === 2),
    root.slice(0, 5),
  );
  // every way of changing the file system is refused: write, create a folder, delete, rename
  const refused = (f) => {
    try {
      f();
      return false;
    } catch (e) {
      return e.code === 'NoPermissions';
    }
  };
  const writes = {
    writeFile: refused(() => fsP.writeFile(a[0], new Uint8Array([1]), { create: true, overwrite: true })),
    createDirectory: refused(() => fsP.createDirectory(Uri.from({ scheme: ar.AGENT_SCHEME, path: `/${demo.name}/new-folder` }))),
    delete: refused(() => fsP.delete(a[0], { recursive: true })),
    rename: refused(() => fsP.rename(a[0], Uri.from({ scheme: ar.AGENT_SCHEME, path: `/${demo.name}/pipeline/moved.py` }), { overwrite: true })),
  };
  ok('writing, creating a folder, deleting and renaming are all refused (read-only)', Object.values(writes).every(Boolean), writes);
  let missing = false;
  try {
    await fsP.readFile(Uri.from({ scheme: ar.AGENT_SCHEME, path: `/${demo.name}/nope.txt` }));
  } catch (e) {
    missing = e.code === 'FileNotFound';
  }
  ok('a missing file is reported as not found', missing);
  ok('relPathOf gives the path inside the repo', ar.relPathOf(a[0]) === 'pipeline/steps/rollup.py', ar.relPathOf(a[0]));
  const prev = await repos.previousPaths(a[0]);
  ok(
    'earlier names come from the buzz history (the file was moved)',
    Array.isArray(prev) && prev.includes('pipeline/steps/rollup.py') && prev.includes('pipeline/rollup.py'),
    prev,
  );

  const after = { head: gitOut(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), status: gitOut(['status', '--porcelain']) };
  ok("the agents' folder is untouched (same branch, no changes)", after.head === before.head && after.status === before.status, { before, after });
  repos.dispose();
  demo.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
