// Sends the editor selection or the git diff to a channel; the picked agents are mentioned.
import * as nodePath from 'path';
import * as vscode from 'vscode';
import { BuzzClient, Channel, Member } from './api';
import { contextFromEditor } from './chat';
import { composeCodeMessage, friendlyError, MAX_CONTENT_BYTES, publicRepoUrl, truncateBytes, utf8Bytes } from './core';
import { t } from './i18n';
import { runGit } from './git';

const LAST_CHANNEL = 'buzz.lastSendChannel';
const LAST_MENTIONS = 'buzz.lastMentions';

async function pickChannel(ctx: vscode.ExtensionContext, client: BuzzClient): Promise<Channel | undefined> {
  const all = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('send.loadingChannels') }, () => client.allChannels());
  const last = ctx.globalState.get<string>(LAST_CHANNEL);
  all.sort((a, b) => Number(b.id === last) - Number(a.id === last));
  const pick = await vscode.window.showQuickPick(
    all.map((c) => ({
      label: `${c.isDm ? '$(person)' : '$(comment-discussion)'} ${c.name}`,
      description: c.id === last ? t('send.lastUsed') : (c.description ?? ''),
      ch: c,
    })),
    { title: t('send.pickChannel'), placeHolder: t('send.pickChannelPh'), matchOnDescription: true },
  );
  if (pick) await ctx.globalState.update(LAST_CHANNEL, pick.ch.id);
  return pick?.ch;
}

async function pickMentions(ctx: vscode.ExtensionContext, client: BuzzClient, ch: Channel): Promise<Member[] | undefined> {
  const members = await client.members(ch.id).catch(() => [] as Member[]);
  const last = new Set(ctx.globalState.get<string[]>(LAST_MENTIONS, []));
  const items = members
    .filter((m) => m.pubkey !== client.myPubkey)
    .map((m) => ({
      label: `${m.isAgent ? '$(hubot)' : '$(account)'} ${m.name}`,
      description: m.isAgent ? t('send.agent') : (m.role ?? ''),
      picked: last.has(m.pubkey),
      m,
    }));
  if (!items.length) return [];
  const picks = await vscode.window.showQuickPick(items, {
    title: t('send.pickMentions'),
    placeHolder: t('send.pickMentionsPh'),
    canPickMany: true,
  });
  if (!picks) return undefined;
  await ctx.globalState.update(
    LAST_MENTIONS,
    picks.map((p) => p.m.pubkey),
  );
  return picks.map((p) => p.m);
}

async function afterSend(ch: Channel, extra = ''): Promise<void> {
  const act = await vscode.window.showInformationMessage(t('send.sent', `${ch.isDm ? '' : '#'}${ch.name}${extra}`), t('send.openInChat'));
  if (act) await vscode.commands.executeCommand('buzz.openChannel', ch.id);
}

export async function sendSelection(ctx: vscode.ExtensionContext, client: BuzzClient): Promise<void> {
  const c = contextFromEditor(vscode.window.activeTextEditor);
  if (!c) {
    void vscode.window.showInformationMessage(t('sel.none'));
    return;
  }
  try {
    if (!client.myPubkey) await client.me();
    const ch = await pickChannel(ctx, client);
    if (!ch) return;
    const mentions = await pickMentions(ctx, client, ch);
    if (!mentions) return;
    const note = await vscode.window.showInputBox({ title: t('send.noteTitle'), placeHolder: t('send.notePh'), ignoreFocusOut: true });
    if (note === undefined) return;
    const content = composeCodeMessage(
      mentions.map((m) => m.name),
      note,
      c,
    );
    if (utf8Bytes(content) > MAX_CONTENT_BYTES) {
      void vscode.window.showWarningMessage(t('send.tooBig'));
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('send.sending') }, () =>
      client.send(ch.id, content, { mentions: mentions.map((m) => m.pubkey) }),
    );
    await afterSend(ch);
  } catch (e) {
    void vscode.window.showErrorMessage(`Buzz: ${friendlyError(e)}`);
  }
}

