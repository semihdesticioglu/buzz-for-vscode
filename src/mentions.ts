// Mention notifications and the status bar item. History is not announced on the first run; only new mentions after that.
import * as vscode from 'vscode';
import { BuzzClient } from './api';
import { advanceCursor, CHANNEL_MESSAGE_KINDS, channelOf, FeedCursor, friendlyError, NostrEvent } from './core';
import * as cfg from './config';
import { t } from './i18n';
import { LiveManager } from './live';

const CURSOR = 'buzz.mentionCursor';
const SHOWN = 'buzz.mentionsShown'; // ids already announced (shared by all VS Code windows)
const LIVE_SUB = 'mentions';

export class MentionWatcher implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private unread = 0;
  private readonly bar: vscode.StatusBarItem;
  private readonly names = new Map<string, string>();
  private readonly notified = new Set<string>(); // live and polling must not announce the same message twice
  private readonly subs: vscode.Disposable[] = [];
  private pending: NostrEvent[] = []; // mentions that arrived while this window was not focused
  private disposed = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly client: BuzzClient,
    private readonly live: LiveManager,
  ) {
    this.bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.bar.command = 'buzz.showChat';
    this.render();
    this.bar.show();
    this.subs.push(
      live.onEvent((id, ev) => {
        if (id === LIVE_SUB) void this.onLive(ev);
      }),
      live.onState((s) => {
        if (s.state === 'live') void this.subscribeLive();
      }),
      // a window in the background keeps its toast until you come back to it (and drops it if another window showed it)
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) this.flushPending();
      }),
    );
  }

  /** `buzz.mentionSeconds` changed: 0 turns notifications off, anything else turns them (back) on. */
  settingsChanged(): void {
    if (cfg.mentionSeconds() <= 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.live.unsubscribe(LIVE_SUB);
    } else {
      this.schedule();
      if (this.live.isLive) void this.subscribeLive();
    }
  }

  start(delayMs = 4000): void {
    this.schedule(delayMs);
  }

  /** Re-renders the status bar item (e.g. after the UI language changed). */
  refresh(): void {
    this.render();
  }

  clearUnread(): void {
    this.unread = 0;
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.live.unsubscribe(LIVE_SUB);
    this.subs.forEach((d) => d.dispose());
    this.bar.dispose();
  }

  /** Live: messages that mention me arrive instantly. */
  private async subscribeLive(): Promise<void> {
    if (cfg.mentionSeconds() <= 0) return;
    try {
      if (!this.client.myPubkey) await this.client.me();
    } catch {
      return;
    }
    const me = this.client.myPubkey;
    if (me) this.live.subscribe(LIVE_SUB, [{ kinds: CHANNEL_MESSAGE_KINDS, '#p': [me], since: Math.floor(Date.now() / 1000) }]);
  }

  /** Ids announced so far; only the recent ones are kept. */
  private markNotified(id: string): void {
    this.notified.add(id);
    while (this.notified.size > 2000) this.notified.delete(this.notified.values().next().value as string);
  }

  private async onLive(ev: NostrEvent): Promise<void> {
    if (cfg.mentionSeconds() <= 0 || ev.pubkey === this.client.myPubkey || this.notified.has(ev.id)) return;
    this.markNotified(ev.id);
    await this.client.ensureProfiles([ev.pubkey]).catch(() => undefined);
    this.announce([ev]);
  }

  /** Counts the mentions and shows a toast in the focused window; a window in the background waits. */
  private announce(evs: NostrEvent[]): void {
    this.unread += evs.length;
    this.render();
    if (vscode.window.state.focused) void this.notify(evs);
    else this.pending.push(...evs);
  }

  private flushPending(): void {
    if (!this.pending.length) return;
    const shown = new Set(this.ctx.globalState.get<string[]>(SHOWN, []));
    const evs = this.pending.splice(0).filter((e) => !shown.has(e.id));
    if (evs.length) void this.notify(evs);
  }

  private render(): void {
    this.bar.text = this.unread ? `$(bell-dot) Buzz ${this.unread}` : '$(comment-discussion) Buzz';
    this.bar.tooltip = this.unread ? t('mention.unread', this.unread) : t('mention.openChat');
  }

  private schedule(ms?: number): void {
    if (this.timer) clearTimeout(this.timer);
    const s = cfg.mentionSeconds();
    if (s <= 0 || this.disposed) return;
    this.timer = setTimeout(() => void this.tick(), ms ?? s * 1000);
  }

  private async tick(): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const cur = this.ctx.globalState.get<FeedCursor>(CURSOR);
      if (!cur) {
        await this.ctx.globalState.update(CURSOR, { since: now, ids: [] });
        return;
      }
      if (!this.client.myPubkey) await this.client.me();
      const { fresh, next } = advanceCursor(
        cur,
        (await this.client.feed(cur.since)).filter((e) => e.pubkey !== this.client.myPubkey),
      );
      if (!fresh.length) return;
      await this.ctx.globalState.update(CURSOR, next);
      const evs = fresh.filter((e) => !this.notified.has(e.id)); // skip those already announced from the live connection
      evs.forEach((e) => this.markNotified(e.id));
      if (!evs.length) return;
      this.announce(evs);
    } catch {
      /* not set up or no network: wait for the next round quietly */
    } finally {
      this.schedule();
    }
  }

  private async notify(evs: NostrEvent[]): Promise<void> {
    const e = [...evs].sort((a, b) => b.created_at - a.created_at)[0];
    const ch = channelOf(e);
    const where = ch ? await this.channelName(ch) : undefined;
    const text = e.content.replace(/\s+/g, ' ').slice(0, 120);
    const who = this.client.nameOf(e.pubkey);
    const line = `${who}${where ? ` · ${where}` : ''}: ${text}`;
    const msg = evs.length === 1 ? line : t('mention.many', evs.length, line);
    // remembered for the other windows, so a window you come back to later does not show it again
    const shown = this.ctx.globalState.get<string[]>(SHOWN, []);
    void this.ctx.globalState.update(SHOWN, [...evs.map((x) => x.id), ...shown].slice(0, 300));
    const act = await vscode.window.showInformationMessage(`Buzz · ${msg}`, t('mention.open'));
    if (act) {
      this.clearUnread();
      try {
        if (ch) await vscode.commands.executeCommand('buzz.openChannel', ch, e.id);
        else await vscode.commands.executeCommand('buzz.showChat');
      } catch (err) {
        void vscode.window.showErrorMessage(`Buzz: ${friendlyError(err)}`);
      }
    }
  }

  private async channelName(id: string): Promise<string | undefined> {
    if (!this.names.has(id)) {
      try {
        for (const c of await this.client.allChannels()) for (const id of c.ids ?? [c.id]) this.names.set(id, c.isDm ? c.name : `#${c.name}`);
      } catch {
        /* stays unnamed */
      }
    }
    return this.names.get(id);
  }
}
