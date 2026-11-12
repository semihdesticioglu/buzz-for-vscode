// Buzz client: typed CLI commands + a profile cache.
import { CliOptions, runJson } from './buzzCli';
import {
  displayNameOf,
  DmRow,
  EventPage,
  eventPage,
  groupDmRows,
  isHex64,
  looksLikeAgent,
  NostrEvent,
  parsePresence,
  ReportedRows,
  Presence,
  pubkeyFromPrivate,
} from './core';
import { collator } from './i18n';

export interface Channel {
  id: string;
  name: string;
  description?: string;
  isDm: boolean;
  /** DM only: the other participants */
  peers?: string[];
  /** DM only: every conversation with these people, newest first (`id` is the first); see groupDmRows */
  ids?: string[];
  /** when the channel was created (s), when the CLI says */
  created?: number;
}

export interface Member {
  pubkey: string;
  name: string;
  isAgent: boolean;
  role?: string;
}

export interface SendResult {
  event_id: string;
  accepted: boolean;
  message?: string;
}

type Raw = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

const PROFILE_TTL = 60 * 60_000; // names and agent flags are refreshed after an hour
const EMPTY_TTL = 10 * 60_000; // "no profile" is checked again after ten minutes

/** The most messages of one thread the CLI returns per read. */
export const THREAD_PAGE = 500;

/** A conversation the relay lists as a channel named "dm" (older Buzz): a direct message `dms list` does not report. */
const isLegacyDm = (c: Channel): boolean => /^dm$/i.test(c.name.trim());

const rawChannel = (c: Raw): Channel => ({
  id: str(c['channel_id']) ?? str(c['id']) ?? '',
  name: str(c['name']) ?? '',
  description: str(c['description']),
  isDm: false,
  created: Number(c['created_at']) || undefined,
});

export class BuzzClient {
  private profiles = new Map<string, Raw>();
  private readonly legacyMembers = new Map<string, string[]>(); // "dm" channel -> its members, read once per session
  private fetchedAt = new Map<string, number>();
  private readonly reported = new ReportedRows(); // malformed rows already logged
  private mePubkey?: string;

  /** `warn` receives one line per oddity in the CLI's output (dropped rows); the extension sends it to the log. */
  constructor(
    private readonly options: () => Promise<CliOptions>,
    private readonly warn: (line: string) => void = () => undefined,
  ) {}

  private async json<T>(args: string[], stdin?: string): Promise<T> {
    return runJson<T>(await this.options(), args, stdin);
  }

  /** The objects of a CLI list; a null or a scalar in it is dropped, not dereferenced. */
  private records(v: unknown, what: string): Raw[] {
    this.notAList(v, what);
    return Array.isArray(v) ? v.filter((x): x is Raw => !!x && typeof x === 'object') : [];
  }

  /** Output that is not a list (a CLI version that wraps it, say) reads as nothing: the log says so. */
  private notAList(v: unknown, what: string): void {
    if (v !== null && v !== undefined && !Array.isArray(v)) this.warn(`[cli] the output of \`${what}\` is not a list; nothing was read from it`);
  }

  /**
   * The rows of a CLI page that are messages. Anything else (a null, a number for content, a row without a key or a
   * time) would throw somewhere down the line, so it is dropped here, at the boundary. The page keeps the count
   * (EventPage: a full page stays full), and the log hears of each such row once, not on every poll that reads it.
   */
  private events(v: unknown, what: string): EventPage {
    this.notAList(v, what);
    const bad: unknown[] = [];
    const page = eventPage(v, bad);
    const n = this.reported.fresh(bad);
    if (n) this.warn(`[cli] ${n} malformed row(s) dropped from \`${what}\``);
    return page;
  }

