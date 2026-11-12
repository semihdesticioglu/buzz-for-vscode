// Agent proposals in VS Code: "Show diff" opens the built-in diff view (current file ↔ proposed text),
// "Apply" writes the change into the open document without saving, with Save / Undo offered afterwards.
import * as vscode from 'vscode';
import { t } from './i18n';
import { applyPlan, Plan, planFiles } from './patch';
import { AGENT_SCHEME, AgentRepos } from './agentRepo';
import { isSafeRel, newFileUri, normalizeRel, resolveWorkspaceFile } from './refs';
import * as cfg from './config';

export const PROPOSAL_SCHEME = 'buzz-proposal';

/** Read-only documents holding proposed text for the diff view. */
export class ProposalDocuments implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? '';
  }

  put(path: string, tag: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: '/' + path.replace(/^\/+/, ''), query: tag });
    this.texts.set(uri.toString(), text);
    this.changed.fire(uri);
    // keep the store small: proposals are cheap to recompute
    if (this.texts.size > 60) this.texts.delete(this.texts.keys().next().value as string);
    return uri;
  }

  dispose(): void {
    this.changed.dispose();
    this.texts.clear();
  }
}

interface Target {
  path: string;
  uri: vscode.Uri;
  exists: boolean;
  before: string;
  after: string;
  version?: number; // document version right after Apply: Undo only when nothing changed since
}

/** When the proposal was written (seconds), to warn when line numbers may have moved since. */
export interface ProposalInfo {
  createdAt?: number;
}

/** Proposals never write into the repository's internals. */
const touchesGit = (path: string) =>
  normalizeRel(path)
    .split('/')
    .some((s) => s.toLowerCase() === '.git');

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function pickFile(plan: Plan): Promise<string | undefined> {
  const files = planFiles(plan);
  if (files.length === 1) return files[0];
  const pick = await vscode.window.showQuickPick(files, { title: t('patch.pickFile') });
  return pick;
}

/**
 * The proposed text for one file, or an error message when it can't be applied. Show diff reads the agents' copy
 * first (`agents`); Apply, which writes, reads the workspace only.
 */
async function target(plan: Plan, path: string, agents?: AgentRepos): Promise<Target | string | undefined> {
  if (!isSafeRel(path) || touchesGit(path)) return t('ref.outside', path);
  const isNew = plan.kind === 'unified' && !!plan.files.find((f) => f.path === path)?.isNew;
  let uri: vscode.Uri | undefined;
  let present = true;
  const found0 = isNew && agents ? await resolveWorkspaceFile(path, { agents }) : undefined;
  if (isNew && found0 instanceof vscode.Uri && found0.scheme === AGENT_SCHEME) {
    uri = found0; // the agents already have this file
  } else if (isNew) {
    // a new file goes exactly where the diff says; another file with a similar name is never touched
    uri = newFileUri(path);
    if (!uri) return t('patch.noFile');
    present = await exists(uri);
  } else {
    const found = await resolveWorkspaceFile(path, { agents });
    if (found === undefined) return undefined; // cancelled
    if (typeof found === 'string') return found;
    uri = found;
  }
  if (uri.scheme !== AGENT_SCHEME && !vscode.workspace.getWorkspaceFolder(uri)) return t('ref.outside', path);
  const before = present ? (await vscode.workspace.openTextDocument(uri)).getText() : '';
  const r = applyPlan(plan, path, before);
  if (!r.ok) {
    const why = { ambiguous: 'patch.ambiguous', applied: 'patch.alreadyApplied', exists: 'patch.exists', notFound: 'patch.notFound' } as const;
    return t(why[r.reason], path);
  }
  if (present && r.text === before) return t('patch.same', path);
  return { path, uri, exists: present, before, after: r.text };
}

/** Line-number proposals (`path:L10-L20` + code) only fit the file as it was when the message was written. */
async function changedSince(tg: Target, createdAt: number | undefined): Promise<boolean> {
  if (!tg.exists || !createdAt) return false;
  const doc = await vscode.workspace.openTextDocument(tg.uri);
  if (doc.isDirty) return true;
  try {
    return (await vscode.workspace.fs.stat(tg.uri)).mtime > createdAt * 1000;
  } catch {
    return false;
  }
}

