// The agents' own repositories (by default every git checkout under ~/.buzz/REPOS). File links, "Show diff" and
// Buzz Lens read the agents' version of the code from one branch (`buzz.agentBranch`, default `buzz`) through git,
// as read-only documents (scheme buzz-agent:/<repo>/<path>). Nothing is ever written there: the folder belongs to
// the agents, who switch branches in it during the day, so the branch is read from git, not from the folder.
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import * as vscode from 'vscode';
import { isSafeRel, normalizeRel } from './core';
import { t } from './i18n';
import { runGit, runGitBytes } from './git';
import * as cfg from './config';
import * as agentGit from './agentGit';

export type { ChangeRange, FileChange, RefKind } from './agentGit';
export { WORKTREE } from './agentGit';

export const AGENT_SCHEME = 'buzz-agent';

const SNAPSHOT_TTL = 15_000; // how often the branch head is checked while documents are open
const MAX_CONTENTS = 40; // file contents kept in memory

const expandHome = (p: string) => (p.startsWith('~') ? nodePath.join(os.homedir(), p.slice(1)) : p);

/** Folders of the agents' repositories: the setting, or every git checkout under ~/.buzz/REPOS. */
export function agentRepoDirs(): string[] {
  const set = cfg.agentReposSetting();
  if (set.length) return set.map(expandHome);
  const base = nodePath.join(os.homedir(), '.buzz', 'REPOS');
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(nodePath.join(base, d.name, '.git')))
      .map((d) => nodePath.join(base, d.name));
  } catch {
    return [];
  }
}

interface Snapshot {
  dir: string;
  name: string;
  branch: string;
  sha: string;
  time: number; // commit time of the branch head (ms)
  files: Map<string, number>; // path -> size
  dirs: Set<string>;
  at: number;
}

/** buzz-agent:/<repo>/<path> */
const agentUri = (name: string, rel: string) => vscode.Uri.from({ scheme: AGENT_SCHEME, path: `/${name}/${rel}` });

/** A file at one commit: buzz-agent:/<repo>/<path>?<sha> (its content never changes). */
export const agentRefUri = (name: string, rel: string, sha: string) => vscode.Uri.from({ scheme: AGENT_SCHEME, path: `/${name}/${rel}`, query: sha });

const pinnedSha = (uri: vscode.Uri) => (/^[0-9a-f]{7,40}$/.test(uri.query) ? uri.query : undefined);
/** A commit, or the folder as it is now (`?worktree`): the file never comes from the branch snapshot. */
const pinnedRef = (uri: vscode.Uri): string | undefined => {
  const q = uri.query ?? '';
  return pinnedSha(uri) ?? (q === agentGit.WORKTREE || q.startsWith(agentGit.WORKTREE + '=') ? agentGit.WORKTREE : undefined);
};

/** The query of a URI reading a file from a checkout folder (the repository itself or a linked worktree). */
export const worktreeQuery = (folder: string): string => `${agentGit.WORKTREE}=${encodeURIComponent(folder)}&at=${Date.now()}`; // unique per Show diff: VS Code reads the file afresh