  /** Identity: the public key is derived locally; 'users get' fetches the profile and doubles as a connection/auth check. */
  async me(): Promise<{ pubkey: string; name: string }> {
    const o = await this.options();
    const arr = (await runJson<Raw[]>(o, ['users', 'get'])) ?? [];
    const p = arr[0] ?? {};
    const pubkey = pubkeyFromPrivate(o.key) ?? str(p['pubkey']) ?? '';
    this.mePubkey = pubkey;
    if (pubkey) {
      this.profiles.set(pubkey, p);
      this.fetchedAt.set(pubkey, Date.now());
    }
    return { pubkey, name: displayNameOf(p, pubkey) };
  }

  get myPubkey(): string | undefined {
    return this.mePubkey;
  }

  /** Clears identity and profile cache (after the key changes). */
  reset(): void {
    this.mePubkey = undefined;
    this.profiles.clear();
    this.fetchedAt.clear();
    this.legacyMembers.clear();
  }

  /** The channels I am a member of. */
  async channels(): Promise<Channel[]> {
    const arr = this.records(await this.json<unknown>(['channels', 'list', '--member']), 'channels list');
    return arr
      .map(rawChannel)
      .filter((c) => c.id)
      .sort((a, b) => collator().compare(a.name, b.name));
  }

  /** Channels of the workspace I am not in yet (the open ones; private channels are not listed to outsiders). */
  async joinableChannels(): Promise<Channel[]> {
    const [all, mine] = await Promise.all([this.json<unknown>(['channels', 'list']), this.channels()]);
    const have = new Set(mine.map((c) => c.id));
    return this.records(all, 'channels list')
      .map(rawChannel)
      .filter((c) => c.id && !have.has(c.id))
      .sort((a, b) => collator().compare(a.name, b.name));
  }

  /** Creates a channel (a stream, like the ones Buzz Desktop makes) and returns its id when the CLI reports it. */
  async createChannel(o: { name: string; visibility: 'open' | 'private'; description?: string }): Promise<string | undefined> {
    const args = ['channels', 'create', `--name=${o.name}`, '--type', 'stream', '--visibility', o.visibility];
    if (o.description) args.push(`--description=${o.description}`);
    const r = await this.json<Raw | null>(args);
    return r ? (str(r['channel_id']) ?? str(r['id'])) : undefined;
  }

  async joinChannel(id: string): Promise<void> {
    await this.json<unknown>(['channels', 'join', '--channel', id]);
  }

  async addMember(channel: string, pubkey: string): Promise<void> {
    await this.json<unknown>(['channels', 'add-member', '--channel', channel, '--pubkey', pubkey]);
  }

  /** Everyone I share a channel with (people and agents), once each: the directory for "add a member". */
  async directory(): Promise<Member[]> {
    const chs = (await this.allChannels()).filter((c) => !c.isDm && c.name); // real channels: a DM row has no name
    const lists: Member[][] = [];
    for (let i = 0; i < chs.length; i += 4) {
      // a few CLI processes at a time, not one per channel at once
      lists.push(...(await Promise.all(chs.slice(i, i + 4).map((c) => this.members(c.id).catch(() => [] as Member[])))));
    }
    const out = new Map<string, Member>();
    for (const m of lists.flat()) if (m.pubkey !== this.mePubkey && !out.has(m.pubkey)) out.set(m.pubkey, m);
    return [...out.values()].sort((a, b) => Number(b.isAgent) - Number(a.isAgent) || collator().compare(a.name, b.name));
  }

  /**
   * Channels and direct messages together. A DM that is also listed as a channel counts once; a conversation the
   * relay lists only as a channel named "dm" (older Buzz) is a direct message too: its members say whose it is, and
   * it joins the note of the same people.
   */
  async allChannels(): Promise<Channel[]> {
    if (!this.mePubkey) await this.me().catch(() => undefined); // peers are "everyone but me"
    const [chs, rows] = await Promise.all([this.channels(), this.dmRows().catch(() => [] as DmRow[])]);
    const taken = new Set(rows.map((r) => r.id));
    // conversations listed only as channels named "dm" (older Buzz): one with me and one other person is a direct
    // message. Members are read a few at a time and kept for the session; a failed read is tried again next time,
    // and a "dm" with several people stays a channel (a group, or a real channel someone named so).
    const legacy = chs.filter((c) => !taken.has(c.id) && isLegacyDm(c));
    for (let i = 0; i < legacy.length; i += 4) {
      await Promise.all(
        legacy.slice(i, i + 4).map(async (c) => {
          let members = this.legacyMembers.get(c.id);
          if (!members) {
            try {
              members = (await this.members(c.id)).map((m) => m.pubkey);
            } catch {
              return;
            }
            this.legacyMembers.set(c.id, members);
          }
          const peers = members.filter((p) => p !== this.mePubkey);
          if (peers.length !== 1) return;
          rows.push({ id: c.id, peers, created: c.created ?? 0 });
          taken.add(c.id);
        }),
      );
    }
    const dms = await this.dmChannels(rows);
    return [...chs.filter((c) => !taken.has(c.id)), ...dms];
  }

