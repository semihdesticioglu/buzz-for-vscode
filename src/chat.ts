// Buzz chat: channel notes (post-its) on top, threads on the left, the selected thread on the right.
import * as vscode from 'vscode';
import { AgentRepos, relPathOf } from './agentRepo';
import { showChanges } from './gitChanges';
import { BuzzClient, Channel, Member, SendResult, THREAD_PAGE } from './api';
import {
  BuzzError,
  CHANNEL_MESSAGE_KINDS,
  channelOf,
  chipColor,
  CliExit,
  codeBlock,
  CodeContext,
  contextLabel,
  deletedIdsOf,
  formatHours,
  friendlyError,
  groupThreads,
  initials,
  isHex64,
  JIRA_ISSUE_KEY,
  MAX_CONTENT_BYTES,
  NostrEvent,
  parseTyping,
  plainSnippet,
  reconcilePage,
  replyRootOf,
  SetupError,
  shortTime,
  ThreadEntry,
  ThreadGroup,
  threadOrder,
  TYPING_KIND,
  utf8Bytes,
  EventPage,
  eventPage,
  ReportedRows,
  rowsSent,
  cleanDrafts,
} from './core';
import { chatHtml } from './chatHtml';
import { MessageRenderer } from './chatRender';
import * as cfg from './config';
import { lang, t, webviewStrings } from './i18n';
import { JiraError, JiraService } from './jira';
import { LiveManager } from './live';
import { applyProposal, ProposalDocuments, showProposalDiff } from './proposals';
import { PresenceTracker } from './presence';
import { FromWebview, MessageItem, SearchRow, SearchScope, ThreadRow, ToWebview } from './protocol';
import { LensMessage, parseSearch } from './lensCore';
import { openFileRef } from './refs';
import { log } from './log';

const LAST_CHANNEL = 'buzz.lastChannel';
const DRAFTS = 'buzz.drafts'; // workspaceState: per window, shared by the side bar and the editor tab
const LEFT_THREADS_MAX = 2000; // threads remembered of channels left: a message typed there a moment ago still finds its conversation
/** Channel message kinds (same as buzz-cli 'messages get'). */
const TYPING_SEND_EVERY = 3000; // ms: how often our own typing signal is sent while typing
const PRESENCE_EVERY = 60_000; // ms
const RECONCILE_EVERY = 60_000; // ms: re-read the latest page to catch deletions and edits made elsewhere
const RECONCILE_MIN_GAP = 5_000; // ms: at most this often when other channel events trigger it
const PAGE = 100;
const INCREMENTAL_LIMIT = 50; // messages read per poll
const LIVE_BATCH_MS = 120; // live messages arriving together are handled together
const POLL_LIVE_MS = 30_000; // polling is only a safety net while the live connection is up
const POLL_EXPECTING_MS = 2_500; // ... but fast while an answer is expected
const EXPECT_ANSWER_S = 180; // how long an answer is expected after sending
const RECONCILE_MIN_WAIT = 1_500; // ms
const PRESENCE_MAX_KEYS = 200;
const MAX_CONTEXT_LINES = 400; // lines sent when nothing is selected
const ROOTS_CLI_BATCH = 3; // threads fetched at once by the CLI when there is no live connection
const MIN_THREADS = 30; // the list should more than fill the screen: more pages are read until this many threads show
const FILL_PAGES = 10; // at most this many extra pages for that
const LIVE_PAGE = 200; // messages per page over the live connection (the relay's history page)
const OLDER_PASSES = 5; // pages skipped in one go when they hold only messages already shown (a long thread was opened)
const ROOTS_PER_FETCH = 30; // first messages fetched at once when the pages did not include them
const MAX_CONVERSATIONS = 6; // conversations read behind one DM note (Buzz may hold several with the same people)
const ROOTS_RETRY_MS = 60_000; // first messages nobody could confirm are looked for again after this long
const THREAD_PAGES_MAX = 20; // older pages read over the live connection for one thread (20 × 500 messages)
const SEARCH_LIMIT = 300; // matches read per search (relevance order); more than this is reported as capped

export interface Host {
  kind: 'view' | 'panel';
  webview: vscode.Webview;
  isVisible(): boolean;
  onVisibility(cb: () => void): vscode.Disposable;
  onDispose(cb: () => void): vscode.Disposable;
  reveal(): void;
  /** the editor tab: close it (the side bar chat comes back); the side bar view: nothing */
  close(): void;
}

/** The editor selection as context (empty selection: the whole file, up to 400 lines). */
export function contextFromEditor(editor: vscode.TextEditor | undefined): CodeContext | undefined {
  if (!editor) return undefined;
  const doc = editor.document;
  let sel: vscode.Range = editor.selection;
  if (editor.selection.isEmpty) {
    const last = Math.min(doc.lineCount - 1, MAX_CONTEXT_LINES - 1);
    sel = new vscode.Range(0, 0, last, doc.lineAt(last).text.length);
  }
  const start = sel.start.line + 1;
  let end = sel.end.line + 1;
  if (sel.end.character === 0 && sel.end.line > sel.start.line) end -= 1;
  const code = doc.getText(sel);
  if (!code.trim()) return undefined;
  return { kind: 'code', relPath: relPathOf(doc.uri), startLine: start, endLine: end, languageId: doc.languageId, code };
}

/** The thread the composer showed when Enter was pressed: a root id, null for "New thread", undefined when unknown. */
function threadFromView(v: unknown): string | null | undefined {
  if (v === null) return null;
  return typeof v === 'string' && isHex64(v) ? v : undefined;
}

export class ChatController implements vscode.Disposable {
  private host?: Host;
  private subs: vscode.Disposable[] = [];
  private channels: Channel[] = [];
  private current?: Channel;
  private members: Member[] = [];
  private byId = new Map<string, NostrEvent>();
  private lastTs = 0;
  private timer?: NodeJS.Timeout;
  private contexts: CodeContext[] = [];
  private typingTimer?: NodeJS.Timeout;
  private lastTypingSent = 0;
  private presenceTimer?: NodeJS.Timeout;
  private deleted = new Set<string>(); // messages deleted in Buzz: never shown again
  private pageSeen = new Set<string>(); // ids a 'messages get' page has returned (see reconcilePage)
  private lastReconcile = 0;
  private readonly leftThreads = new Map<string, string>(); // root id -> its conversation, of channels left (sendElsewhere)
  private readonly reported = new ReportedRows(); // malformed rows already logged
  private reconcileTimer?: NodeJS.Timeout;
  private loggedKinds = new Set<number>();
  private polling = false;
  private webviewReady = false;
  private openThread?: string; // root id of the selected thread
  private shown = new Set<string>(); // messages shown in the open thread
  private awaitingRoot = 0; // a new thread was sent: open it when my root message arrives
  private pendingEvent?: { id: string; channel: string }; // message from a notification: open its thread once the channel loads
  private selectSeq = 0; // the latest channel load; an older one that finishes later is dropped
  private selecting = false; // a channel is loading: the thread list is posted once, when it is complete
  private oldest = new Map<string, number>(); // per conversation: the oldest message of the pages read (the "Load older" cursor)
  private exhausted = new Set<string>(); // conversations with nothing older than what was read
  private noOlder = false; // every conversation of the channel is exhausted
  private rootsTried = new Set<string>(); // first messages already looked for (missing from the pages)
  private rootsRetryAt = 0; // ms: first messages nobody could confirm are looked for again after this time
  private membersOf?: string; // the channel `members` belong to
  private searchSeq = 0; // the latest search; an older one that finishes later is dropped
  private olderInFlight?: Promise<void>; // one "Older threads" read at a time (the fill loop and the button share it)
  private olderSeq = 0; // the selection that read belongs to
  private partialThreads = new Set<string>(); // threads whose oldest part could not be read (no live connection)
  private expectUntil = 0; // after sending, poll faster until this time
  private readonly subId = 'chat-' + Math.random().toString(36).slice(2, 10); // live subscription id
  private liveQueue: NostrEvent[] = [];
  private liveTimer?: NodeJS.Timeout;
  private readonly renderer: MessageRenderer; // what messages look like on screen, cached per message
  private readonly tracker: PresenceTracker; // who is online, typing or working
  private lastOffline?: boolean; // what the webview was last told about the channel's agents (Buzz Desktop closed?)
  private desktopTimers: NodeJS.Timeout[] = []; // presence re-reads after Buzz Desktop was started from the chat