const sameFolder = (a: string, b: string) => {
  const n = (p: string) => nodePath.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** The path of a document inside its repository: the agents' copy or a workspace folder. */
export function relPathOf(uri: vscode.Uri): string {
  if (uri.scheme === AGENT_SCHEME) return uri.path.replace(/^\/[^/]+\/?/, '');
  return vscode.workspace.asRelativePath(uri, false);
}

export class AgentRepos implements vscode.Disposable {
  private readonly snaps = new Map<string, Snapshot>();
  private readonly loadingSnap = new Map<string, Promise<Snapshot | undefined>>();
  private readonly contents = new Map<string, Uint8Array>(); // "sha:path" -> bytes
  private readonly changedEmitter = new vscode.EventEmitter<string>(); // repo name whose branch moved
  readonly onDidChange = this.changedEmitter.event;
  private readonly bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly subs: vscode.Disposable[] = [];
  private readonly timer: NodeJS.Timeout;

  constructor() {
    this.bar.command = 'buzz.openAgentFile';
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor(() => void this.updateBar()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('buzz.agentBranch') || e.affectsConfiguration('buzz.agentRepos')) {
          this.snaps.clear();
          for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === AGENT_SCHEME) this.changedEmitter.fire(this.locateName(d.uri));
          void this.updateBar();
        }
      }),
    );
    // while the agents' files are open, follow the branch: when it moves, open documents are re-read
    this.timer = setInterval(() => {
      const names = new Set(vscode.workspace.textDocuments.filter((d) => d.uri.scheme === AGENT_SCHEME).map((d) => this.locateName(d.uri)));
      for (const dir of agentRepoDirs()) if (names.has(nodePath.basename(dir))) void this.snapshot(dir);
    }, SNAPSHOT_TTL);
    void this.updateBar();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.subs.forEach((d) => d.dispose());
    this.bar.dispose();
    this.changedEmitter.dispose();
  }

  private dirs: string[] = [];
  private dirsAt = 0;

  /** Whether there is any agents' repository (checked at most once a minute). */
  get available(): boolean {
    if (Date.now() - this.dirsAt > 60_000) {
      this.dirs = agentRepoDirs();
      this.dirsAt = Date.now();
    }
    return this.dirs.length > 0;
  }

  /** The repository holding a branch (local, or as origin/<name>) or a commit. */
  findRef(ref: string, kind: agentGit.RefKind): Promise<agentGit.FoundRef | undefined> {
    return agentGit.findRef(agentRepoDirs(), ref, kind);
  }

  /** What a branch changed since it left the agents' branch, or what one commit changed (see agentGit.ts). */
  changeRange(ref: string, kind: agentGit.RefKind): Promise<agentGit.ChangeRange | string> {
    return agentGit.changeRange(agentRepoDirs(), ref, kind, cfg.agentBranch());
  }

  /** A file at one commit, or as it is in the folder right now (for the changes editor). */
  async statPinned(uri: vscode.Uri): Promise<number | undefined> {
    const sha = pinnedRef(uri);
    const name = this.locateName(uri);
    const dir = agentRepoDirs().find((d) => nodePath.basename(d) === name);
    if (!sha || !dir) return undefined;
    const rel = uri.path.slice(name.length + 2);
    if (sha === agentGit.WORKTREE) {
      const folder = await this.checkoutFolder(dir, uri);
      if (!folder || !isSafeRel(rel)) return undefined;
      const st = await fs.promises.stat(nodePath.join(folder, rel)).catch(() => undefined);
      return st?.isFile() ? st.size : undefined;
    }
    const size = (await runGit(dir, ['cat-file', '-s', `${sha}:${rel}`]).catch(() => '')).trim();
    return size ? Number(size) : undefined;
  }

  async readPinned(uri: vscode.Uri): Promise<Uint8Array | undefined> {
    const sha = pinnedRef(uri);
    const name = this.locateName(uri);
    const dir = agentRepoDirs().find((d) => nodePath.basename(d) === name);
    if (!sha || !dir) return undefined;
    const rel = uri.path.slice(name.length + 2);
    if (sha === agentGit.WORKTREE) {
      // uncommitted work changes under the agent's hands: read it fresh every time, never cache it
      const folder = await this.checkoutFolder(dir, uri);
      if (!folder || !isSafeRel(rel)) return undefined;
      return fs.promises.readFile(nodePath.join(folder, rel)).then(
        (b) => new Uint8Array(b),
        () => undefined,
      );
    }
    const key = `${sha}:${rel}`;
    let bytes = this.contents.get(key);
    if (!bytes) {
      try {
        bytes = new Uint8Array(await runGitBytes(dir, ['show', key]));
      } catch {
        return undefined;
      }
      this.contents.set(key, bytes);
      while (this.contents.size > MAX_CONTENTS) this.contents.delete(this.contents.keys().next().value as string);
    }
    return bytes;
  }

  /** The checkout folder a worktree URI names: the repository itself, or one of its linked worktrees — nothing else. */
  private async checkoutFolder(dir: string, uri: vscode.Uri): Promise<string | undefined> {
    if (uri.query === agentGit.WORKTREE) return dir;
    const asked = decodeURIComponent(uri.query.slice(agentGit.WORKTREE.length + 1).split('&')[0]);
    if (sameFolder(asked, dir)) return dir;
    const known = (await agentGit.worktrees(dir)).find((w) => sameFolder(w.path, asked));
    return known?.path;
  }

  private locateName(uri: vscode.Uri): string {
    return uri.path.split('/')[1] ?? '';
  }

  /** The branch's file list, read once per branch head. */
  async snapshot(dir: string): Promise<Snapshot | undefined> {
    const hit = this.snaps.get(dir);
    const branch = cfg.agentBranch();
    if (hit && hit.branch === branch && Date.now() - hit.at < SNAPSHOT_TTL) return hit;
    const running = this.loadingSnap.get(dir);
    if (running) return running;
    const p = (async () => {
      let sha: string;
      try {
        sha = (await runGit(dir, ['rev-parse', '--verify', '-q', `${branch}^{commit}`])).trim();
      } catch {
        return undefined; // no such branch in this repository
      }
      if (hit && hit.sha === sha && hit.branch === branch) {
        hit.at = Date.now();
        return hit;
      }
      const list = await runGit(dir, ['ls-tree', '-r', '-l', '-z', sha]);
      const files = new Map<string, number>();
      const dirs = new Set<string>(['']);
      for (const rec of list.split('\0')) {
        const tab = rec.indexOf('\t');
        if (tab < 0) continue;
        const meta = rec.slice(0, tab).split(/\s+/);
        if (meta[1] !== 'blob') continue;
        const path = rec.slice(tab + 1);
        files.set(path, Number(meta[3]) || 0);
        for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) dirs.add(path.slice(0, i));
      }
      const time = Number((await runGit(dir, ['log', '-1', '--format=%ct', sha])).trim()) * 1000 || Date.now();
      const snap: Snapshot = { dir, name: nodePath.basename(dir), branch, sha, time, files, dirs, at: Date.now() };
      this.snaps.set(dir, snap);
      if (hit && (hit.sha !== sha || hit.branch !== branch)) {
        this.changedEmitter.fire(snap.name);
        void this.updateBar();
      }
      return snap;
    })().finally(() => this.loadingSnap.delete(dir));
    this.loadingSnap.set(dir, p);
    return p;
  }

  /** The repository and path behind a buzz-agent: URI. */
  async locate(uri: vscode.Uri): Promise<{ snap: Snapshot; rel: string } | undefined> {
    const name = this.locateName(uri);
    const dir = agentRepoDirs().find((d) => nodePath.basename(d) === name);
    const snap = dir ? await this.snapshot(dir) : undefined;
    return snap ? { snap, rel: uri.path.slice(name.length + 2) } : undefined;
  }

  async read(snap: Snapshot, rel: string): Promise<Uint8Array> {
    const key = `${snap.sha}:${rel}`;
    let bytes = this.contents.get(key);
    if (!bytes) {
      bytes = new Uint8Array(await runGitBytes(snap.dir, ['show', key]));
      this.contents.set(key, bytes);
      while (this.contents.size > MAX_CONTENTS) this.contents.delete(this.contents.keys().next().value as string);
    }
    return bytes;
  }

  /** Files in the agents' repositories that a path from a message names: exact, under the repo's own folder name, or by its end. */
  async resolve(path: string): Promise<vscode.Uri[]> {
    if (!isSafeRel(path)) return [];
    const rel = normalizeRel(path);
    if (!rel) return [];
    const hits: vscode.Uri[] = [];
    for (const dir of agentRepoDirs()) {
      const snap = await this.snapshot(dir).catch(() => undefined);
      if (!snap) continue;
      const cands = [rel];
      if (rel.startsWith(snap.name + '/')) cands.push(rel.slice(snap.name.length + 1));
      const exact = cands.find((c) => snap.files.has(c)) ?? [...snap.files.keys()].find((f) => cands.some((c) => f.toLowerCase() === c.toLowerCase()));
      if (exact) {
        hits.push(agentUri(snap.name, exact));
        continue;
      }
      for (const f of snap.files.keys()) {
        const lf = f.toLowerCase();
        if (cands.some((c) => lf.endsWith('/' + c.toLowerCase()))) hits.push(agentUri(snap.name, f));
        if (hits.length >= 20) break;
      }
    }
    return hits;
  }

  /** Every file of the agents' branch, for "Open a file from the agents' copy". */
  async allFiles(): Promise<vscode.Uri[]> {
    const out: vscode.Uri[] = [];
    for (const dir of agentRepoDirs()) {
      const snap = await this.snapshot(dir).catch(() => undefined);
      if (snap) for (const f of snap.files.keys()) out.push(agentUri(snap.name, f));
    }
    return out;
  }

  /** Earlier names of a file on the agents' branch (git renames). */
  async previousPaths(uri: vscode.Uri): Promise<string[]> {
    const at = await this.locate(uri);
    if (!at) return [];
    try {
      const out = await runGit(at.snap.dir, ['log', at.snap.sha, '--follow', '--name-only', '--format=', '--', `:(literal)${at.rel}`]);
      return [
        ...new Set(
          out
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean),
        ),
      ].slice(0, 5);
    } catch {
      return [];
    }
  }

  /** Status bar: which version of the agents' code the active document shows. */
  private async updateBar(): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== AGENT_SCHEME) {
      this.bar.hide();
      return;
    }
    const sha = pinnedSha(doc.uri);
    if (sha) {
      this.bar.text = `$(lock) $(git-commit) ${t('agent.barCommit', sha.slice(0, 7))}`;
      this.bar.tooltip = t('agent.barCommitTip', this.locateName(doc.uri), sha.slice(0, 7));
      this.bar.show();
      return;
    }
    const at = await this.locate(doc.uri);
    if (!at) {
      this.bar.hide();
      return;
    }
    this.bar.text = `$(lock) $(git-branch) ${t('agent.bar', at.snap.branch, at.snap.sha.slice(0, 7))}`;
    this.bar.tooltip = t('agent.barTip', at.snap.name, at.snap.branch, new Date(at.snap.time).toLocaleString(), at.snap.dir);
    this.bar.show();
  }
}

