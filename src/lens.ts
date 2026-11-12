// Buzz Lens: shows which Buzz conversations are about the open file, and where in it.
// It never looks like code: a bee in the gutter marks the lines a conversation is about, hovering the
// line shows the conversation, and the status bar counts the file's conversations. Gray CodeLens lines
// above the code (GitLens style) are optional (`buzz.lens.inline`).
// Nothing is written to the repo: results come from Buzz's message search and are kept in memory for a few minutes.
import * as nodePath from 'path';
import * as vscode from 'vscode';
import { AGENT_SCHEME, AgentRepos, relPathOf } from './agentRepo';
import { BuzzClient } from './api';
import * as cfg from './config';
import { CHANNEL_MESSAGE_KINDS, friendlyError, NostrEvent } from './core';
import { t } from './i18n';
import type { LiveManager } from './live';
import { runGit } from './git';
import { log } from './log';
import {
  anchorLine,
  codeIdentifiers,
  describeShape,
  groupLens,
  hasResults,
  LensMessage,
  LensThread,
  parseSearch,
  pathWords,
  relTime,
  searchTexts,
  wordIndex,
} from './lensCore';

const TTL = 5 * 60_000;
const ERROR_TTL = 60_000;
const NAMES_TTL = 10 * 60_000;
const MAX_FILES = 100; // files whose results are kept in memory
const SEARCH_PAGE = 500; // the relay's largest search page
const SEARCH_TIMEOUT = 8_000; // ms, one search over the live connection
const DAY = 86_400;

/** What the open command needs to show and open a thread. */
export interface LensTarget {
  channel: string;
  messageId: string; // latest message in the thread that mentions the file
  title: string;
  where: string; // "#channel · lead, jira_agent · 2 days ago"
}

/** Earlier repo paths of the file (renames), via git; empty when git is not available. */
function previousPaths(fsPath: string): Promise<string[]> {
  return runGit(nodePath.dirname(fsPath), ['log', '--follow', '--name-only', '--format=', '--', `:(literal)${nodePath.basename(fsPath)}`], {
    timeoutMs: 5000,
    maxBuffer: 1024 * 1024,
  })
    .then((out) =>
      [
        ...new Set(
          out
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean),
        ),
      ].slice(0, 5),
    )
    .catch(() => []);
}

