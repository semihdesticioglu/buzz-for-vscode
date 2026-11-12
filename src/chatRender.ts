// What a message becomes on screen: rendered markdown, proposal and git bars, the snippet for the thread list.
// The expensive part is done once per message (again after an edit) and dropped when the channel changes.
import type { BuzzClient } from './api';
import * as cfg from './config';
import { gitRefsIn, initials, NostrEvent, plainSnippet, replyRootOf, shortTime, ThreadEntry } from './core';
import { extractBlocks, renderMarkdown } from './markdown';
import { Plan, planFiles, planFor } from './patch';
import type { GitBar, MessageItem, PatchBar } from './protocol';

interface Rendered {
  /** the text this was made from: an edited message is rendered again */
  content: string;
  html: string;
  patches: PatchBar[];
  git?: GitBar;
  snippet: string;
}

type Names = Pick<BuzzClient, 'nameOf' | 'isAgent' | 'myPubkey'>;

/** How long the relay's host is kept: behind imageHost() may sit a file read (~/.buzz/AGENTS.md), not one per message. */
const HOST_TTL_MS = 5_000;

export class MessageRenderer {
  private host: { at: number; value: string | undefined } | undefined;
  private readonly rendered = new Map<string, Rendered>();
  private readonly snippets = new Map<string, { content: string; text: string }>(); // "id:length" -> snippet
  private readonly plans = new Map<string, { content: string; plan: Plan }>(); // "id:block" -> proposal, for the text it came from

  constructor(
    private readonly names: Names,
    private readonly imageHost: () => string | undefined,
  ) {}

  /** Forgets everything: another channel, another language, or a setting that changes the rendering. */
  clear(): void {
    this.rendered.clear();
    this.snippets.clear();
    this.plans.clear();
    this.host = undefined;
  }

  /** The image host, looked up once per batch rather than once per message. */
  private relayHost(): string | undefined {
    const now = Date.now();
    if (!this.host || now - this.host.at > HOST_TTL_MS) this.host = { at: now, value: this.imageHost() };
    return this.host.value;
  }

  /** The plain-text snippet of a message, at most `max` characters; computed once per message and length. */
  snippet(e: NostrEvent, max: number): string {
    const key = `${e.id}:${max}`;
    const hit = this.snippets.get(key);
    if (hit && hit.content === e.content) return hit.text;
    const text = plainSnippet(e.content, max);
    this.snippets.set(key, { content: e.content, text });
    return text;
  }

  /** The proposal in one code block of a message, if the block is one. */
  plan(e: NostrEvent | undefined, block: number): Plan | undefined {
    if (!e) return undefined;
    const key = `${e.id}:${block}`;
    const hit = this.plans.get(key);
    if (hit && hit.content === e.content) return hit.plan; // an edited message gets its proposals read again
    const b = extractBlocks(e.content).find((x) => x.index === block);
    const plan = b ? planFor(b) : undefined;
    if (plan) this.plans.set(key, { content: e.content, plan });
    return plan;
  }

  /** The branches and commits a message reports, if any. */
  gitRefs(e: NostrEvent): GitBar | undefined {
    const g = gitRefsIn(e.content);
    return g.branches.length || g.commits.length ? g : undefined;
  }

  /** One message as the webview shows it; `at` places it in the thread, `parent` is the message it answers. */
  item(e: NostrEvent, at?: ThreadEntry, parent?: NostrEvent): MessageItem {
    const author = this.names.nameOf(e.pubkey);
    const isMe = e.pubkey === this.names.myPubkey;
    const r = this.render(e, isMe);
    return {
      id: e.id,
      pubkey: e.pubkey,
      author,
      initials: initials(author),
      isMe,
      isAgent: this.names.isAgent(e.pubkey),
      isRoot: !replyRootOf(e),
      time: shortTime(e.created_at),
      ts: e.created_at,
      html: r.html,
      patches: r.patches,
      git: r.git,
      depth: at?.depth ?? 0,
      parentId: at?.parent,
      parentAuthor: parent ? this.names.nameOf(parent.pubkey) : undefined,
      snippet: r.snippet,
    };
  }

  private render(e: NostrEvent, isMe: boolean): Rendered {
    const hit = this.rendered.get(e.id);
    if (hit && hit.content === e.content) return hit;
    const patches: PatchBar[] = [];
    if (!isMe) {
      for (const b of extractBlocks(e.content)) {
        const plan = planFor(b);
        if (!plan) continue;
        this.plans.set(`${e.id}:${b.index}`, { content: e.content, plan });
        patches.push({ block: b.index, files: planFiles(plan), local: cfg.applyLocally() });
      }
    }
    const r: Rendered = {
      content: e.content,
      html: renderMarkdown(e.content, { jiraUrl: cfg.jiraUrl(), jiraKeys: cfg.jiraProjects(), imageHost: this.relayHost() }),
      patches,
      git: isMe ? undefined : this.gitRefs(e),
      snippet: plainSnippet(e.content, 80),
    };
    this.rendered.set(e.id, r);
    return r;
  }
}
