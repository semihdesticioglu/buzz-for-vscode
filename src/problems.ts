// Send a problem (Problems panel / editor squiggle) or a terminal selection to the chat as context,
// so it can be sent to an agent with an @mention. Problems show up as a quick fix (lightbulb, Ctrl+.),
// which VS Code also offers inside the Problems panel.
import * as vscode from 'vscode';
import { relPathOf } from './agentRepo';
import { CodeContext } from './core';
import { t } from './i18n';

const CONTEXT_LINES = 3;
const MAX_TERMINAL_CHARS = 16000;

export class SendProblemActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    return context.diagnostics.slice(0, 3).map((d) => {
      const a = new vscode.CodeAction(
        context.diagnostics.length > 1 ? `${t('fix.sendError')}: ${firstLine(d.message)}` : t('fix.sendError'),
        vscode.CodeActionKind.QuickFix,
      );
      a.command = { command: 'buzz.sendProblem', title: t('fix.sendError'), arguments: [doc.uri, d] };
      a.diagnostics = [d];
      return a;
    });
  }
}

const firstLine = (s: string) => s.split(/\r?\n/)[0].slice(0, 80);

function codeOf(d: vscode.Diagnostic): string {
  const c = d.code;
  if (c === undefined || c === '') return '';
  return typeof c === 'object' ? String(c.value) : String(c);
}

/** The problem plus a few lines around it, as a chat context. */
export function contextFromProblem(doc: vscode.TextDocument, d: vscode.Diagnostic): CodeContext {
  const from = Math.max(0, d.range.start.line - CONTEXT_LINES);
  const to = Math.min(doc.lineCount - 1, d.range.end.line + CONTEXT_LINES);
  const code = doc.getText(new vscode.Range(from, 0, to, doc.lineAt(to).text.length));
  const src = [d.source, codeOf(d)].filter(Boolean).join(' ');
  return {
    kind: 'error',
    relPath: relPathOf(doc.uri),
    startLine: from + 1,
    endLine: to + 1,
    languageId: doc.languageId,
    code,
    message: `${t('ctx.line', d.range.start.line + 1)}: ${d.message}${src ? ` (${src})` : ''}`,
  };
}

/** Problem from the quick fix arguments, or the one(s) on the cursor line of the active editor. */
export async function pickProblem(uri?: vscode.Uri, diag?: vscode.Diagnostic): Promise<CodeContext | undefined> {
  if (uri && diag) return contextFromProblem(await vscode.workspace.openTextDocument(uri), diag);
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    void vscode.window.showInformationMessage(t('diag.none'));
    return undefined;
  }
  const line = ed.selection.active.line;
  const here = vscode.languages
    .getDiagnostics(ed.document.uri)
    .filter((d) => d.range.start.line <= line && d.range.end.line >= line)
    .sort((a, b) => a.severity - b.severity);
  if (!here.length) {
    void vscode.window.showInformationMessage(t('diag.none'));
    return undefined;
  }
  let d = here[0];
  if (here.length > 1) {
    const pick = await vscode.window.showQuickPick(
      here.map((x) => ({ label: firstLine(x.message), description: [x.source, codeOf(x)].filter(Boolean).join(' '), d: x })),
      { title: t('diag.pick') },
    );
    if (!pick) return undefined;
    d = pick.d;
  }
  return contextFromProblem(ed.document, d);
}

/**
 * The selected text of the active terminal. Uses Terminal.selection when the VS Code version has it,
 * otherwise copies the selection through the clipboard and puts the previous clipboard text back.
 */
export async function terminalSelection(): Promise<CodeContext | undefined> {
  const term = vscode.window.activeTerminal;
  if (!term) {
    void vscode.window.showInformationMessage(t('term.noSelection'));
    return undefined;
  }
  let text = (term as { selection?: unknown }).selection;
  if (typeof text !== 'string') {
    const previous = await vscode.env.clipboard.readText();
    const marker = `buzz-no-selection-${Date.now()}`;
    await vscode.env.clipboard.writeText(marker);
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    const copied = await vscode.env.clipboard.readText();
    await vscode.env.clipboard.writeText(previous);
    text = copied === marker ? '' : copied;
  }
  const s = String(text ?? '').replace(/\s+$/, '');
  if (!s.trim()) {
    void vscode.window.showInformationMessage(t('term.noSelection'));
    return undefined;
  }
  const code = s.length > MAX_TERMINAL_CHARS ? '…\n' + s.slice(-MAX_TERMINAL_CHARS) : s;
  return { kind: 'terminal', relPath: '', startLine: 0, endLine: 0, languageId: 'text', code, message: term.name };
}
