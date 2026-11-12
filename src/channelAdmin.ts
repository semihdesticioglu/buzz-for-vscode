// Channel management from VS Code: a new channel, joining one, adding a member. Short prompts over the Buzz CLI;
// the relay decides what is allowed and its answer is shown as is. Lists open at once and fill while they load.
import * as vscode from 'vscode';
import type { BuzzClient, Channel, Member } from './api';
import { friendlyError, isHex64, MEMBERS_KIND, NostrEvent, SetupError } from './core';
import { t } from './i18n';
import type { LiveManager } from './live';

export interface ChannelAdmin {
  client: BuzzClient;
  live: LiveManager;
  /** the channel open in the chat, if any */
  current: () => Channel | undefined;
  /** shows a channel in the chat (the list is read again when it is new) */
  open: (id: string) => Promise<void>;
}

/** Letters, digits, spaces and . _ - ; up to 80 characters. The relay may still refuse a name. */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u;

export async function newChannel(x: ChannelAdmin): Promise<void> {
  if (!(await ready(x))) return;
  const raw = await vscode.window.showInputBox({
    title: t('channel.newTitle'),
    prompt: t('channel.namePrompt'),
    placeHolder: 'data-platform',
    ignoreFocusOut: true,
    validateInput: (v) => (NAME.test(v.trim()) ? undefined : t('channel.nameInvalid')),
  });
  if (!raw) return;
  const name = raw.trim();
  const vis = await vscode.window.showQuickPick(
    [
      { label: t('channel.open'), description: t('channel.openDetail'), value: 'open' as const },
      { label: t('channel.private'), description: t('channel.privateDetail'), value: 'private' as const },
    ],
    { title: t('channel.visibilityTitle', name) },
  );
  if (!vis) return;
  const description = await vscode.window.showInputBox({
    title: t('channel.descriptionTitle', name),
    prompt: t('channel.descriptionPrompt'),
    ignoreFocusOut: true,
  });
  if (description === undefined) return;
  await run(t('channel.creating', name), async () => {
    let id = await x.client.createChannel({ name, visibility: vis.value, description: description.trim() || undefined });
    // an older CLI may answer without the id: the newest channel of that name in the fresh list is ours
    if (!id) {
      const same = (await x.client.channels().catch(() => [] as Channel[])).filter((c) => c.name === name);
      id = same.sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0]?.id;
    }
    if (id) await x.open(id);
    void vscode.window.showInformationMessage(t('channel.created', name));
  });
}

export async function joinChannel(x: ChannelAdmin): Promise<void> {
  if (!(await ready(x))) return;
  const pick = await pickWhileLoading({ title: t('channel.joinTitle'), placeholder: t('channel.listing'), empty: t('channel.joinEmpty') }, async () =>
    (await x.client.joinableChannels()).map((c) => ({ label: `$(comment-discussion) ${c.name}`, description: c.description, c })),
  );
  if (!pick) return;
  await run(t('channel.joining', pick.c.name), async () => {
    await x.client.joinChannel(pick.c.id);
    directoryCache = undefined;
    void vscode.window.showInformationMessage(t('channel.joined', pick.c.name));
    await x.open(pick.c.id);
  });
}

export async function addMember(x: ChannelAdmin): Promise<void> {
  if (!(await ready(x))) return;
  const cur = x.current();
  let target = cur && !cur.isDm ? cur : undefined;
  if (!target) {
    // real channels only: a direct message has its own command in Buzz and no name here
    const pick = await pickWhileLoading({ title: t('channel.pickChannel'), placeholder: t('channel.listing'), empty: t('channel.joinEmpty') }, async () =>
      (await x.client.allChannels()).filter((c) => !c.isDm && c.name).map((c) => ({ label: `# ${c.name}`, description: c.description, c })),
    );
    if (!pick) return;
    target = pick.c;
  }
  const ch = target;
  const pick = await pickWhileLoading(
    { title: t('channel.memberTitle', ch.name), placeholder: t('channel.memberPlaceholder'), empty: t('channel.memberEmpty', ch.name) },
    async () =>
      (await candidates(x, ch)).map((m: Member) => ({
        label: `${m.isAgent ? '$(hubot)' : '$(person)'} ${m.name}`,
        description: m.isAgent ? t('channel.agentTag') : undefined,
        m,
      })),
  );
  if (!pick) return;
  await run(t('channel.adding', pick.m.name, ch.name), async () => {
    await x.client.addMember(ch.id, pick.m.pubkey);
    directoryCache = undefined; // the channel's members changed
    void vscode.window.showInformationMessage(t('channel.memberAdded', pick.m.name, ch.name));
  });
}