  constructor(
    private readonly ext: vscode.ExtensionContext,
    private readonly client: BuzzClient,
    private readonly live: LiveManager,
    private readonly jira: JiraService,
    private readonly docs: ProposalDocuments,
    private readonly repos: AgentRepos,
  ) {
    this.renderer = new MessageRenderer(client, () => this.imageHost());
    this.tracker = new PresenceTracker(client);
  }

  private get typingSub(): string {
    return this.subId + '-typing';
  }

  /** Everything else in the channel (deletions, edits, reactions…), kept apart so a rejected filter can't stop messages. */
  private get otherSub(): string {
    return this.subId + '-other';
  }

  attach(host: Host): void {
    this.host = host;
    const w = host.webview;
    const media = vscode.Uri.joinPath(this.ext.extensionUri, 'media');
    w.options = { enableScripts: true, localResourceRoots: [media] };
    w.html = chatHtml(w, media, this.imageHost());
    this.subs.push(
      w.onDidReceiveMessage((m: FromWebview) => this.onMessage(m)),
      // refresh right away when the view becomes visible
      host.onVisibility(() => {
        if (host.isVisible()) {
          void this.poll().then(() => this.schedule());
          void this.refreshPresence();
        } else {
          this.schedule();
        }
      }),
      host.onDispose(() => this.dispose()),
      this.live.onEvent((id, ev) => this.onLiveEvent(id, ev)),
      this.live.onState((s) => {
        this.post({ type: 'live', state: s.state, detail: s.detail, reason: s.reason });
        if (s.state === 'live') void this.poll(); // catch up on what was missed while disconnected
        this.schedule();
      }),
    );
    this.presenceTimer = setInterval(() => {
      if (this.host?.isVisible()) void this.refreshPresence();
    }, PRESENCE_EVERY);
  }

  dispose(): void {
    this.selectSeq++; // loads still in flight are dropped
    if (this.timer) clearTimeout(this.timer);
    clearTimeout(this.liveTimer);
    clearTimeout(this.typingTimer);
    clearTimeout(this.reconcileTimer);
    clearInterval(this.presenceTimer);
    this.desktopTimers.forEach(clearTimeout);
    this.live.unsubscribe(this.subId);
    this.live.unsubscribe(this.typingSub);
    this.live.unsubscribe(this.otherSub);
    this.subs.forEach((d) => d.dispose());
    this.subs = [];
    this.host = undefined;
  }

  get alive(): boolean {
    return !!this.host;
  }

  /** The channel on screen. */
  get channel(): Channel | undefined {
    return this.current;
  }

  reveal(): void {
    this.host?.reveal();
  }

  /** Closes the editor tab (nothing for the side bar view). */
  close(): void {
    this.host?.close();
  }

  async openChannel(id: string, eventId?: string): Promise<void> {
    await this.ext.globalState.update(LAST_CHANNEL, id);
    this.pendingEvent = eventId ? { id: eventId, channel: id } : undefined;
    if (!this.host || !this.webviewReady) return; // 'ready' opens the last channel once the webview loads
    // a channel created or joined after the list was read (a new DM, a Lens hit): read the list again
    if (!this.findChannel(id)) {
      try {
        await this.loadChannels();
      } catch {
        this.pendingEvent = undefined;
        return; // reported on the setup card already (channels, ready:false)
      }
    }
    const ch = this.findChannel(id);
    if (!ch) {
      this.pendingEvent = undefined;
      this.post({ type: 'toast', message: t('chat.channelUnavailable') });
      return;
    }
    if (this.current?.id === ch.id && !this.selecting) {
      // the channel is already on screen: select the thread in place, the list stays as it is
      this.pendingEvent = undefined;
      if (eventId) await this.focusEvent(eventId, id);
      return;
    }
    await this.select(ch.id);
  }

  /** The channel with this id, also when the id is one of the conversations behind a DM note. */
  private findChannel(id: string | undefined): Channel | undefined {
    return id ? this.channels.find((c) => c.id === id || c.ids?.includes(id)) : undefined;
  }

  /** Every conversation behind the channel on screen (a DM may hold several, see api.dms). */
  private ids(ch: Channel): string[] {
    return ch.ids ?? [ch.id];
  }

  /** Does this event belong to the channel on screen? */
  private isOurs(ev: NostrEvent): boolean {
    const c = channelOf(ev);
    return !!this.current && !!c && this.ids(this.current).includes(c);
  }

  /** The conversation a thread lives in (where its root, or any message of it, was posted); the newest one otherwise. */
  private conversationOf(threadRoot?: string): string {
    return this.current ? this.conversationIn(this.current, threadRoot) : '';
  }

  /** The same for a given channel (a DM note stands for several conversations with the same people). */
  private conversationIn(ch: Channel, threadRoot?: string): string {
    if (!threadRoot || !ch.ids) return ch.id;
    const e = this.byId.get(threadRoot) ?? [...this.byId.values()].find((x) => replyRootOf(x) === threadRoot);
    // the channel being left: its messages are gone from byId once the switch began, where its threads live is not
    const c = (e && channelOf(e)) || this.leftThreads.get(threadRoot);
    return c && ch.ids.includes(c) ? c : ch.id;
  }

  /** The conversation of every thread loaded, by root id (only a DM note has more than one). */
  private threadHomes(): Map<string, string> {
    const homes = new Map<string, string>();
    for (const e of this.byId.values()) {
      const c = channelOf(e);
      const root = replyRootOf(e);
      // the root's own conversation decides; a reply only stands in for a root that is not loaded (one posted into
      // another conversation by an older version must not redirect its thread)
      if (c && (!root || !homes.has(root))) homes.set(root ?? e.id, c);
    }
    return homes;
  }

  /** The latest page of every conversation behind the channel, each next to its conversation id. */
  private async readPages(ch: Channel, opts: { limit?: number; since?: number } = {}): Promise<{ id: string; page: NostrEvent[] }[]> {
    const ids = this.ids(ch).slice(0, MAX_CONVERSATIONS);
    return Promise.all(
      ids.map(async (id) => ({
        id,
        page: this.wellFormed(await this.client.messages(id, { limit: opts.limit ?? PAGE, since: opts.since }), `messages of ${id.slice(0, 8)}`),
      })),
    );
  }

  /**
   * CLI rows that are not messages (a null, a number for content, no key, no time) are dropped, not trusted. The page
   * keeps their count (EventPage: a full page stays full), and the log hears of each such row once.
   */
  private wellFormed(rows: unknown, what: string): EventPage {
    const bad: unknown[] = [];
    const page = eventPage(rows, bad);
    const n = this.reported.fresh(bad);
    if (n) log.info(`[chat] ${n} malformed row(s) dropped from the CLI's ${what}`);
    return page;
  }

  /** Adds context to the composer (a chip above the input, sent with the next message). */
  addContext(c: CodeContext): void {
    this.contexts.push(c);
    if (this.webviewReady) {
      this.postContexts();
      this.post({ type: 'focusInput' });
    }
  }

  async reload(): Promise<void> {
    if (!this.host) return;
    try {
      await this.loadChannels();
    } catch {
      return; // reported on the setup card already (channels, ready:false); a toast with the same sentence would be noise
    }
    if (!this.host) return;
    const id = this.current?.id ?? this.ext.globalState.get<string>(LAST_CHANNEL);
    await this.select(id ?? this.channels[0]?.id, true);
  }

  /** The UI language changed: resend strings and everything rendered on this side. */
  languageChanged(): void {
    this.renderer.clear();
    if (!this.webviewReady) return;
    this.postI18n();
    this.postContexts();
    if (this.current) {
      this.postChannels();
      this.postThreads();
      if (this.openThread) this.postThread();
      this.postAgentsOffline(true); // the bar's sentence is in the new language
    }
  }

  // ------------------------------------------------------------------ webview -> extension