  /** Direct messages, one per set of participants like Buzz Desktop (the relay may hold several; see groupDmRows). */
  async dms(): Promise<Channel[]> {
    return this.dmChannels(await this.dmRows());
  }

  /** The rows of `dms list`, read defensively because the output shape differs between CLI versions. */
  private async dmRows(): Promise<DmRow[]> {
    const arr = this.records(await this.json<unknown>(['dms', 'list']), 'dms list');
    const rows: DmRow[] = [];
    for (const d of arr) {
      const id = str(d['dm_id']) ?? str(d['channel_id']) ?? str(d['id']);
      if (!id) continue;
      const parts = (Array.isArray(d['participants']) ? d['participants'] : Array.isArray(d['members']) ? d['members'] : []) as unknown[];
      const peers = parts.map((x) => (typeof x === 'string' ? x : str((x as Raw)?.['pubkey']))).filter((x): x is string => !!x && x !== this.mePubkey);
      rows.push({ id, peers, created: Number(d['created_at'] ?? d['updated_at'] ?? 0) || 0, name: str(d['name']) ?? str(d['display_name']) });
    }
    return rows;
  }

  private async dmChannels(rows: DmRow[]): Promise<Channel[]> {
    const groups = groupDmRows(rows);
    await this.ensureProfiles(groups.flatMap((g) => g.peers)); // one batched lookup instead of one per DM
    const out: Channel[] = groups.map((g) => ({
      id: g.ids[0],
      ids: g.ids,
      name: g.name ?? (g.peers.map((k) => this.nameOf(k)).join(', ') || g.ids[0].slice(0, 8)),
      isDm: true,
      peers: g.peers,
    }));
    return out.sort((a, b) => collator().compare(a.name, b.name));
  }

  async messages(channel: string, opts: { limit?: number; since?: number; before?: number } = {}): Promise<EventPage> {
    const args = ['messages', 'get', '--channel', channel, '--limit', String(opts.limit ?? 50)];
    if (opts.since !== undefined) args.push('--since', String(opts.since));
    if (opts.before !== undefined) args.push('--before', String(opts.before));
    const arr = this.events(await this.json<unknown>(args), 'messages get');
    await this.ensureProfiles(arr.map((e) => e.pubkey));
    return arr;
  }

  async thread(channel: string, eventId: string): Promise<EventPage> {
    // the CLI answers with at most 500 messages of the thread (its default is 100); longer threads are completed over the live connection (chat.readThread)
    const arr = this.events(
      await this.json<unknown>(['messages', 'thread', '--channel', channel, '--event', eventId, '--limit', String(THREAD_PAGE)]),
      'messages thread',
    );
    await this.ensureProfiles(arr.map((e) => e.pubkey));
    return arr;
  }

  /** Content goes through stdin (no length or quoting problems). */
  async send(channel: string, content: string, opts: { mentions?: string[]; replyTo?: string } = {}): Promise<SendResult> {
    const args = ['messages', 'send', '--channel', channel, '--content', '-'];
    for (const m of new Set(opts.mentions ?? [])) args.push('--mention', m);
    if (opts.replyTo) args.push('--reply-to', opts.replyTo);
    return this.json<SendResult>(args, content);
  }