/** Read-only file system over the agents' branch. */
export class AgentFs implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly repos: AgentRepos) {
    // the branch moved: open documents of that repository are read again
    this.sub = repos.onDidChange((name) =>
      this.emitter.fire(
        vscode.workspace.textDocuments
          .filter((d) => d.uri.scheme === AGENT_SCHEME && d.uri.path.split('/')[1] === name)
          .map((d) => ({ type: vscode.FileChangeType.Changed, uri: d.uri })),
      ),
    );
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (pinnedRef(uri)) {
      const size = await this.repos.statPinned(uri);
      if (size === undefined) throw vscode.FileSystemError.FileNotFound(uri);
      return { type: vscode.FileType.File, ctime: 0, mtime: 0, size };
    }
    const at = await this.repos.locate(uri);
    if (at?.snap.files.has(at.rel)) return { type: vscode.FileType.File, ctime: at.snap.time, mtime: at.snap.time, size: at.snap.files.get(at.rel)! };
    if (at?.snap.dirs.has(at.rel.replace(/\/$/, ''))) return { type: vscode.FileType.Directory, ctime: at.snap.time, mtime: at.snap.time, size: 0 };
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const at = await this.repos.locate(uri);
    if (!at) throw vscode.FileSystemError.FileNotFound(uri);
    const base = at.rel.replace(/\/$/, '');
    const prefix = base ? base + '/' : '';
    const out = new Map<string, vscode.FileType>();
    for (const f of at.snap.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const i = rest.indexOf('/');
      out.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? vscode.FileType.File : vscode.FileType.Directory);
    }
    return [...out];
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    if (pinnedRef(uri)) {
      const bytes = await this.repos.readPinned(uri);
      if (!bytes) throw vscode.FileSystemError.FileNotFound(uri);
      return bytes;
    }
    const at = await this.repos.locate(uri);
    if (!at?.snap.files.has(at.rel)) throw vscode.FileSystemError.FileNotFound(uri);
    return this.repos.read(at.snap, at.rel);
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}

/** Command: pick and open a file from the agents' branch. */
export async function openAgentFile(repos: AgentRepos): Promise<void> {
  if (!repos.available) {
    void vscode.window.showInformationMessage(t('agent.none'));
    return;
  }
  const files = await repos.allFiles();
  const pick = await vscode.window.showQuickPick(
    files.map((u) => ({ label: nodePath.basename(u.path), description: u.path.slice(1), u })),
    { title: t('agent.pickTitle', cfg.agentBranch()), matchOnDescription: true },
  );
  if (pick) await vscode.window.showTextDocument(pick.u, { preview: true });
}