  private async onMessage(m: FromWebview): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          this.webviewReady = true;
          this.postI18n();
          this.post({ type: 'host', kind: this.host?.kind ?? 'view' });
          this.post({ type: 'live', state: this.live.state.state, detail: this.live.state.detail, reason: this.live.state.reason });
          this.postContexts();
          // before the first thread opens, so its composer shows what was typed there
          this.post({ type: 'drafts', items: cleanDrafts(this.ext.workspaceState.get(DRAFTS)) });
          await this.reload();
          break;
        case 'drafts':
          await this.ext.workspaceState.update(DRAFTS, cleanDrafts(m.items));
          break;
        case 'select':
          await this.openChannel(m.id);
          break;
        case 'openThread':
          await this.showThread(m.id);
          break;
        case 'newThread':
          this.newThread();
          break;
        case 'send':
          // the thread the composer showed travels with the message (null: a new thread)
          await this.send(m.text, m.mentions ?? [], m.replyTo || undefined, threadFromView(m.thread), m.channel);
          break;
        case 'typing':
          this.sendTyping();
          break;
        case 'openDesktop':
          await this.openDesktop();
          break;
        case 'channelMenu':
          await vscode.commands.executeCommand('buzz.channelMenu');
          break;
        case 'attachSelection': {
          const c = contextFromEditor(vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0]);
          if (c) this.addContext(c);
          else this.post({ type: 'toast', message: t('chat.selectCodeFirst') });
          break;
        }
        case 'removeContext':
          this.contexts.splice(m.index, 1);
          this.postContexts();
          break;
        case 'older':
          await this.loadOlder();
          void this.fillRoots(this.selectSeq);
          break;
        case 'search':
          await this.search(m.query, m.scope);
          break;
        case 'openResult':
          await this.openChannel(m.channel, m.id);
          break;
        case 'refresh':
          await this.reload();
          void this.refreshPresence();
          break;
        case 'setup':
          await vscode.commands.executeCommand('buzz.setup');
          break;
        case 'setLanguage':
          if (m.lang === 'en' || m.lang === 'tr') await cfg.setUiLanguage(m.lang);
          break;
        case 'openRef': {
          const err = await openFileRef(m.path, m.line || undefined, m.end || undefined, this.host?.kind === 'panel', this.repos);
          if (err) this.post({ type: 'toast', message: err });
          break;
        }
        case 'gitDiff':
          await this.gitDiff(m.id);
          break;
        case 'patchDiff':
        case 'patchApply': {
          const e = this.byId.get(m.id);
          const plan = this.renderer.plan(e, m.block);
          if (!plan) {
            this.post({ type: 'toast', message: t('patch.noFile') });
            break;
          }
          if (m.type === 'patchApply' && !cfg.applyLocally()) break; // only offered in the opt-in local mode
          const key = `${m.id}:${m.block}`;
          const err =
            m.type === 'patchDiff'
              ? await showProposalDiff(this.docs, plan, key, this.repos)
              : await applyProposal(plan, this.docs, key, { createdAt: e?.created_at });
          if (err) this.post({ type: 'toast', message: err });
          break;
        }
        case 'jiraInfo': {
          const key = m.key;
          if (!JIRA_ISSUE_KEY.test(key)) break;
          try {
            const v = await this.jira.issue(key);
            this.post({
              type: 'jiraInfo',
              key,
              data: { ...v, estimateText: v.estimate ? formatHours(v.estimate) : undefined, spentText: formatHours(v.spent ?? 0) },
            });
          } catch (e) {
            this.post({ type: 'jiraInfo', key, error: (e as Error).message, needsToken: !!(e as JiraError).needsToken });
          }
          break;
        }
        case 'setJiraToken':
          await vscode.commands.executeCommand('buzz.setJiraToken');
          break;
        case 'wide':
          // the tab's button brings the chat back to the side bar; the side bar's opens the tab
          await vscode.commands.executeCommand(this.host?.kind === 'panel' ? 'buzz.backToSideBar' : 'buzz.openChatInEditor');
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          this.post({ type: 'toast', message: t('chat.copied'), ok: true });
          break;
        case 'open':
          if (/^https?:\/\//i.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
          break;
        default:
          log.info(`[chat] unknown webview message: ${(m as { type: string }).type}`);
      }
    } catch (e) {
      this.post({ type: 'error', message: friendlyError(e) });
    }
  }

  // ------------------------------------------------------------------ channels and threads

  private async loadChannels(): Promise<void> {
    try {
      if (!this.client.myPubkey) await this.client.me();
      this.channels = await this.client.allChannels();
      const merged = this.channels.filter((c) => (c.ids?.length ?? 1) > 1);
      if (merged.length)
        log.info(
          `[channels] ${merged.length} DM note(s) stand for several conversations with the same people: ${merged.map((c) => `${c.name} ×${c.ids!.length}`).join(', ')}`,
        );
      this.postChannels();
      await vscode.commands.executeCommand('setContext', 'buzz.ready', true);
    } catch (e) {
      this.channels = [];
      this.post({
        type: 'channels',
        ready: false,
        error: friendlyError(e),
        setup: e instanceof SetupError || (e instanceof BuzzError && e.code === CliExit.Auth),
      });
      throw e;
    }
  }

  private postChannels(): void {
    this.post({
      type: 'channels',
      ready: true,
      items: this.channels.map((c) => ({
        id: c.id,
        name: c.name || c.id.slice(0, 8),
        isDm: c.isDm,
        color: chipColor(c.id),
        peer: c.isDm && c.peers?.length === 1 ? c.peers[0] : undefined,
      })),
    });
  }

  private async select(id: string | undefined, keepThread = false): Promise<void> {
    const ch = this.findChannel(id) ?? this.channels[0];
    if (!ch) return;
    const seq = ++this.selectSeq;
    const changed = this.current?.id !== ch.id;
    this.current = ch;
    await this.ext.globalState.update(LAST_CHANNEL, ch.id);
    if (seq !== this.selectSeq) return;
    if (changed) {
      this.liveQueue = []; // live messages of the previous channel still waiting
      this.expectUntil = 0; // an answer awaited there is not awaited here (no fast polling of this channel for it)
    }
    if (changed || !keepThread) {
      // a message typed a moment ago in the channel being left can still arrive (sendElsewhere): where its threads live
      // added to, never replaced: a second switch while this channel loads must not forget the first channel's threads
      for (const [root, convo] of this.threadHomes()) this.leftThreads.set(root, convo);
      while (this.leftThreads.size > LEFT_THREADS_MAX) this.leftThreads.delete(this.leftThreads.keys().next().value!);
      this.byId.clear();
      this.lastTs = 0;
      this.lastReconcile = 0; // not reconciled yet: if the first read fails, the next poll is a full one (cursors, fill)
      this.oldest.clear();
      this.exhausted.clear();
      this.noOlder = false;
      this.rootsTried.clear();
      this.rootsRetryAt = 0;
      this.partialThreads.clear();
      this.members = [];
      this.membersOf = undefined;
      this.renderer.clear();
      this.tracker.clear();
      this.deleted.clear();
      this.pageSeen.clear();
      this.openThread = undefined;
      this.shown.clear();
      this.awaitingRoot = 0;
      this.lastOffline = undefined;
    }
    this.post({ type: 'channel', id: ch.id, name: ch.name || ch.id.slice(0, 8), isDm: ch.isDm, color: chipColor(ch.id) });
    // live subscriptions first, so they follow this channel even if the read below fails: every message
    // arrives instantly; typing signals too (ephemeral, not stored)
    const nowSec = Math.floor(Date.now() / 1000);
    this.live.subscribe(this.subId, [{ kinds: CHANNEL_MESSAGE_KINDS, '#h': this.ids(ch), since: Math.max(0, (this.lastTs || nowSec) - 5) }]);
    this.live.subscribe(this.typingSub, [{ kinds: [TYPING_KIND], '#h': this.ids(ch) }]);
    // no kinds on purpose: the relay accepts a channel-scoped filter without them (seen in production), and it is what
    // brings deletions, member changes and channel edits at once; a kinds list would have to know them all
    this.live.subscribe(this.otherSub, [{ '#h': this.ids(ch), since: nowSec - 5 }]);
    // while the channel loads nothing half-filled reaches the list (a live message or a poll landing meanwhile)
    this.selecting = true;
    let notice: string | undefined;
    try {
      let pages: { id: string; page: NostrEvent[] }[] = [];
      try {
        pages = await this.readPages(ch);
      } catch (e) {
        // the list still shows up (empty, the error in the status line) and the regular poll retries
        if (seq === this.selectSeq) this.post({ type: 'status', text: friendlyError(e) });
      }
      if (seq !== this.selectSeq) return; // another channel was picked meanwhile, or the view closed
      // on refresh the same channel keeps its messages: drop what was deleted meanwhile, update edits
      this.reconcilePages(pages);
      const evs = pages.flatMap((p) => p.page);
      for (const e of evs) if (this.visible(e)) this.byId.set(e.id, e);
      this.lastTs = evs.reduce((a, e) => Math.max(a, e.created_at), this.lastTs);
      this.noteCursors(pages);
      // a message to open (notification, Buzz Lens): its thread is loaded first, so the list shows up once
      // with that thread selected instead of opening the first thread and then jumping
      if (this.pendingEvent) {
        const ev = this.pendingEvent;
        this.pendingEvent = undefined;
        const got = await this.loadThreadOf(ev.id, ev.channel);
        if (seq !== this.selectSeq) {
          this.pendingEvent ??= ev; // a newer select of the same channel takes the message over
          return;
        }
        if (got === 'missing') notice = t('chat.threadUnavailable');
      }
    } finally {
      if (seq === this.selectSeq) this.selecting = false;
    }
    // the thread before the list: the list arrives with the open thread already marked
    if (notice) this.newThread(notice);
    else if (this.openThread) this.postThread([], true);
    this.postThreads(true);
    void this.fillList(seq);
    this.client
      .members(ch.id)
      .then((ms) => {
        if (seq !== this.selectSeq) return; // an answer for a channel that is no longer on screen
        this.members = ms;
        this.membersOf = ch.id;
        this.post({ type: 'members', items: ms.map((x) => ({ pubkey: x.pubkey, name: x.name, isAgent: x.isAgent })) });
        this.postAgentsOffline();
        void this.refreshPresence();
      })
      .catch(() => undefined);
    this.schedule();
  }

  /**
   * One page rarely fills the list: busy threads take most of it. More pages are read until the list shows enough
   * threads, then the first messages the pages did not include are fetched, so no thread shows "older…".
   */
  private async fillList(seq: number): Promise<void> {
    for (let i = 0; i < FILL_PAGES && seq === this.selectSeq && !this.noOlder; i++) {
      if (groupThreads([...this.byId.values()]).length >= MIN_THREADS) break;
      try {
        await this.loadOlder();
      } catch {
        break; // Buzz could not be reached: the regular poll retries, not four identical reads in a row
      }
    }
    await this.fillRoots(seq);
  }

  /**
   * First messages of threads whose replies are loaded but whose root is older than the pages: one read over the
   * live connection (by id), or the CLI a few threads at a time when there is no live connection.
   */
  private async fillRoots(seq: number): Promise<void> {
    const ch = this.current;
    if (!ch || seq !== this.selectSeq || this.selecting || Date.now() < this.rootsRetryAt) return;
    const missing = groupThreads([...this.byId.values()])
      .filter((g) => !g.root && !this.deleted.has(g.id) && !this.rootsTried.has(g.id))
      .slice(0, ROOTS_PER_FETCH)
      .map((g) => g.id);
    if (!missing.length) return;
    missing.forEach((id) => this.rootsTried.add(id));
    // one read over the live connection; the CLI reads what that did not settle (no connection, refused, cut short)
    const live = await this.live.fetch([{ kinds: CHANNEL_MESSAGE_KINDS, ids: missing }]);
    const found: NostrEvent[] = live?.events.slice() ?? [];
    const have = () => new Set(found.map((e) => e.id));
    const rest = live?.complete ? [] : missing.filter((id) => !have().has(id));
    for (let i = 0; i < rest.length && seq === this.selectSeq; i += ROOTS_CLI_BATCH) {
      const part = await Promise.all(rest.slice(i, i + ROOTS_CLI_BATCH).map((id) => this.client.thread(this.conversationOf(id), id).catch(() => undefined)));
      found.push(
        ...this.wellFormed(
          part.flatMap((p) => p ?? []),
          'thread',
        ),
      );
    }
    if (seq !== this.selectSeq || this.current?.id !== ch.id) return;
    // a root nobody could confirm (unreachable, or really gone) is looked for again later, not on every message
    const unconfirmed = live?.complete ? [] : missing.filter((id) => !have().has(id));
    if (unconfirmed.length) {
      unconfirmed.forEach((id) => this.rootsTried.delete(id));
      this.rootsRetryAt = Date.now() + ROOTS_RETRY_MS;
    }
    const fresh = found.filter((e) => this.isOurs(e) && !this.byId.has(e.id) && this.visible(e));
    if (!fresh.length) return;
    await this.client.ensureProfiles(fresh.map((e) => e.pubkey)).catch(() => undefined);
    if (seq !== this.selectSeq) return;
    for (const e of fresh) this.byId.set(e.id, e);
    this.postThreads();
    if (this.openThread && fresh.some((e) => e.id === this.openThread || replyRootOf(e) === this.openThread)) this.postThread();
  }

  /**
   * The whole thread of a message: the CLI's read (at most THREAD_PAGE messages, the newest), and when that is full,
   * the older messages over the live connection, page by page (`#e` = the root, `until` = the oldest known). What a
   * cut-short page did bring is kept; a thread whose oldest part could not be read is marked partial.
   */
  private async readThread(convo: string, eventId: string): Promise<NostrEvent[]> {
    const evs = this.wellFormed(await this.client.thread(convo, eventId), `thread ${eventId.slice(0, 8)}`);
    const root = evs.find((e) => !replyRootOf(e))?.id ?? (evs[0] ? replyRootOf(evs[0]) : undefined) ?? eventId;
    if (rowsSent(evs) < THREAD_PAGE) {
      this.partialThreads.delete(root);
      return evs;
    }
    const seen = new Set(evs.map((e) => e.id));
    const all = evs.slice();
    let until = Math.min(...evs.filter((e) => e.id !== root).map((e) => e.created_at));
    let partial = true; // until a short, complete page says the beginning was reached
    for (let page = 0; page < THREAD_PAGES_MAX; page++) {
      const res = await this.live.fetch([{ kinds: CHANNEL_MESSAGE_KINDS, '#e': [root], '#h': [convo], until, limit: THREAD_PAGE }], 8_000);
      const fresh = (res?.events ?? []).filter((e) => !seen.has(e.id));
      for (const e of fresh) {
        seen.add(e.id);
        all.push(e);
      }
      if (!res?.complete) break; // no live connection, or a read cut short: what arrived is kept, the rest is missing
      if (!fresh.length || res.events.length < THREAD_PAGE) {
        partial = false;
        break;
      }
      until = Math.min(...fresh.map((e) => e.created_at));
    }
    if (partial) this.partialThreads.add(root);
    else this.partialThreads.delete(root);
    return all;
  }

  /**
   * Full-text search through Buzz's own search (the whole history you can read): over the live connection, else the
   * CLI. Matches are grouped by thread, newest first; the row shows the newest matching message. Every search is
   * answered, also when it fails, so the list is never left waiting.
   */
  private async search(query: string, scope: SearchScope): Promise<void> {
    const q = query.trim();
    const ch = this.current;
    if (!q) return;
    const seq = ++this.searchSeq;
    if (!ch) {
      this.post({ type: 'searchResults', query: q, scope, items: [], capped: false, cap: SEARCH_LIMIT, error: t('chat.pickChannelFirst') });
      return;
    }
    const ids = this.ids(ch);
    let msgs: LensMessage[] | undefined;
    let capped = false;
    try {
      const filter = { kinds: CHANNEL_MESSAGE_KINDS, search: q, limit: SEARCH_LIMIT, ...(scope === 'channel' ? { '#h': ids } : {}) };
      const res = await this.live.fetch([filter], 8_000);
      if (res?.complete) {
        msgs = parseSearch(res.events);
        capped = res.events.length >= SEARCH_LIMIT;
      }
    } catch {
      /* the CLI below */
    }
    if (!msgs) {
      try {
        msgs = parseSearch(await this.client.search(q, SEARCH_LIMIT));
        capped = msgs.length >= SEARCH_LIMIT;
      } catch (e) {
        if (seq === this.searchSeq) this.post({ type: 'searchResults', query: q, scope, items: [], capped: false, cap: SEARCH_LIMIT, error: friendlyError(e) });
        return;
      }
    }
    if (seq !== this.searchSeq) return;
    const hits = msgs.filter((m) => !this.deleted.has(m.id) && (scope === 'all' || ids.includes(m.channel)));
    const byThread = new Map<string, { best: LensMessage; n: number }>();
    for (const m of hits) {
      const g = byThread.get(`${m.channel}:${m.root}`);
      if (!g) byThread.set(`${m.channel}:${m.root}`, { best: m, n: 1 });
      else {
        g.n++;
        if (m.created_at > g.best.created_at) g.best = m;
      }
    }
    const groups = [...byThread.values()].sort((a, b) => b.best.created_at - a.best.created_at);
    await this.client.ensureProfiles(groups.map((g) => g.best.pubkey)).catch(() => undefined);
    if (seq !== this.searchSeq) return;
    const items: SearchRow[] = groups.map(({ best, n }) => {
      const author = this.client.nameOf(best.pubkey);
      const c = this.findChannel(best.channel);
      return {
        id: best.root,
        channelId: best.channel,
        channelName: c ? (c.isDm ? c.name : `#${c.name}`) : best.channel.slice(0, 8),
        matchId: best.id,
        matches: n,
        pubkey: best.pubkey,
        author,
        initials: initials(author),
        isAgent: this.client.isAgent(best.pubkey),
        isMe: best.pubkey === this.client.myPubkey,
        snippet: plainSnippet(best.content, 160),
        time: shortTime(best.created_at),
        ts: best.created_at,
      };
    });
    this.post({ type: 'searchResults', query: q, scope, items, capped, cap: SEARCH_LIMIT });
  }

  /** Loads the whole thread a message belongs to and makes it the open thread (nothing is posted yet). */
  private async loadThreadOf(eventId: string, convo?: string): Promise<'ok' | 'missing' | 'stale'> {
    const ch = this.current;
    if (!ch) return 'stale';
    const seq = this.selectSeq; // a load for an earlier selection of the same channel must not write into this one
    // a notification names the conversation the message is in; otherwise the one its thread lives in
    const where = convo && this.ids(ch).includes(convo) ? convo : undefined;
    const fetch = (id: string) =>
      this.readThread(where ?? this.conversationOf(id), id)
        .then((evs) => evs.filter((e) => this.visible(e)))
        .catch(() => [] as NostrEvent[]);
    let evs = await fetch(eventId);
    const known = evs.find((e) => e.id === eventId) ?? this.byId.get(eventId);
    const root = evs.find((e) => !replyRootOf(e))?.id ?? (known ? (replyRootOf(known) ?? known.id) : eventId);
    // the message was a reply: read the thread from its root too, so the whole conversation is there
    if (root !== eventId && !evs.some((e) => e.id === root)) evs = [...evs, ...(await fetch(root))]; // the first read often has the root already
    if (seq !== this.selectSeq || this.current?.id !== ch.id) return 'stale';
    for (const e of evs) this.byId.set(e.id, e);
    // deleted, or Buzz could not be reached: nothing to show
    if (!evs.length && !this.byId.has(root)) return 'missing';
    this.openThread = root;
    this.awaitingRoot = 0;
    return 'ok';
  }

  /** Opens the thread of a message (notification, Buzz Lens) in the channel on screen: selected in place. */
  private async focusEvent(eventId: string, convo?: string): Promise<void> {
    const got = await this.loadThreadOf(eventId, convo);
    if (got === 'stale') return;
    if (got === 'missing') {
      this.newThread(t('chat.threadUnavailable'));
      return;
    }
    // the thread before the list: the list is redrawn with that thread already marked
    this.postThread([], true);
    this.postThreads();
  }

  private async showThread(id: string): Promise<void> {
    if (!this.current) return;
    this.openThread = id;
    this.awaitingRoot = 0;
    this.postThread();
    // the full thread (the root may be older) comes from the CLI
    const ch = this.current;
    const wasPartial = this.partialThreads.has(id);
    const evs = await this.readThread(this.conversationOf(id), id).catch(() => [] as NostrEvent[]);
    if (this.current?.id !== ch.id || this.openThread !== id) return;
    const fresh = evs.filter((e) => !this.byId.has(e.id) && this.visible(e));
    for (const e of fresh) this.byId.set(e.id, e);
    if (fresh.length) this.postThreads();
    // posted again also when only the partial mark changed: the notice that the oldest part is missing has to show
    if (fresh.length || wasPartial !== this.partialThreads.has(id)) this.postThread();
  }

  private newThread(notice?: string): void {
    this.openThread = undefined;
    this.shown.clear();
    this.post({ type: 'thread', id: null, title: t('chat.newThread'), items: [], notice });
    this.postWorking();
  }

  /** A message we can show: not deleted, and not itself a deletion event. */
  private visible(e: NostrEvent): boolean {
    return !this.deleted.has(e.id) && !deletedIdsOf(e);
  }

  /** Removes messages deleted in Buzz and refreshes what is on screen. */
  private removeMessages(ids: string[]): void {
    const gone = ids.filter((id) => this.byId.has(id));
    for (const id of ids) {
      this.deleted.add(id);
      this.byId.delete(id);
    }
    if (!gone.length) return;
    this.postThreads();
    if (!this.openThread) return;
    const g = this.group(this.openThread);
    if (!g || (!g.root && !g.replies.length)) this.newThread(t('chat.threadDeleted'));
    else if (gone.some((id) => this.shown.has(id))) this.postThread();
  }

  /** Applies a fresh page of the latest messages: deletions and edits made elsewhere (Buzz Desktop, CLI). */
  private reconcilePages(pages: { id: string; page: NostrEvent[] }[]): void {
    for (const p of pages) this.reconcile(p.page, p.id);
  }

  /** `convo`: the page is one conversation's; only what is known of that conversation can go missing from it. */
  private reconcile(page: NostrEvent[], convo?: string): void {
    this.lastReconcile = Date.now();
    for (const e of page) {
      const ids = this.deletable(e);
      if (ids) this.removeMessages(ids);
    }
    const msgs = page.filter((e) => this.visible(e));
    const known = convo && this.current?.ids ? new Map([...this.byId].filter(([, e]) => channelOf(e) === convo)) : this.byId;
    const { removed, edited } = reconcilePage(known, msgs, this.pageSeen);
    for (const e of msgs) this.pageSeen.add(e.id);
    if (removed.length) this.removeMessages(removed);
    if (edited.length) {
      for (const e of edited) this.byId.set(e.id, e);
      this.postThreads();
      if (edited.some((e) => this.shown.has(e.id))) this.postThread();
    }
  }

  /** Re-read the latest page soon (something changed in the channel that isn't a new message). */
  private scheduleReconcile(): void {
    if (this.reconcileTimer) return;
    const wait = Math.max(RECONCILE_MIN_WAIT, RECONCILE_MIN_GAP - (Date.now() - this.lastReconcile));
    this.reconcileTimer = setTimeout(async () => {
      this.reconcileTimer = undefined;
      const ch = this.current;
      if (!ch || this.selecting) return; // the channel load reconciles anyway
      const seq = this.selectSeq;
      try {
        const pages = await this.readPages(ch);
        if (this.current?.id !== ch.id || seq !== this.selectSeq) return;
        this.reconcilePages(pages);
        // as the poll's full read: if the first read of the channel had failed, this one brings the cursors
        const had = this.oldest.size > 0;
        this.noteCursors(pages);
        await this.ingest(pages.flatMap((p) => p.page));
        if (!had && this.oldest.size > 0 && seq === this.selectSeq) void this.fillList(seq);
      } catch {
        /* the regular poll retries */
      }
    }, wait);
  }

  /** Channel events that are neither messages nor typing: deletions act at once, anything else triggers a re-read. */
  private onOtherEvent(ev: NostrEvent): void {
    if (CHANNEL_MESSAGE_KINDS.includes(ev.kind) || ev.kind === TYPING_KIND) return;
    const ids = this.deletable(ev);
    if (ids) {
      this.removeMessages(ids);
      return;
    }
    if (!this.loggedKinds.has(ev.kind)) {
      this.loggedKinds.add(ev.kind);
      log.info(`[live] channel event kind ${ev.kind} (tags: ${ev.tags.map((x) => x[0]).join(',')}); re-reading the channel`);
    }
    this.scheduleReconcile();
  }

  /**
   * Messages a deletion event may remove. A plain deletion (kind 5) counts only for its author's own messages,
   * as Nostr requires; a moderation deletion (9005) is checked by the relay. Undefined: not a deletion.
   */
  private deletable(ev: NostrEvent): string[] | undefined {
    const ids = deletedIdsOf(ev);
    if (!ids || ev.kind !== 5) return ids;
    return ids.filter((id) => this.byId.get(id)?.pubkey === ev.pubkey);
  }

  private group(id: string): ThreadGroup | undefined {
    return groupThreads([...this.byId.values()]).find((g) => g.id === id);
  }

  private postThreads(initial = false): void {
    if (!this.current || this.selecting) return;
    const items = groupThreads([...this.byId.values()]).map((g) => this.summary(g));
    this.post({ type: 'threads', channelId: this.current.id, items, initial, more: this.oldest.size > 0 && !this.noOlder });
  }

  private summary(g: ThreadGroup): ThreadRow {
    const r = g.root;
    const lastReply = g.replies[g.replies.length - 1];
    const people = [...new Set([r?.pubkey, ...g.replies.map((x) => x.pubkey)].filter((x): x is string => !!x))];
    const authorKey = r?.pubkey ?? people[0];
    const author = authorKey ? this.client.nameOf(authorKey) : '…';
    return {
      id: g.id,
      pubkey: authorKey,
      author,
      initials: initials(author),
      isAgent: r ? this.client.isAgent(r.pubkey) : false,
      isMe: !!r && r.pubkey === this.client.myPubkey,
      snippet: r ? this.renderer.snippet(r, 160) || t('chat.emptyMessage') : this.deleted.has(g.id) ? t('chat.rootDeleted') : t('chat.oldRoot'),
      replies: g.replies.length,
      lastAuthor: lastReply ? this.client.nameOf(lastReply.pubkey) : undefined,
      lastIsMe: (lastReply ?? r)?.pubkey === this.client.myPubkey,
      people: people
        .slice(0, 5)
        .map((p) => ({ pubkey: p, initials: initials(this.client.nameOf(p)), isAgent: this.client.isAgent(p), name: this.client.nameOf(p) })),
      time: shortTime(g.last),
      ts: g.last,
    };
  }

  /** The open thread in conversation order (replies under the message they answer). */
  private threadEntries(): ThreadEntry[] {
    const g = this.openThread ? this.group(this.openThread) : undefined;
    return g ? threadOrder(g.root, g.replies) : [];
  }

  /** `reveal`: the thread was opened from outside (notification, Lens), so the narrow layout switches to it. */
  private postThread(flash: string[] = [], reveal = false): void {
    if (!this.openThread) return;
    const g = this.group(this.openThread);
    const entries = this.threadEntries();
    this.shown = new Set(entries.map((x) => x.ev.id));
    this.post({
      type: 'thread',
      id: this.openThread,
      title: g?.root ? this.renderer.snippet(g.root, 90) : this.deleted.has(this.openThread) ? t('chat.rootDeleted') : t('chat.thread'),
      items: entries.map((x) => this.item(x.ev, x)),
      flash,
      reveal,
      partial: this.partialThreads.has(this.openThread) || undefined,
    });
    this.postWorking();
  }

  /**
   * Cursors for "Load older": the oldest message of each conversation's first page. A conversation whose page came
   * back empty has nothing older. Later full reads only add cursors that are missing (after a failed first read).
   */
  private noteCursors(pages: { id: string; page: NostrEvent[] }[]): void {
    for (const { id, page } of pages) {
      if (this.oldest.has(id)) continue;
      if (!page.length) {
        this.exhausted.add(id);
        continue;
      }
      this.oldest.set(id, Math.min(...page.map((e) => e.created_at)));
      this.exhausted.delete(id);
      this.noOlder = false;
    }
  }

  /** The page before `before` of one conversation: over the live connection (bigger pages, no process), else the CLI. */
  private async olderPage(id: string, before: number): Promise<{ page: EventPage; limit: number }> {
    const res = await this.live.fetch([{ kinds: CHANNEL_MESSAGE_KINDS, '#h': [id], until: before, limit: LIVE_PAGE }], 8_000).catch(() => undefined);
    if (res?.complete) return { page: res.events, limit: LIVE_PAGE };
    return { page: this.wellFormed(await this.client.messages(id, { limit: PAGE, before }), `older messages of ${id.slice(0, 8)}`), limit: PAGE };
  }

  /** One "Older threads" read at a time: the fill loop and the button share it (a second read of the same page would look like the end). */
  private loadOlder(): Promise<void> {
    // a read started for another selection of the channel list is not this one's: it ends on its own (seq check)
    if (!this.olderInFlight || this.olderSeq !== this.selectSeq) {
      this.olderSeq = this.selectSeq;
      const p = this.loadOlderNow().finally(() => {
        if (this.olderInFlight === p) this.olderInFlight = undefined;
      });
      this.olderInFlight = p;
    }
    return this.olderInFlight;
  }

  private async loadOlderNow(): Promise<void> {
    const ch = this.current;
    if (!ch || this.selecting) return;
    if (!this.oldest.size) return; // nothing read yet (the first read failed): nothing to page from, and not the end either
    const ids = this.ids(ch)
      .slice(0, MAX_CONVERSATIONS)
      .filter((id) => this.oldest.has(id) && !this.exhausted.has(id));
    if (!ids.length) {
      this.noOlder = true;
      this.postThreads(); // a click always answers with the list as it is (the fill loop may have read the rest meanwhile)
      this.post({ type: 'olderDone' });
      return;
    }
    const seq = this.selectSeq;
    try {
      await Promise.all(
        ids.map(async (id) => {
          // a page holding only messages already shown (a long thread was opened) is not the end: move the cursor on
          for (let pass = 0; pass < OLDER_PASSES; pass++) {
            const before = this.oldest.get(id)!;
            const { page, limit } = await this.olderPage(id, before);
            if (seq !== this.selectSeq || this.current?.id !== ch.id) return;
            const fresh = page.filter((e) => !this.byId.has(e.id));
            const min = page.length ? Math.min(...page.map((e) => e.created_at)) : before;
            if (min < before) this.oldest.set(id, min);
            for (const e of fresh) if (this.visible(e)) this.byId.set(e.id, e);
            if (rowsSent(page) < limit) {
              this.exhausted.add(id); // a short page: the beginning of the conversation
              return;
            }
            if (fresh.length) return;
            if (min >= before) {
              this.exhausted.add(id); // the cursor cannot move: nothing older
              return;
            }
          }
        }),
      );
    } catch (e) {
      if (seq === this.selectSeq) this.postThreads(); // puts the "Older threads" button back
      throw e;
    }
    if (seq !== this.selectSeq || this.current?.id !== ch.id) return;
    this.postThreads();
    if (ids.every((id) => this.exhausted.has(id))) {
      this.noOlder = true;
      this.post({ type: 'olderDone' });
    }
  }

  /** Live events: messages are batched briefly and handled together; typing signals update the indicator. */
  private onLiveEvent(subId: string, ev: NostrEvent): void {
    if (!this.isOurs(ev)) return;
    if (subId === this.typingSub) return this.onTyping(ev);
    if (subId === this.otherSub) return this.onOtherEvent(ev);
    if (subId !== this.subId || this.byId.has(ev.id) || !this.visible(ev)) return;
    this.liveQueue.push(ev);
    clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(async () => {
      const batch = this.liveQueue.splice(0);
      if (!batch.length) return;
      await this.client.ensureProfiles(batch.map((e) => e.pubkey)).catch(() => undefined);
      // the channel may have changed while the batch waited
      const mine = batch.filter((e) => this.isOurs(e));
      if (mine.length) await this.ingest(mine).catch((e) => this.post({ type: 'status', text: friendlyError(e) }));
    }, LIVE_BATCH_MS);
  }

  private onTyping(ev: NostrEvent): void {
    const s = parseTyping(ev);
    if (!s || !this.tracker.typingSignal(s)) return;
    void this.client
      .ensureProfiles([s.pubkey])
      .catch(() => undefined)
      .then(() => {
        this.postWorking();
        this.postPresence();
      });
  }

  /** Our own typing signal (only over the live connection, at most every few seconds). */
  private sendTyping(): void {
    if (!this.current || !this.live.isLive) return;
    const now = Date.now();
    if (now - this.lastTypingSent < TYPING_SEND_EVERY) return;
    this.lastTypingSent = now;
    const tags = [['h', this.conversationOf(this.openThread)]];
    if (this.openThread) tags.push(['e', this.openThread, '', 'root']);
    this.live.publish({ kind: TYPING_KIND, tags, content: '' });
  }

  /** Polling (fallback): rare while live, frequent otherwise. */
  private async poll(): Promise<void> {
    if (!this.current || this.polling || this.selecting) return;
    this.polling = true;
    try {
      const ch = this.current;
      const seq = this.selectSeq;
      // every minute (and when the view comes back) the latest page is re-read to catch deletions and edits
      const full = Date.now() - this.lastReconcile >= RECONCILE_EVERY;
      const pages = full ? await this.readPages(ch) : await this.readPages(ch, { limit: INCREMENTAL_LIMIT, since: Math.max(0, this.lastTs - 1) });
      if (this.current?.id !== ch.id || seq !== this.selectSeq) return;
      let fillNow = false;
      if (full) {
        this.reconcilePages(pages);
        const had = this.oldest.size > 0;
        this.noteCursors(pages);
        fillNow = !had && this.oldest.size > 0; // the first read had failed: fill the list, once this page is in
      }
      await this.ingest(pages.flatMap((p) => p.page));
      if (fillNow && seq === this.selectSeq) void this.fillList(seq);
      this.post({ type: 'status', text: '' });
    } catch (e) {
      this.post({ type: 'status', text: friendlyError(e) });
    } finally {
      this.polling = false;
    }
  }

  /** Handles new messages (shared by live and polling; a message is never handled twice). */
  private async ingest(evs: NostrEvent[]): Promise<void> {
    const fresh = evs.filter((e) => !this.byId.has(e.id) && this.visible(e)).sort((a, b) => a.created_at - b.created_at);
    if (!fresh.length) {
      this.postWorking();
      return;
    }
    for (const e of fresh) {
      this.byId.set(e.id, e);
      this.lastTs = Math.max(this.lastTs, e.created_at);
      this.tracker.saw(e);
    }
    const mine = this.awaitingRoot
      ? fresh.find((e) => e.pubkey === this.client.myPubkey && !replyRootOf(e) && e.created_at >= this.awaitingRoot - 5)
      : undefined;
    if (mine) {
      this.tracker.retarget(mine.id);
      this.postThreads();
      await this.showThread(mine.id);
    } else {
      this.postThreads();
      if (this.openThread) {
        const entries = this.threadEntries();
        const add = entries.filter((x) => !this.shown.has(x.ev.id));
        if (add.length) {
          // new messages at the end of the conversation are appended; a reply that belongs under an
          // earlier message re-renders the thread so it lands in its place (scroll position is kept)
          const atEnd = entries.slice(entries.length - add.length).every((x) => !this.shown.has(x.ev.id));
          if (atEnd) {
            add.forEach((x) => this.shown.add(x.ev.id));
            this.post({ type: 'threadAppend', id: this.openThread, items: add.map((x) => this.item(x.ev, x)) });
          } else {
            this.postThread(add.map((x) => x.ev.id));
          }
        }
      }
    }
    // new messages outside the open thread (e.g. an agent answered by starting a new thread)
    const groups = groupThreads([...this.byId.values()]);
    const threadOf = (id: string) => groups.find((g) => g.id === id || g.replies.some((x) => x.id === id))?.id ?? id;
    const elsewhere = fresh
      .filter((e) => e.pubkey !== this.client.myPubkey)
      .map((e) => ({ thread: threadOf(e.id), e }))
      .filter((x) => x.thread !== this.openThread);
    if (elsewhere.length && !this.selecting) {
      const last = elsewhere[elsewhere.length - 1];
      this.post({
        type: 'elsewhere',
        count: elsewhere.length,
        thread: last.thread,
        author: this.client.nameOf(last.e.pubkey),
        snippet: plainSnippet(last.e.content, 90),
      });
    }
    this.postWorking();
    this.postPresence();
    void this.fillRoots(this.selectSeq);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.host || !this.host.isVisible() || !this.current) return;
    const expecting = this.tracker.expecting || Date.now() / 1000 < this.expectUntil;
    // while live, polling is only a safety net (30 s)
    const ms = this.live.isLive ? POLL_LIVE_MS : expecting ? POLL_EXPECTING_MS : cfg.refreshSeconds() * 1000;
    this.timer = setTimeout(async () => {
      await this.poll();
      this.schedule();
    }, ms);
  }

  /** replyTo: a message in the open thread to answer directly (otherwise the thread root). */
  private async send(text: string, mentions: string[], replyTo?: string, viewThread?: string | null, fromChannel?: string): Promise<void> {
    // the composer is unlocked again in every case, also when the message is refused before it leaves
    try {
      await this.sendNow(text, mentions, replyTo, viewThread, fromChannel);
    } finally {
      this.post({ type: 'sending', on: false });
    }
  }

  /**
   * `viewThread` is the thread on screen when Enter was pressed (null: a new thread) and `fromChannel` the channel:
   * they win over this side's idea of the open thread and channel, so a message always goes where the user saw it
   * going, also when Enter landed while a channel switch was under way.
   */
  private async sendNow(text: string, mentions: string[], replyTo?: string, viewThread?: string | null, fromChannel?: string): Promise<void> {
    const ch = this.current;
    if (!ch) throw new Error(t('chat.pickChannelFirst'));
    const contexts = this.contexts.slice();
    const parts = [text.trim(), ...contexts.map((c) => codeBlock(c))].filter(Boolean);
    if (!parts.length) return;
    const content = parts.join('\n\n');
    if (utf8Bytes(content) > MAX_CONTENT_BYTES) throw new Error(t('chat.tooLong'));
    this.post({ type: 'sending', on: true });
    const valid = mentions.filter((p) => isHex64(p));
    if (fromChannel && fromChannel !== ch.id) {
      await this.sendElsewhere(fromChannel, content, valid, replyTo, viewThread);
      this.contexts = this.contexts.filter((c) => !contexts.includes(c));
      this.postContexts();
      this.post({ type: 'sent', text });
      return;
    }
    const fromView = viewThread;
    if (fromView !== undefined && (fromView ?? undefined) !== this.openThread) {
      log.info(
        `[chat] the thread on screen (${fromView?.slice(0, 8) ?? 'new'}) differs from the open one (${this.openThread?.slice(0, 8) ?? 'new'}); sending to the one on screen`,
      );
      this.openThread = fromView ?? undefined;
    }
    const thread = this.openThread;
    // a reply goes under a message of this thread only
    const inThread = (id: string) => {
      const e = this.byId.get(id);
      return this.shown.has(id) || (!!e && (e.id === thread || replyRootOf(e) === thread));
    };
    const target = thread && replyTo && inThread(replyTo) ? replyTo : thread;
    // a new thread: wait for my root from now on, it can arrive over the live connection before the CLI returns
    if (!thread) this.awaitingRoot = Math.floor(Date.now() / 1000);
    let res: SendResult;
    try {
      res = await this.client.send(this.conversationOf(thread), content, { mentions: valid, replyTo: target });
      // "duplicate" means the relay already has it: sent
      if (res && res.accepted === false && !/^duplicate/i.test(res.message ?? '')) {
        throw new Error(res.message ? t('chat.notAccepted', res.message) : t('chat.notAcceptedPlain'));
      }
    } catch (e) {
      if (!thread) this.awaitingRoot = 0;
      throw e;
    }
    const now = Math.floor(Date.now() / 1000);
    // another channel may have been picked while the message was on its way: no answer is awaited there
    const here = () => this.current?.id === ch.id;
    let threadId = thread;
    if (here()) {
      this.expectUntil = now + EXPECT_ANSWER_S;
      if (!thread && res?.event_id) {
        if (this.openThread === res.event_id)
          threadId = res.event_id; // it arrived live and is open already
        else if (this.byId.has(res.event_id)) {
          threadId = res.event_id; // it arrived live before the CLI returned: open it now
          await this.showThread(res.event_id);
        }
      }
    }
    if (here()) this.tracker.expect(valid, threadId ?? 'new', now - 2);
    this.warnOffline(valid); // about the message just sent, wherever the user is by now
    // only what was sent leaves the composer: a chip added while sending stays
    this.contexts = this.contexts.filter((c) => !contexts.includes(c));
    this.postContexts();
    this.post({ type: 'sent', text });
    if (!here()) return;
    await this.poll();
    this.schedule();
  }

  /**
   * Enter was pressed while a channel switch was under way: the composer still showed the previous channel, so the
   * message goes there, where the user saw it going, not to the channel this side has moved on to. Its messages are
   * gone from this side already, so the thread and reply target the composer showed are taken as they are, and the
   * conversation of the thread (a DM note stands for several) comes from what the switch remembered (leftThreads).
   */
  private async sendElsewhere(channelId: string, content: string, mentions: string[], replyTo?: string, viewThread?: string | null): Promise<void> {
    const ch = this.findChannel(channelId);
    if (!ch) throw new Error(t('chat.channelGone'));
    const thread = viewThread ?? undefined;
    log.info(`[chat] sent to ${ch.name || channelId.slice(0, 8)}, the channel on screen when Enter was pressed, not to the one picked meanwhile`);
    const res = await this.client.send(this.conversationIn(ch, thread), content, { mentions, replyTo: thread && replyTo ? replyTo : thread });
    if (res && res.accepted === false && !/^duplicate/i.test(res.message ?? '')) {
      throw new Error(res.message ? t('chat.notAccepted', res.message) : t('chat.notAcceptedPlain'));
    }
    this.warnOffline(mentions);
  }

  /** Asked an agent Buzz reports as offline: say so right away instead of showing "working…" for nothing. */
  private warnOffline(mentions: string[]): void {
    const presence = this.tracker.effective();
    const offline = mentions.filter((p) => this.client.isAgent(p) && presence[p] === 'offline').map((p) => this.client.nameOf(p));
    if (offline.length) this.post({ type: 'toast', message: t('chat.agentOffline', offline.join(', ')) });
  }

  // ------------------------------------------------------------------ presence

  private presenceKeys(): string[] {
    const keys = new Set<string>();
    if (this.membersOf === this.current?.id) for (const m of this.members) keys.add(m.pubkey);
    for (const c of this.channels) for (const p of c.peers ?? []) keys.add(p);
    for (const e of this.byId.values()) keys.add(e.pubkey);
    if (this.client.myPubkey) keys.delete(this.client.myPubkey);
    return [...keys].slice(0, PRESENCE_MAX_KEYS);
  }

  private async refreshPresence(): Promise<void> {
    if (!this.webviewReady) return;
    if (await this.tracker.refresh(this.presenceKeys())) this.postPresence();
  }

  private postPresence(): void {
    this.post({ type: 'presence', map: this.tracker.effective() });
    this.postAgentsOffline();
  }

  /**
   * Every agent of the channel offline means Buzz Desktop is closed (they run inside it): the webview shows a bar
   * with "Open Buzz Desktop". Agents Buzz has said nothing about yet do not count as offline.
   */
  private postAgentsOffline(force = false): void {
    // members of another channel (the read for this one still running, or failed) say nothing about this one
    const agents = this.membersOf === this.current?.id ? this.members.filter((m) => m.isAgent) : [];
    const presence = this.tracker.effective();
    const known = agents.filter((a) => presence[a.pubkey] !== undefined);
    const offline = agents.length > 0 && known.length === agents.length && known.every((a) => presence[a.pubkey] === 'offline');
    if (!force && offline === this.lastOffline) return;
    this.lastOffline = offline;
    this.post({ type: 'agentsOffline', offline, names: offline ? agents.map((a) => a.name) : [] });
  }

  /** "Open Buzz Desktop" from the bar: start it, then look again for the agents while they come up. */
  private async openDesktop(): Promise<void> {
    const started = await vscode.commands.executeCommand<boolean>('buzz.openDesktop');
    this.desktopTimers.forEach(clearTimeout);
    this.desktopTimers = [];
    if (!started) {
      this.postAgentsOffline(true); // the bar goes back from "starting…" to the button
      return;
    }
    const waits = [4_000, 10_000, 20_000, 40_000];
    for (const ms of waits) {
      this.desktopTimers.push(
        setTimeout(async () => {
          await this.refreshPresence();
          if (ms === waits[waits.length - 1]) this.postAgentsOffline(true); // still offline after all that: the button again
        }, ms),
      );
    }
  }

  // ------------------------------------------------------------------ extension -> webview

  /** Show diff for reported work: the branch (since it left the agents' branch) or one commit; asks when there are several. */
  private async gitDiff(id: string): Promise<void> {
    const e = this.byId.get(id);
    const g = e && this.renderer.gitRefs(e);
    if (!g) return;
    if (!this.repos.available) {
      this.post({ type: 'toast', message: t('agent.none') });
      return;
    }
    type RefPick = vscode.QuickPickItem & { ref: string; refKind: 'branch' | 'commit' };
    const items: RefPick[] = [
      ...g.branches.map((b): RefPick => ({ label: `$(git-branch) ${b}`, description: t('git.branchItem', cfg.agentBranch()), ref: b, refKind: 'branch' })),
      ...g.commits.map((c): RefPick => ({ label: `$(git-commit) ${c.slice(0, 7)}`, description: t('git.commitItem'), ref: c, refKind: 'commit' })),
    ];
    const pick: RefPick | undefined = items.length === 1 ? items[0] : await vscode.window.showQuickPick<RefPick>(items, { title: t('git.pickTitle') });
    if (!pick) return;
    const range = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('git.reading') }, () =>
      this.repos.changeRange(pick.ref, pick.refKind),
    );
    const err = typeof range === 'string' ? range : await showChanges(range, this.docs);
    if (err) this.post({ type: 'toast', message: err });
  }

  /** Images shown inline only from the relay's own host; others become links (no tracking pixels). */
  private imageHost(): string | undefined {
    try {
      const r = cfg.relayUrl();
      return r ? new URL(r).host || undefined : undefined;
    } catch {
      return undefined;
    }
  }

  /** One message for the webview, placed in the thread (`at`) under the message it answers. */
  private item(e: NostrEvent, at?: ThreadEntry): MessageItem {
    return this.renderer.item(e, at, at?.parent ? this.byId.get(at.parent) : undefined);
  }

  /** "Typing / working" for the open thread, busy threads in the list, and channel-level typing. */
  private postWorking(): void {
    const w = this.tracker.state(this.openThread);
    this.post({ type: 'working', items: w.items, busy: w.busy, channel: w.channel });
    // expire typing indicators on time even when nothing else happens
    clearTimeout(this.typingTimer);
    if (w.nextExpiry !== undefined) this.typingTimer = setTimeout(() => this.postWorking(), Math.max(200, w.nextExpiry - Date.now() + 50));
  }

  private postContexts(): void {
    this.post({
      type: 'contexts',
      items: this.contexts.map((c) => ({
        label: contextLabel(c),
        kind: c.kind ?? 'code',
        title: c.kind === 'terminal' ? (c.message ?? '') : c.kind === 'error' ? `${c.relPath}\n${c.message ?? ''}` : c.relPath,
      })),
    });
  }

  private postI18n(): void {
    this.post({ type: 'i18n', lang: lang(), strings: webviewStrings() });
  }

  private post(msg: ToWebview): void {
    void this.host?.webview.postMessage(msg);
  }
}
