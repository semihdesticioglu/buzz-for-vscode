// agentGit against a real, temporary repository: where a branch left the agents' branch, before and after a merge,
// one commit against its parent, and the guards on what reaches git.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { changeRange, EMPTY_TREE, findRef, isValidRef, parseNameStatus, parseStatusV2, worktreeOf, worktrees } from '../agentGit';
import { createHash } from 'node:crypto';

let dir: string;
const sha: Record<string, string> = {};

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(name: string, files: Record<string, string>, message = name): void {
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), text);
  git('add', '-A');
  git('commit', '-q', '-m', message);
  sha[name] = git('rev-parse', 'HEAD');
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzz-agentgit-'));
  git('init', '-q', '-b', 'buzz');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  commit('A', { 'a.txt': 'alpha\n'.repeat(20) }, 'first');
  commit('B', { 'b.txt': 'beta\n'.repeat(20) }, 'second');
  // the agents' branch work: a change, a new file, a rename
  git('checkout', '-q', '-b', 'feature/x');
  commit('C', { 'a.txt': 'alpha\n'.repeat(19) + 'ALPHA\n', 'c.txt': 'gamma\n' }, 'change a, add c');
  git('mv', 'b.txt', 'd.txt');
  commit('D', {}, 'rename b to d');
  // meanwhile buzz moved on
  git('checkout', '-q', 'buzz');
  commit('E', { 'e.txt': 'epsilon\n' }, 'unrelated work on buzz');
});

after(() => {
  try {
    // Windows can hold a handle for a moment after git exits: retry before giving up
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* still held: the temp folder is cleaned by the OS */
  }
});

test('only git-safe names reach git', () => {
  assert.equal(isValidRef('feature/abc-123_fix.v2', 'branch'), true);
  assert.equal(isValidRef('../../etc', 'branch'), false);
  assert.equal(isValidRef('a..b', 'branch'), false);
  assert.equal(isValidRef('--output=x', 'branch'), false);
  assert.equal(isValidRef('9c4e2b7', 'commit'), true);
  assert.equal(isValidRef('157dd8', 'commit'), false);
  assert.equal(isValidRef('not-a-sha', 'commit'), false);
});

test('name-status output with renames', () => {
  assert.deepEqual(parseNameStatus('M\0a.txt\0R100\0b.txt\0d.txt\0A\0c.txt\0'), [
    { status: 'M', path: 'a.txt' },
    { status: 'R', oldPath: 'b.txt', path: 'd.txt' },
    { status: 'A', path: 'c.txt' },
  ]);
  assert.deepEqual(parseNameStatus(''), []);
});

test('a branch is found locally or as origin/<name>; a commit by its hash; unknown names are not', async () => {
  assert.equal((await findRef([dir], 'feature/x', 'branch'))?.sha, sha.D);
  assert.equal((await findRef([dir], sha.C.slice(0, 7), 'commit'))?.sha, sha.C);
  git('update-ref', 'refs/remotes/origin/remote-only', sha.D);
  assert.equal((await findRef([dir], 'remote-only', 'branch'))?.sha, sha.D);
  assert.equal(await findRef([dir], 'nope', 'branch'), undefined);
  assert.equal(await findRef([dir], '../x', 'branch'), undefined);
  assert.equal(await findRef([], 'feature/x', 'branch'), undefined);
});

test('an unmerged branch is measured from where it left the agents branch', async () => {
  const r = await changeRange([dir], 'feature/x', 'branch', 'buzz');
  assert.ok(typeof r !== 'string', String(r));
  assert.equal(r.base, sha.B);
  assert.equal(r.tip, sha.D);
  assert.equal(r.note, undefined);
  assert.equal(r.name, path.basename(dir));
  assert.deepEqual(r.files.map((f) => `${f.status} ${f.oldPath ? f.oldPath + '->' : ''}${f.path}`).sort(), ['A c.txt', 'M a.txt', 'R b.txt->d.txt']);
});

test('a single commit is measured against its first parent; the first commit against the empty tree', async () => {
  const r = await changeRange([dir], sha.C, 'commit', 'buzz');
  assert.ok(typeof r !== 'string', String(r));
  assert.equal(r.base, sha.B);
  assert.equal(r.tip, sha.C);
  assert.ok(r.label.startsWith(sha.C.slice(0, 7) + ' change a'), r.label);
  assert.deepEqual(r.files.map((f) => `${f.status} ${f.path}`).sort(), ['A c.txt', 'M a.txt']);
  const first = await changeRange([dir], sha.A, 'commit', 'buzz');
  assert.ok(typeof first !== 'string');
  assert.equal(first.base, EMPTY_TREE);
  assert.deepEqual(first.files, [{ status: 'A', path: 'a.txt' }]);
});

test('after a merge the branch still shows only its own work, with a note naming the merge', async () => {
  git('merge', '-q', '--no-ff', '-m', 'merge feature/x', 'feature/x');
  const merge = git('rev-parse', 'HEAD');
  const r = await changeRange([dir], 'feature/x', 'branch', 'buzz');
  assert.ok(typeof r !== 'string', String(r));
  assert.equal(r.base, sha.B);
  assert.equal(r.tip, sha.D);
  assert.ok(r.note?.includes(merge.slice(0, 7)), r.note);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['a.txt', 'c.txt', 'd.txt']);
});

