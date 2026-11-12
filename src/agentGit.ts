// Git questions about the agents' repositories, answered without VS Code: which repository holds a branch or a
// commit, what that branch or commit changed, and what is still uncommitted in the folder. Unit-tested against a
// temporary repository. Nothing here writes: git runs without its optional locks, so the folder stays the agents'.
import * as nodePath from 'path';
import { runGit } from './git';
import { t } from './i18n';

/** git's empty tree: the "before" of a first commit */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Query of a buzz-agent: URI that reads a file as it is in the agents' folder right now (uncommitted work). */
export const WORKTREE = 'worktree';

export type RefKind = 'branch' | 'commit';

export interface FileChange {
  /** A, M, D, R, C, T */
  status: string;
  path: string;
  oldPath?: string;
}

/** What a branch or commit changed in an agents' repository. */
export interface ChangeRange {
  dir: string;
  name: string;
  base: string;
  tip: string;
  label: string;
  note?: string;
  files: FileChange[];
  /** the files are the uncommitted changes of this folder (the checkout of the branch) against `tip`, its HEAD */
  worktree?: string;
}

export interface FoundRef {
  dir: string;
  name: string;
  sha: string;
}

/** Branch names as git allows them (and never ".."), commits as 7-40 hex digits: nothing else reaches git. */
export function isValidRef(ref: string, kind: RefKind): boolean {
  return kind === 'branch' ? /^[\w.\-/]+$/.test(ref) && !ref.includes('..') : /^[0-9a-f]{7,40}$/i.test(ref);
}

/** git, read-only: no optional locks, so even `status` and `diff` leave the folder's index alone. */
const look = (dir: string, args: string[]): Promise<string> => runGit(dir, ['--no-optional-locks', ...args]);

/** The commit a revision names, or '' when there is none. */
const rev = (dir: string, spec: string): Promise<string> =>
  look(dir, ['rev-parse', '--verify', '-q', spec]).then(
    (s) => s.trim(),
    () => '',
  );

const isAncestor = (dir: string, a: string, b: string): Promise<boolean> =>
  look(dir, ['merge-base', '--is-ancestor', a, b]).then(
    () => true,
    () => false,
  );

/** The first of `dirs` holding the branch (local, or as origin/<name>) or the commit. */
export async function findRef(dirs: string[], ref: string, kind: RefKind): Promise<FoundRef | undefined> {
  if (!isValidRef(ref, kind)) return undefined;
  const hits: FoundRef[] = [];
  for (const dir of dirs) {
    for (const c of kind === 'branch' ? [`refs/heads/${ref}`, `refs/remotes/origin/${ref}`] : [ref]) {
      const sha = await rev(dir, `${c}^{commit}`);
      if (sha) {
        hits.push({ dir, name: nodePath.basename(dir), sha });
        break;
      }
    }
  }
  if (hits.length < 2 || kind !== 'branch') return hits[0];
  // the same branch name in several repositories: the one where it is checked out is the one being worked on
  for (const h of hits) if (await worktreeOf(h.dir, ref)) return h;
  return hits[0];
}

/** `git diff --name-status -z` as a list; renames and copies carry both paths. */
export function parseNameStatus(raw: string): FileChange[] {
  const parts = raw.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length;) {
    const st = parts[i++];
    if (!st) continue;
    if (st[0] === 'R' || st[0] === 'C') files.push({ status: st[0], oldPath: parts[i++], path: parts[i++] });
    else files.push({ status: st[0], path: parts[i++] });
  }
  return files;
}

/** The branch the folder is on, '' when detached. */
export const checkedOut = (dir: string): Promise<string> =>
  look(dir, ['symbolic-ref', '-q', '--short', 'HEAD']).then(
    (s) => s.trim(),
    () => '',
  );

/** Every checkout of the repository: the folder itself and its linked worktrees (`git worktree list`). */
export async function worktrees(dir: string): Promise<{ path: string; branch?: string }[]> {
  const raw = await look(dir, ['worktree', 'list', '--porcelain']).catch(() => '');
  const out: { path: string; branch?: string }[] = [];
  for (const block of raw.split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]?.trim();
    if (!path) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim();
    out.push({ path: nodePath.normalize(path), branch });
  }
  return out;
}

/** The folder a branch is checked out in, if any: agents often keep one worktree per task. */
export async function worktreeOf(dir: string, ref: string): Promise<string | undefined> {
  return (await worktrees(dir)).find((w) => w.branch === ref)?.path;
}

/** The folder's uncommitted changes against HEAD: modified, deleted and renamed files, plus new (untracked) ones. */
export async function worktreeChanges(dir: string): Promise<FileChange[]> {
  // `status` refreshes its view of the files in memory only; `diff` would write a refreshed .git/index even with
  // --no-optional-locks, and the folder is the agents'
  return parseStatusV2(await look(dir, ['status', '--porcelain=v2', '-z', '--untracked-files=all']));
}