// A plain patch whatever the user's git config says (external diff tools, colors, no prefixes, textconv).
const DIFF_FLAGS = ['-c', 'color.ui=never', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];

/** Which folder's repository: the one clicked in Source Control, else the active file's folder, else the first. */
function repoDir(sc?: { rootUri?: vscode.Uri }): string | undefined {
  if (sc?.rootUri?.scheme === 'file') return sc.rootUri.fsPath;
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.uri.scheme === 'file') return nodePath.dirname(doc.uri.fsPath);
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export async function sendDiff(ctx: vscode.ExtensionContext, client: BuzzClient, sc?: { rootUri?: vscode.Uri }): Promise<void> {
  const dir = repoDir(sc);
  if (!dir) {
    void vscode.window.showInformationMessage(t('send.noRepo'));
    return;
  }
  try {
    const root = (await runGit(dir, ['rev-parse', '--show-toplevel'])).trim();
    const which = await vscode.window.showQuickPick(
      [
        { label: t('send.allChanges'), description: t('send.allChangesDesc'), args: [...DIFF_FLAGS, 'HEAD'] },
        { label: t('send.stagedOnly'), description: 'git diff --cached', args: [...DIFF_FLAGS, '--cached'] },
      ],
      { title: t('send.whichChanges') },
    );
    if (!which) return;
    const diff = await runGit(root, which.args);
    if (!diff.trim()) {
      void vscode.window.showInformationMessage(t('send.noChanges'));
      return;
    }
    const commit = (await runGit(root, ['rev-parse', 'HEAD'])).trim();
    const branch = (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const origin = (await runGit(root, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
    // never the raw remote: it can carry a token (https://user:token@host/...)
    const repo = publicRepoUrl(origin);
    if (!client.myPubkey) await client.me();
    const ch = await pickChannel(ctx, client);
    if (!ch) return;
    const mentions = await pickMentions(ctx, client, ch);
    if (!mentions) return;
    const note = await vscode.window.showInputBox({ title: t('send.descTitle'), placeHolder: t('send.descPh'), ignoreFocusOut: true });
    if (note === undefined) return;
    if (!repo) {
      // no web address for the repository (local repo, unusual remote): the diff goes as a normal message
      const ask = mentions.length ? `${mentions.map((m) => '@' + m.name).join(' ')} ${note || t('send.reviewAsk')}` : note;
      const head = [ask, `\`${branch && branch !== 'HEAD' ? branch : commit.slice(0, 8)}\``].filter(Boolean).join('\n\n');
      const room = MAX_CONTENT_BYTES - utf8Bytes(head) - 64;
      const body = truncateBytes(diff, room);
      const content = `${head}\n\n\`\`\`diff\n${body.replace(/\n$/, '')}\n\`\`\``;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('send.sendingDiff') }, () =>
        client.send(ch.id, content, { mentions: mentions.map((m) => m.pubkey) }),
      );
      await afterSend(ch, body.length < diff.length ? t('send.diffTruncated') : '');
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('send.sendingDiff') }, async () => {
      const r = await client.sendDiff(ch.id, diff, {
        repo,
        commit,
        description: note || undefined,
        sourceBranch: branch && branch !== 'HEAD' ? branch : undefined,
      });
      if (mentions.length) {
        const text = `${mentions.map((m) => '@' + m.name).join(' ')} ${note || t('send.reviewAsk')}`;
        await client.send(ch.id, text, { mentions: mentions.map((m) => m.pubkey), replyTo: r.event_id });
      }
    });
    await afterSend(ch, utf8Bytes(diff) > 61440 ? t('send.diffTruncated') : '');
  } catch (e) {
    void vscode.window.showErrorMessage(`Buzz: ${friendlyError(e)}`);
  }
}