const mdEscape = (s: string) => s.replace(/[\\`*_{}[\]()#+!|<>]/g, '\\$&');
// command link arguments: encodeURIComponent leaves ( ) alone, and they would end the markdown link early
const linkArgs = (v: unknown) => encodeURIComponent(JSON.stringify(v)).replace(/\(/g, '%28').replace(/\)/g, '%29');

interface Entry {
  at: number;
  ttl: number;
  threads: LensThread[];
  paths: string[]; // the file's path and earlier names (anchors never use these words)
}

export class BuzzLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly cache = new Map<string, Entry>();
  // anchors per document version: recomputed only after the text or the results change
  private readonly anchorCache = new Map<string, { version: number; threads: LensThread[]; byLine: Map<number, LensTarget[]> }>();
  private readonly idents = new WeakMap<LensThread, string[]>();
  private gen = 0; // bumped by clear(): a search still running for the old key/relay is thrown away
  private readonly loading = new Set<string>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private channelNames = new Map<string, string>();
  private namesAt = 0;
  private lastError = '';
  private readonly gutter: vscode.TextEditorDecorationType;
  private readonly bar: vscode.StatusBarItem;
  private readonly subs: vscode.Disposable[] = [];
  private redrawTimer?: NodeJS.Timeout;
  private docTimer?: NodeJS.Timeout;

  constructor(
    private readonly client: BuzzClient,
    extensionUri: vscode.Uri,
    private readonly repos: AgentRepos,
    private readonly live: LiveManager,
  ) {
    this.gutter = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'bee-gutter.svg'),
      gutterIconSize: '80%',
      overviewRulerColor: '#d4a30099',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.bar.command = 'buzz.lens.showFile';
    this.subs.push(
      // switching tabs fires both events: one redraw
      vscode.window.onDidChangeActiveTextEditor(() => this.redrawSoon(undefined, 30)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.redrawSoon(undefined, 30)),
      // anchors follow the code as it is edited (only the edited file is redrawn)
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.cache.has(e.document.uri.toString())) this.redrawSoon(e.document, 400);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        this.cache.delete(d.uri.toString());
        this.anchorCache.delete(d.uri.toString());
      }),
    );
    this.redraw();
  }

  /** Forget everything (key change, refresh command) and redraw. */
  clear(): void {
    this.gen++;
    this.cache.clear();
    this.anchorCache.clear();
    this.loading.clear();
    this.namesAt = 0;
    this.redraw();
  }

  /** Redraw from the cache; files not read yet (or stale) are read in the background. */
  redraw(): void {
    this.changed.fire();
    for (const ed of vscode.window.visibleTextEditors) this.decorate(ed);
    this.updateBar();
  }

  /** A short delay groups bursts of events; with a document only that document's editors are redrawn. */
  private redrawSoon(doc?: vscode.TextDocument, ms = 400): void {
    if (!doc) {
      clearTimeout(this.redrawTimer);
      this.redrawTimer = setTimeout(() => this.redraw(), ms);
      return;
    }
    clearTimeout(this.docTimer);
    this.docTimer = setTimeout(() => {
      this.changed.fire();
      for (const ed of vscode.window.visibleTextEditors) if (ed.document === doc) this.decorate(ed);
      this.updateBar();
    }, ms);
  }

  dispose(): void {
    clearTimeout(this.redrawTimer);
    clearTimeout(this.docTimer);
    this.subs.forEach((d) => d.dispose());
    this.gutter.dispose();
    this.bar.dispose();
    this.changed.dispose();
  }

  /** Threads for a document from the cache; starts a read when missing or stale. */
  private threadsFor(doc: vscode.TextDocument): LensThread[] | undefined {
    const ours = (doc.uri.scheme === AGENT_SCHEME && !doc.uri.query) || (doc.uri.scheme === 'file' && !!vscode.workspace.getWorkspaceFolder(doc.uri));
    if (!cfg.lensEnabled() || !ours) return undefined;
    const hit = this.cache.get(doc.uri.toString());
    if (!hit || Date.now() - hit.at > hit.ttl) void this.load(doc.uri);
    return hit?.threads;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const threads = this.threadsFor(doc);
    return threads && cfg.lensInline() ? this.lenses(doc, threads) : [];
  }

  private async load(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    if (this.loading.has(key)) return;
    this.loading.add(key);
    const g = this.gen;
    try {
      const rel = relPathOf(uri);
      const earlier = uri.scheme === AGENT_SCHEME ? await this.repos.previousPaths(uri) : await previousPaths(uri.fsPath);
      const paths = [rel, ...earlier];
      const queries = searchTexts(paths).slice(0, 3);
      const t0 = Date.now();
      const found = await Promise.all(queries.map((q) => this.search(q)));
      const msgs = found.flatMap((f) => f.msgs);
      const threads = groupLens(msgs, paths, cfg.jiraProjects());
      const via = found.map((f) => f.via + (f.capped ? ' (capped)' : '')).join(', ');
      log.info(
        `[lens] ${nodePath.basename(uri.fsPath)}: "${queries.join('" | "')}" → ${msgs.length} messages, ${threads.length} threads about this file, ${Date.now() - t0} ms via ${via}`,
      );
      await this.client.ensureProfiles(threads.flatMap((x) => x.messages.map((m) => m.pubkey))).catch(() => undefined);
      if (threads.length) await this.loadChannelNames();
      if (g !== this.gen) return; // the key or relay changed meanwhile
      // a search that may have missed something (a full window, a window cut short) is read again sooner
      this.store(key, { at: Date.now(), ttl: found.some((f) => f.capped) ? ERROR_TTL : TTL, threads, paths });
    } catch (e) {
      if (g !== this.gen) return;
      // not set up yet, offline, or an older CLI: try again later, keeping what was found before (a VPN blip
      // should not make the bees disappear)
      const msg = friendlyError(e);
      if (msg !== this.lastError) log.info(`[lens] ${msg}`);
      this.lastError = msg;
      const prev = this.cache.get(key);
      this.store(key, { at: Date.now(), ttl: ERROR_TTL, threads: prev?.threads ?? [], paths: prev?.paths ?? [] });
    } finally {
      if (g === this.gen) this.loading.delete(key);
      this.redraw();
    }
  }

  /**
   * One search over the whole history Buzz lets us read. Over the live connection (NIP-50): a page of 500, and when
   * that page is full the history is read again in time windows, each with its own page, so old conversations are
   * not lost to the relevance order. Without a live connection the CLI runs the same search, one page.
   */
  private async search(q: string): Promise<{ msgs: LensMessage[]; via: 'live' | 'cli'; capped: boolean }> {
    const base = { kinds: CHANNEL_MESSAGE_KINDS, search: q, limit: SEARCH_PAGE };
    try {
      const first = await this.live.fetch([base], SEARCH_TIMEOUT);
      // a read the relay refused or cut short (CLOSED, timeout, connection lost) is no answer: the CLI reads instead
      if (first?.complete) {
        let events = first.events;
        let capped = false;
        if (first.events.length >= SEARCH_PAGE) {
          const now = Math.floor(Date.now() / 1000);
          const cuts = [now - 30 * DAY, now - 180 * DAY, now - 730 * DAY];
          const windows = [
            { ...base, since: cuts[0] },
            { ...base, since: cuts[1], until: cuts[0] },
            { ...base, since: cuts[2], until: cuts[1] },
            { ...base, until: cuts[2] },
          ];
          const pages = await Promise.all(windows.map((w) => this.live.fetch([w], SEARCH_TIMEOUT)));
          capped = pages.some((p) => !p?.complete || p.events.length >= SEARCH_PAGE);
          events = [...first.events, ...pages.flatMap((p) => p?.events ?? [])];
        }
        const seen = new Set<string>();
        const unique: NostrEvent[] = [];
        for (const e of events) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          unique.push(e);
        }
        return { msgs: parseSearch(unique), via: 'live', capped };
      }
    } catch (e) {
      log.info(`[lens] live search failed (${friendlyError(e)}); using the CLI`);
    }
    const raw = await this.client.search(q, SEARCH_PAGE);
    const msgs = parseSearch(raw);
    // what the search found, so a missing lens can be explained from the log (field names only, no content)
    if (hasResults(raw) && !msgs.length) log.info(`[lens] search "${q}": output not recognised (${describeShape(raw)})`);
    return { msgs, via: 'cli', capped: msgs.length >= SEARCH_PAGE };
  }

  private store(key: string, e: Entry): void {
    this.cache.delete(key); // re-inserted at the end: the map stays in least-recently-read order
    this.cache.set(key, e);
    while (this.cache.size > MAX_FILES) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
      this.anchorCache.delete(oldest);
    }
  }

  private async loadChannelNames(): Promise<void> {
    if (Date.now() - this.namesAt < NAMES_TTL) return;
    const g = this.gen;
    try {
      const all = await this.client.allChannels();
      if (g !== this.gen) return;
      this.channelNames = new Map(all.flatMap((c) => (c.ids ?? [c.id]).map((id) => [id, c.isDm ? c.name : `#${c.name}`] as const)));
      this.namesAt = Date.now();
    } catch {
      /* ids stay unnamed */
    }
  }

  private target(th: LensThread): LensTarget {
    const authors = [...new Set(th.messages.map((m) => this.client.nameOf(m.pubkey)))].slice(0, 3).join(', ');
    const where = [this.channelNames.get(th.channel), authors, relTime(th.last)].filter(Boolean).join(' · ');
    const title = [th.jira, th.title].filter(Boolean).join(' · ');
    return { channel: th.channel, messageId: th.messages[th.messages.length - 1].id, title, where };
  }

  /** The code names a thread uses, without the file's own name and folders (every message mentions those). */
  private identsOf(th: LensThread, paths: string[]): string[] {
    let ids = this.idents.get(th);
    if (!ids) {
      const skip = pathWords(paths);
      ids = codeIdentifiers(th.messages.map((m) => m.content).join('\n')).filter((w) => !skip.has(w.toLowerCase()));
      this.idents.set(th, ids);
    }
    return ids;
  }

  /** 0-based line → the threads anchored there (cached per document version). */
  private anchors(doc: vscode.TextDocument, threads: LensThread[]): Map<number, LensTarget[]> {
    const key = doc.uri.toString();
    const hit = this.anchorCache.get(key);
    if (hit && hit.version === doc.version && hit.threads === threads) return hit.byLine;
    const paths = this.cache.get(key)?.paths ?? [relPathOf(doc.uri)];
    const index = wordIndex(doc.getText().split(/\r?\n/));
    const byLine = new Map<number, LensTarget[]>();
    for (const th of threads) {
      const at = anchorLine(index, this.identsOf(th, paths), th.lines);
      if (at === undefined) continue;
      byLine.set(at, [...(byLine.get(at) ?? []), this.target(th)]);
    }
    this.anchorCache.set(key, { version: doc.version, threads, byLine });
    return byLine;
  }

  /** The hover card: clearly from Buzz, with a link that opens the conversation. */
  private hover(targets: LensTarget[], fileName: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['buzz.lens.open'] };
    md.appendMarkdown(`$(comment-discussion) **Buzz Lens** · _${mdEscape(t('lens.hoverNote'))}_\n\n---\n\n`);
    for (const x of targets) {
      const args = linkArgs([[x], fileName]);
      md.appendMarkdown(
        `**${mdEscape(x.title)}**  \n${mdEscape(x.where)}  \n[$(link-external) ${mdEscape(t('lens.openChat'))}](command:buzz.lens.open?${args})\n\n`,
      );
    }
    return md;
  }

  private decorate(ed: vscode.TextEditor): void {
    const threads = this.threadsFor(ed.document);
    if (!threads?.length) {
      ed.setDecorations(this.gutter, []);
      return;
    }
    const opts: vscode.DecorationOptions[] = [];
    for (const [line, targets] of this.anchors(ed.document, threads)) {
      if (line >= ed.document.lineCount) continue;
      opts.push({ range: ed.document.lineAt(line).range, hoverMessage: this.hover(targets, ed.document.fileName) });
    }
    ed.setDecorations(this.gutter, opts);
  }

  private updateBar(): void {
    const ed = vscode.window.activeTextEditor;
    const threads = ed ? this.threadsFor(ed.document) : undefined;
    if (!ed || !threads?.length) {
      this.bar.hide();
      return;
    }
    this.bar.text = `$(comment-discussion) ${threads.length === 1 ? t('lens.count1') : t('lens.count', threads.length)}`;
    this.bar.tooltip = t('lens.statusTip');
    this.bar.show();
  }

  /** Every conversation about the active file (status bar click / command). */
  async showFile(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    const threads = ed ? this.threadsFor(ed.document) : undefined;
    if (!ed || !threads?.length) {
      void vscode.window.showInformationMessage(t('lens.none'));
      return;
    }
    await openLensTargets(
      threads.map((x) => this.target(x)),
      ed.document.fileName,
    );
  }

  /** Optional GitLens-style lines above the code. */
  private lenses(doc: vscode.TextDocument, threads: LensThread[]): vscode.CodeLens[] {
    if (!threads.length) return [];
    const all = threads.map((x) => this.target(x));
    const latest = threads[0];
    const latestWho = this.client.nameOf(latest.messages[latest.messages.length - 1].pubkey);
    const count = threads.length === 1 ? t('lens.count1') : t('lens.count', threads.length);
    const out = [
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: `$(comment-discussion) ${count} · ${t('lens.latest', latestWho, relTime(latest.last))}`,
        tooltip: all.map((x) => `${x.title}\n${x.where}`).join('\n\n'),
        command: 'buzz.lens.open',
        arguments: [all, doc.fileName],
      }),
    ];
    for (const [line, targets] of this.anchors(doc, threads)) {
      if (line === 0) continue;
      const one = targets.length === 1 ? targets[0] : undefined;
      out.push(
        new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: one ? `$(comment) ${one.title} · ${one.where}` : `$(comment) ${t('lens.here', targets.length)}`,
          tooltip: t('lens.open'),
          command: 'buzz.lens.open',
          arguments: [targets, doc.fileName],
        }),
      );
    }
    return out;
  }
}

/** Opens the thread (or lets you pick one) in the chat. */
export async function openLensTargets(targets: LensTarget[], fileName?: string): Promise<void> {
  if (!Array.isArray(targets) || !targets.length) return;
  let pick: LensTarget | undefined = targets[0];
  if (targets.length > 1) {
    const item = await vscode.window.showQuickPick(
      targets.map((x) => ({ label: `$(comment-discussion) ${x.title}`, description: x.where, x })),
      { title: t('lens.pick', fileName ? nodePath.basename(fileName) : ''), matchOnDescription: true },
    );
    pick = item?.x;
  }
  if (pick) await vscode.commands.executeCommand('buzz.openChannel', pick.channel, pick.messageId);
}
