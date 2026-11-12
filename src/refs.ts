// Opens a file:line reference from a message in the editor (searches the workspace; asks when several files match).
import * as vscode from 'vscode';
import type { AgentRepos } from './agentRepo';
import { isSafeRel, normalizeRel } from './core';
import { t } from './i18n';

const EXCLUDE = '**/{node_modules,.git,out,dist,.venv}/**';

export { isSafeRel, normalizeRel };

/** With several workspace folders, VS Code writes paths as "folder/rest": split off a known folder name. */
function inNamedFolder(rel: string): { folder: vscode.WorkspaceFolder; rest: string } | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length < 2) return undefined;
  const [first, ...rest] = rel.split('/');
  const folder = folders.find((f) => f.name === first);
  return folder && rest.length ? { folder, rest: rest.join('/') } : undefined;
}

/**
 * Find a workspace file for a relative path. Exact location under a workspace folder wins;
 * otherwise searches by suffix and asks when there are several. Returns undefined when cancelled,
 * an error string when nothing matches.
 */
export async function resolveWorkspaceFile(path: string, opts: { agents?: AgentRepos } = {}): Promise<vscode.Uri | string | undefined> {
  const rel = normalizeRel(path);
  if (!isSafeRel(path)) return t('ref.outside', path);
  // the agents' copy first (read-only, their branch): that is the code their messages are about
  if (opts.agents) {
    const hits = await opts.agents.resolve(path);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const pick = await vscode.window.showQuickPick(
        hits.map((u) => ({ label: u.path.slice(1), u })),
        { title: t('ref.pickTitle', rel), placeHolder: t('ref.pickPlaceholder') },
      );
      return pick?.u;
    }
  }
  const found: vscode.Uri[] = [];
  const named = inNamedFolder(rel);
  const tries = named
    ? [vscode.Uri.joinPath(named.folder.uri, named.rest)]
    : (vscode.workspace.workspaceFolders ?? []).map((f) => vscode.Uri.joinPath(f.uri, rel));
  for (const u of tries) {
    try {
      await vscode.workspace.fs.stat(u);
      found.push(u);
    } catch {
      /* not in this folder */
    }
  }
  if (!found.length && !/[*?[\]{}]/.test(rel)) found.push(...(await vscode.workspace.findFiles(`**/${rel}`, EXCLUDE, 20)));
  if (!found.length) return t('ref.notFound', rel);
  if (found.length === 1) return found[0];
  const pick = await vscode.window.showQuickPick(
    found.map((u) => ({ label: vscode.workspace.asRelativePath(u), u })),
    { title: t('ref.pickTitle', rel), placeHolder: t('ref.pickPlaceholder') },
  );
  return pick?.u;
}

/** Where a brand-new file proposed by an agent would be created (first workspace folder). */
export function newFileUri(path: string): vscode.Uri | undefined {
  if (!isSafeRel(path)) return undefined;
  const rel = normalizeRel(path);
  const named = inNamedFolder(rel);
  if (named) return vscode.Uri.joinPath(named.folder.uri, named.rest);
  const root = vscode.workspace.workspaceFolders?.[0];
  return root ? vscode.Uri.joinPath(root.uri, rel) : undefined;
}

/** Opens a file reference from a message: the agents' copy when they have the file, otherwise the workspace. */
export async function openFileRef(
  path: string,
  line: number | undefined,
  end: number | undefined,
  beside: boolean,
  agents: AgentRepos,
): Promise<string | undefined> {
  const uri = await resolveWorkspaceFile(path, { agents });
  if (!uri || typeof uri === 'string') return uri;
  const doc = await vscode.workspace.openTextDocument(uri);
  const last = Math.max(0, doc.lineCount - 1);
  const a = Math.min(Math.max((line ?? 1) - 1, 0), last);
  const b = Math.min(Math.max((end ?? line ?? 1) - 1, a), last);
  const editor = await vscode.window.showTextDocument(doc, {
    preview: true,
    viewColumn: beside ? vscode.ViewColumn.Beside : undefined,
    selection: new vscode.Range(a, 0, line ? b : a, line ? doc.lineAt(b).text.length : 0),
  });
  editor.revealRange(new vscode.Range(a, 0, b, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  return undefined;
}