/** `git status --porcelain=v2 -z` as a list: changed (1), renamed/copied (2), unmerged (u) and untracked (?) entries. */
export function parseStatusV2(raw: string): FileChange[] {
  const parts = raw.split('\0');
  const out: FileChange[] = [];
  const one = (xy: string) => (xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : 'M');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const kind = rec[0];
    if (kind === '1') {
      const f = rec.split(' ');
      out.push({ status: one(f[1] ?? ''), path: f.slice(8).join(' ') });
    } else if (kind === '2') {
      const f = rec.split(' ');
      const path = f.slice(9).join(' ');
      const oldPath = parts[++i] ?? '';
      out.push({ status: (f[8] ?? 'R')[0] === 'C' ? 'C' : 'R', oldPath, path });
    } else if (kind === 'u') {
      const f = rec.split(' ');
      out.push({ status: 'M', path: f.slice(10).join(' ') });
    } else if (kind === '?') {
      out.push({ status: 'A', path: rec.slice(2) });
    }
  }
  return out;
}

/** The commit a local branch was created from (its first reflog entry), '' when the reflog does not say. */
export const createdFrom = (dir: string, ref: string): Promise<string> =>
  look(dir, ['log', '-g', '--format=%H', `refs/heads/${ref}`]).then(
    (s) => s.trim().split('\n').filter(Boolean).pop() ?? '',
    () => '',
  );

/**
 * What a branch changed, measured from where it left the agents' branch (also after it was merged: the merge that
 * brought it in tells where it started), or what one commit changed against its first parent. A branch with no
 * commits of its own that the folder is on shows the agent's uncommitted work instead.
 */
export async function changeRange(dirs: string[], ref: string, kind: RefKind, agentBranch: string): Promise<ChangeRange | string> {
  const found = await findRef(dirs, ref, kind);
  if (!found) return t('git.notFound', ref);
  const { dir, name, sha } = found;
  let base = '';
  let note: string | undefined;
  let label = ref;
  if (kind === 'commit') {
    base = (await rev(dir, `${sha}^1`)) || EMPTY_TREE;
    const subject = (await look(dir, ['log', '-1', '--format=%s', sha]).catch(() => '')).trim();
    label = `${sha.slice(0, 7)}${subject ? ' ' + subject : ''}`;
  } else {
    const target = await rev(dir, `${agentBranch}^{commit}`);
    if (target && sha === target) {
      // the branch is where the agents' branch is: either it was fast-forwarded into it (its commits since it was
      // created, which the reflog remembers), or it has no commits of its own yet and the agent is still working on
      // it, uncommitted, wherever the branch is checked out
      const from = await createdFrom(dir, ref);
      const wt = from === sha || !from ? await worktreeOf(dir, ref) : undefined;
      if (from && from !== sha && (await isAncestor(dir, from, sha))) {
        base = from;
        note = t('git.ffNote', agentBranch);
      } else if (wt) {
        const files = await worktreeChanges(wt);
        if (!files.length) return t('git.noOwnCommits', ref, agentBranch);
        return { dir, name, base: sha, tip: sha, label: ref, note: t('git.worktreeNote'), files, worktree: wt };
      } else {
        base = (await rev(dir, `${sha}^1`)) || EMPTY_TREE;
        note = t('git.lastCommitNote', agentBranch);
      }
    } else if (target && (await isAncestor(dir, sha, target))) {
      // merged: the oldest commit of the agents' branch line that contains the branch is the merge that brought it
      const line = (await look(dir, ['rev-list', '--first-parent', '--ancestry-path', `${sha}..${target}`]).catch(() => '')).trim().split('\n').filter(Boolean);
      const merge = line[line.length - 1];
      const parents = merge ? (await look(dir, ['rev-list', '--parents', '-n', '1', merge])).trim().split(' ').slice(1) : [];
      if (parents.length >= 2 && !(await isAncestor(dir, sha, parents[0]))) {
        base = (await look(dir, ['merge-base', parents[0], sha])).trim();
        note = t('git.mergedNote', agentBranch, merge.slice(0, 7));
      } else {
        // fast-forwarded into the agents' branch: its last commit
        base = (await rev(dir, `${sha}^1`)) || EMPTY_TREE;
        note = t('git.lastCommitNote', agentBranch);
      }
    } else if (target) {
      base = (await look(dir, ['merge-base', target, sha]).catch(() => '')).trim();
      if (!base) return t('git.noCommonBase', ref, agentBranch); // unrelated histories
    }
    if (!base) return t('git.notFound', agentBranch);
  }
  const files = parseNameStatus(await look(dir, ['diff', '--name-status', '-z', '-M', base, sha]));
  return { dir, name, base, tip: sha, label, note, files };
}