test('a fast-forwarded branch (or the agents branch itself) shows its last commit', async () => {
  git('checkout', '-q', '-b', 'ff');
  commit('F', { 'f.txt': 'phi\n' }, 'ff work');
  git('checkout', '-q', 'buzz');
  git('merge', '-q', '--ff-only', 'ff');
  const r = await changeRange([dir], 'ff', 'branch', 'buzz');
  assert.ok(typeof r !== 'string', String(r));
  assert.equal(r.tip, sha.F);
  assert.ok(r.note, 'a note explains that only the last commit is shown');
  assert.deepEqual(r.files, [{ status: 'A', path: 'f.txt' }]);
});

test('unknown references and a missing agents branch come back as a message, not an exception', async () => {
  assert.equal(typeof (await changeRange([dir], 'no-such-branch', 'branch', 'buzz')), 'string');
  assert.equal(typeof (await changeRange([dir], 'feature/x', 'branch', 'no-such-base')), 'string');
  assert.equal(typeof (await changeRange([dir], '../x', 'branch', 'buzz')), 'string');
});

test('a branch without commits of its own shows the uncommitted work of the folder while the folder is on it', async () => {
  git('checkout', '-q', '-b', 'wip'); // at the tip of buzz
  const none = await changeRange([dir], 'wip', 'branch', 'buzz');
  assert.equal(typeof none, 'string', "nothing committed and nothing changed: a message, not another task's diff");
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'g.txt'), 'new\n');
  const r = await changeRange([dir], 'wip', 'branch', 'buzz');
  assert.ok(typeof r !== 'string', String(r));
  assert.ok(r.worktree && path.resolve(r.worktree) === path.resolve(dir), String(r.worktree));
  assert.equal(r.tip, git('rev-parse', 'HEAD'));
  assert.ok(r.note, 'the title says it is uncommitted work');
  assert.deepEqual(r.files.map((f) => `${f.status} ${f.path}`).sort(), ['A g.txt', 'M a.txt']);
  assert.equal(git('status', '--porcelain').split('\n').length, 2, 'reading changed nothing in the folder');
  // a touched-but-unchanged file: reading must not refresh (write) the agents' index
  const index = path.join(dir, '.git', 'index');
  const hash = () => createHash('md5').update(fs.readFileSync(index)).digest('hex');
  fs.utimesSync(path.join(dir, 'e.txt'), new Date(), new Date());
  const before = hash();
  await changeRange([dir], 'wip', 'branch', 'buzz');
  assert.equal(hash(), before, '.git/index untouched by Show diff');
  // the folder on another branch: the fast-forward reading (its last commit), as before
  git('checkout', '-q', '--', 'a.txt');
  fs.rmSync(path.join(dir, 'g.txt'));
  git('checkout', '-q', 'buzz');
  const ff = await changeRange([dir], 'wip', 'branch', 'buzz');
  assert.ok(typeof ff !== 'string' && ff.note && !ff.worktree, String(ff));
});

test('a branch checked out in a linked worktree (one per task, as the agents do) shows the uncommitted work from there', async () => {
  const wt = path.join(path.dirname(dir), path.basename(dir) + '-task-x'); // a linked worktree next to the repository
  git('worktree', 'add', '-q', '-b', 'task/x', wt, 'buzz');
  try {
    assert.ok(path.resolve((await worktreeOf(dir, 'task/x')) ?? ''), 'the worktree is found by its branch');
    assert.ok(
      (await worktrees(dir)).some((w) => path.resolve(w.path) === path.resolve(dir)),
      'the folder itself is listed too',
    );
    const clean = await changeRange([dir], 'task/x', 'branch', 'buzz');
    assert.equal(typeof clean, 'string', 'nothing changed yet: a message');
    fs.writeFileSync(path.join(wt, 'h.txt'), 'from the worktree\n');
    const r = await changeRange([dir], 'task/x', 'branch', 'buzz');
    assert.ok(typeof r !== 'string', String(r));
    assert.ok(r.worktree && path.resolve(r.worktree) === path.resolve(wt), String(r.worktree));
    assert.deepEqual(r.files, [{ status: 'A', path: 'h.txt' }]);
    assert.equal(git('status', '--porcelain'), '', 'the main folder stays untouched');
  } finally {
    git('worktree', 'remove', '--force', wt);
  }
});

test('git status --porcelain=v2 is read into changes: modified, added, deleted, renamed, unmerged, untracked', () => {
  const raw = [
    '1 .M N... 100644 100644 100644 abc def a.txt',
    '1 A. N... 000000 100644 100644 000 111 new.txt',
    '1 .D N... 100644 100644 000000 abc abc gone.txt',
    '2 R. N... 100644 100644 100644 abc abc R100 d.txt',
    'b.txt',
    'u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt',
    '? notes/draft.md',
    '',
  ].join('\0');
  assert.deepEqual(parseStatusV2(raw), [
    { status: 'M', path: 'a.txt' },
    { status: 'A', path: 'new.txt' },
    { status: 'D', path: 'gone.txt' },
    { status: 'R', oldPath: 'b.txt', path: 'd.txt' },
    { status: 'M', path: 'conflict.txt' },
    { status: 'A', path: 'notes/draft.md' },
  ]);
  assert.deepEqual(parseStatusV2(''), []);
});