/** The "+" of the chat and the view title: the three actions in one menu. */
export async function channelMenu(x: ChannelAdmin): Promise<void> {
  const cur = x.current();
  const items = [
    { label: t('channel.menuNew'), run: () => newChannel(x) },
    { label: t('channel.menuJoin'), run: () => joinChannel(x) },
    { label: cur && !cur.isDm ? t('channel.menuAdd', cur.name) : t('channel.menuAddAny'), run: () => addMember(x) },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: t('channel.menuTitle') });
  await pick?.run();
}

/** Before the first prompt: is Buzz set up? One identity read when the client has not connected yet. */
async function ready(x: ChannelAdmin): Promise<boolean> {
  if (x.client.myPubkey) return true;
  try {
    await x.client.me();
    return true;
  } catch (e) {
    if (e instanceof SetupError) {
      const setup = t('channel.setupFirst');
      const act = await vscode.window.showWarningMessage(friendlyError(e), setup);
      if (act === setup) void vscode.commands.executeCommand('buzz.setup');
    } else {
      void vscode.window.showErrorMessage(`Buzz: ${friendlyError(e)}`);
    }
    return false;
  }
}

const DIRECTORY_TTL = 60_000;
let directoryCache: { at: number; byChannel: Map<string, string[]> } | undefined;

/** Another identity or a reload: what was read for the previous one no longer applies. */
export function clearDirectory(): void {
  directoryCache = undefined;
}

/**
 * Who is in which of my channels, from one live query (the NIP-29 member lists that name me), kept for a minute.
 * Undefined without a complete live answer: the CLI path is used then (one call per channel, a few at a time).
 */
async function memberLists(x: ChannelAdmin): Promise<Map<string, string[]> | undefined> {
  if (directoryCache && Date.now() - directoryCache.at < DIRECTORY_TTL) return directoryCache.byChannel;
  const me = x.client.myPubkey;
  if (!me) return undefined;
  const res = await x.live.fetch([{ kinds: [MEMBERS_KIND], '#p': [me] }], 6_000).catch(() => undefined);
  if (!res?.complete || !res.events.length) return undefined;
  const byChannel = new Map<string, { at: number; members: string[] }>();
  for (const e of res.events as NostrEvent[]) {
    const d = e.tags.find((tag) => tag[0] === 'd')?.[1];
    if (!d) continue;
    const prev = byChannel.get(d);
    if (prev && prev.at >= e.created_at) continue; // an older copy of the same list
    byChannel.set(d, { at: e.created_at, members: e.tags.filter((tag) => tag[0] === 'p' && isHex64(tag[1] ?? '')).map((tag) => tag[1]) });
  }
  const out = new Map([...byChannel].map(([d, v]) => [d, v.members] as const));
  directoryCache = { at: Date.now(), byChannel: out };
  return out;
}

/** People and agents I share a channel with who are not in `ch` yet, agents first. */
async function candidates(x: ChannelAdmin, ch: Channel): Promise<Member[]> {
  const lists = await memberLists(x);
  if (!lists) {
    const [members, directory] = await Promise.all([x.client.members(ch.id), x.client.directory()]);
    const have = new Set(members.map((m) => m.pubkey));
    return directory.filter((m) => !have.has(m.pubkey));
  }
  const me = x.client.myPubkey;
  const have = new Set(lists.get(ch.id) ?? (await x.client.members(ch.id).catch(() => [] as Member[])).map((m) => m.pubkey));
  const all = [...new Set([...lists.values()].flat())].filter((p) => p !== me && !have.has(p));
  await x.client.ensureProfiles(all).catch(() => undefined);
  return all
    .map((pubkey) => ({ pubkey, name: x.client.nameOf(pubkey), isAgent: x.client.isAgent(pubkey) }))
    .sort((a, b) => Number(b.isAgent) - Number(a.isAgent) || a.name.localeCompare(b.name));
}

/** A quick pick that opens at once and fills while its items load; Escape before they arrive cancels. */
function pickWhileLoading<T extends vscode.QuickPickItem>(
  o: { title: string; placeholder: string; empty: string },
  load: () => Promise<T[]>,
): Promise<T | undefined> {
  const qp = vscode.window.createQuickPick<T>();
  qp.title = o.title;
  qp.placeholder = o.placeholder;
  qp.matchOnDescription = true;
  qp.busy = true;
  qp.show();
  let open = true;
  return new Promise<T | undefined>((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]);
      qp.hide();
    });
    qp.onDidHide(() => {
      open = false;
      resolve(undefined);
      qp.dispose();
    });
    load().then(
      (items) => {
        if (!open) return;
        qp.items = items;
        qp.busy = false;
        if (!items.length) qp.placeholder = o.empty;
      },
      (e) => {
        if (!open) return;
        qp.hide();
        void vscode.window.showErrorMessage(`Buzz: ${friendlyError(e)}`);
      },
    );
  });
}

/** Runs a CLI action behind a progress message; a failure becomes a Buzz error message and undefined. */
async function run<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);
  } catch (e) {
    void vscode.window.showErrorMessage(`Buzz: ${friendlyError(e)}`);
    return undefined;
  }
}