  async sendDiff(channel: string, diff: string, o: { repo: string; commit: string; description?: string; sourceBranch?: string }): Promise<SendResult> {
    const args = ['messages', 'send-diff', '--channel', channel, '--diff', '-', '--repo', o.repo, '--commit', o.commit];
    if (o.description) args.push(`--description=${o.description}`);
    if (o.sourceBranch) args.push('--source-branch', o.sourceBranch);
    return this.json<SendResult>(args, diff);
  }

  async members(channel: string): Promise<Member[]> {
    const arr = this.records(await this.json<unknown>(['channels', 'members', '--channel', channel]), 'channels members');
    const keys = arr.map((m) => str(m['pubkey']) ?? '').filter(Boolean);
    await this.ensureProfiles(keys);
    return arr
      .map((m) => {
        const pubkey = str(m['pubkey']) ?? '';
        const name = str(m['display_name']) ?? this.nameOf(pubkey);
        return { pubkey, name, role: str(m['role']), isAgent: looksLikeAgent(this.profiles.get(pubkey), name) };
      })
      .filter((m) => m.pubkey)
      .sort((a, b) => Number(b.isAgent) - Number(a.isAgent) || collator().compare(a.name, b.name));
  }

  async feed(since: number, types = 'mentions,needs_action'): Promise<NostrEvent[]> {
    const arr = this.events(await this.json<unknown>(['feed', 'get', '--since', String(since), '--types', types, '--limit', '30']), 'feed get');
    await this.ensureProfiles(arr.map((e) => e.pubkey));
    return arr;
  }

  /** Online status of users ('users presence'); unknown output shapes give an empty map. */
  async presence(pubkeys: string[]): Promise<Record<string, Presence>> {
    const keys = [...new Set(pubkeys)].filter((k) => isHex64(k));
    const out: Record<string, Presence> = {};
    for (let i = 0; i < keys.length; i += 50) {
      const raw = await this.json<unknown>(['users', 'presence', '--pubkeys', keys.slice(i, i + 50).join(',')]);
      Object.assign(out, parsePresence(raw));
    }
    return out;
  }

  /** Full-text search across the channels you can read (raw output; see lensCore.parseSearch). */
  async search(query: string, limit = 50): Promise<unknown> {
    return this.json<unknown>(['messages', 'search', `--query=${query}`, '--limit', String(limit)]);
  }

  nameOf(pubkey: string): string {
    return displayNameOf(this.profiles.get(pubkey), pubkey);
  }

  isAgent(pubkey: string): boolean {
    return looksLikeAgent(this.profiles.get(pubkey), this.nameOf(pubkey));
  }

  /** Fetches missing profiles in groups of 20 (relay max_authors = 20). */
  async ensureProfiles(pubkeys: string[]): Promise<void> {
    const now = Date.now();
    const stale = (k: string) => {
      const p = this.profiles.get(k);
      if (!p) return true;
      return now - (this.fetchedAt.get(k) ?? 0) > (Object.keys(p).length ? PROFILE_TTL : EMPTY_TTL);
    };
    const missing = [...new Set(pubkeys)].filter((k) => isHex64(k) && stale(k));
    for (let i = 0; i < missing.length; i += 20) {
      const part = missing.slice(i, i + 20);
      let arr: Raw[];
      try {
        arr = this.records(await this.json<unknown>(['users', 'get', ...part.flatMap((k) => ['--pubkey', k])]), 'users get');
      } catch {
        continue; // a failed lookup is tried again next time; meanwhile the short pubkey (or the old name) is shown
      }
      for (const p of arr) {
        const k = str(p['pubkey']);
        if (k) {
          this.profiles.set(k, p);
          this.fetchedAt.set(k, now);
        }
      }
      // asked and not found: no profile for now
      for (const k of part) {
        if (!arr.some((p) => str(p['pubkey']) === k)) {
          if (!this.profiles.has(k)) this.profiles.set(k, {});
          this.fetchedAt.set(k, now);
        }
      }
    }
  }
}