/** Opens the diff view for the proposal. Returns an error message for the chat, if any. */
export async function showProposalDiff(docs: ProposalDocuments, plan: Plan, tag: string, agents: AgentRepos): Promise<string | undefined> {
  const path = await pickFile(plan);
  if (!path) return undefined;
  const tg = await target(plan, path, agents);
  if (!tg || typeof tg === 'string') return tg;
  await openDiff(docs, tg, tag);
  return undefined;
}

async function openDiff(docs: ProposalDocuments, tg: Target, tag: string): Promise<void> {
  const right = docs.put(tg.path, tag, tg.after);
  const left = tg.exists ? tg.uri : docs.put(tg.path, tag + '-empty', '');
  const title = tg.uri.scheme === AGENT_SCHEME ? t('patch.diffTitleAgent', tg.path, cfg.agentBranch()) : t('patch.diffTitle', tg.path);
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

/** Writes the proposal into the workspace (all files of a multi-file diff). Not saved automatically. */
export async function applyProposal(plan: Plan, docs?: ProposalDocuments, tag = '', info: ProposalInfo = {}): Promise<string | undefined> {
  const targets: Target[] = [];
  for (const path of planFiles(plan)) {
    const tg = await target(plan, path);
    if (!tg) return undefined;
    if (typeof tg === 'string') return tg;
    targets.push(tg);
  }
  // line numbers from the message may point elsewhere once the file changed (also after applying another block)
  if (plan.kind === 'replace' && (await changedSince(targets[0], info.createdAt))) {
    const showDiff = t('patch.showDiff');
    const anyway = t('patch.applyAnyway');
    const act = await vscode.window.showWarningMessage(t('patch.changedSince', targets[0].path), { modal: true }, showDiff, anyway);
    if (act === showDiff && docs) await openDiff(docs, targets[0], tag);
    if (act !== anyway) return undefined;
  }
  // a file that changed while the user was answering a prompt: start over instead of overwriting it
  for (const tg of targets) {
    if (tg.exists && (await vscode.workspace.openTextDocument(tg.uri)).getText() !== tg.before) return t('patch.changedMeanwhile', tg.path);
  }
  const edit = new vscode.WorkspaceEdit();
  for (const tg of targets) {
    if (tg.exists) {
      const doc = await vscode.workspace.openTextDocument(tg.uri);
      edit.replace(tg.uri, new vscode.Range(0, 0, doc.lineCount, 0), tg.after);
    } else {
      edit.createFile(tg.uri, { ignoreIfExists: true });
      edit.insert(tg.uri, new vscode.Position(0, 0), tg.after);
    }
  }
  if (!(await vscode.workspace.applyEdit(edit))) return t('patch.notFound', targets.map((x) => x.path).join(', '));
  for (const tg of targets) tg.version = (await vscode.workspace.openTextDocument(tg.uri)).version;
  const first = targets[0];
  const doc = await vscode.workspace.openTextDocument(first.uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  void offerSaveOrUndo(targets);
  return undefined;
}

async function offerSaveOrUndo(targets: Target[]): Promise<void> {
  const names = targets.map((x) => x.path.split('/').pop()).join(', ');
  const act = await vscode.window.showInformationMessage(t('patch.applied', names), t('patch.save'), t('patch.undo'));
  if (act === t('patch.save')) {
    for (const tg of targets) await (await vscode.workspace.openTextDocument(tg.uri)).save();
  } else if (act === t('patch.undo')) {
    // only files untouched since Apply are restored: later edits are never thrown away
    const edit = new vscode.WorkspaceEdit();
    const skipped: string[] = [];
    for (const tg of targets) {
      const doc = await vscode.workspace.openTextDocument(tg.uri);
      if (doc.version !== tg.version) {
        skipped.push(tg.path);
        continue;
      }
      if (tg.exists) edit.replace(tg.uri, new vscode.Range(0, 0, doc.lineCount, 0), tg.before);
      else edit.deleteFile(tg.uri, { ignoreIfNotExists: true });
    }
    await vscode.workspace.applyEdit(edit);
    if (skipped.length) void vscode.window.showWarningMessage(t('patch.undoSkipped', skipped.join(', ')));
  }
}
