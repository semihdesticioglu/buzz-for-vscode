// "Show diff" for a branch or commit an agent reports: every changed file of the agents' repository in VS Code's
// changes editor (read-only, from git). Falls back to a file picker with the two-file diff view on older VS Code.
import * as nodePath from 'path';
import * as vscode from 'vscode';
import { agentRefUri, ChangeRange, worktreeQuery } from './agentRepo';
import { t } from './i18n';
import { ProposalDocuments } from './proposals';

export async function showChanges(range: ChangeRange, docs: ProposalDocuments): Promise<string | undefined> {
  if (!range.files.length) return t('git.noChanges', range.label);
  const left = (p?: string) => (p ? agentRefUri(range.name, p, range.base) : undefined);
  const right = (p?: string) => (p ? agentRefUri(range.name, p, range.worktree ? worktreeQuery(range.worktree) : range.tip) : undefined);
  const rows = range.files.map((f) => {
    const before = f.status === 'A' ? undefined : left(f.oldPath ?? f.path);
    const after = f.status === 'D' ? undefined : right(f.path);
    return { f, before, after, label: (after ?? before)! };
  });
  const title = t('git.title', range.label, range.files.length) + (range.note ? ` · ${range.note}` : '');
  try {
    await vscode.commands.executeCommand(
      'vscode.changes',
      title,
      rows.map((r) => [r.label, r.before, r.after]),
    );
    return undefined;
  } catch {
    // no changes editor: pick one file, show it in the two-file diff view
  }
  const pick =
    rows.length === 1
      ? rows[0]
      : (
          await vscode.window.showQuickPick(
            rows.map((r) => ({ label: nodePath.basename(r.f.path), description: `${r.f.status} · ${r.f.path}`, r })),
            { title, matchOnDescription: true },
          )
        )?.r;
  if (!pick) return undefined;
  const empty = (side: string) => docs.put(pick.f.path, `${range.tip}-${side}-empty`, '');
  await vscode.commands.executeCommand('vscode.diff', pick.before ?? empty('l'), pick.after ?? empty('r'), `${pick.f.path} · ${range.label}`, {
    preview: true,
  });
  return undefined;
}
