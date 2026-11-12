// Who is around: Buzz's presence answers, typing signals, the "working…" guess after an agent was mentioned, and
// who wrote recently. Bookkeeping only; the chat controller decides when to ask and what to post.
import type { BuzzClient } from './api';
import { CliExit, friendlyError, NostrEvent, Presence, TypingSignal } from './core';
import { log } from './log';
import type { Typist, WorkingItem } from './protocol';

const WORKING_TIMEOUT = 3 * 60; // s: the "waiting for the agent" guess disappears if it doesn't answer in time
const TYPING_TTL = 8; // s: a typing signal is shown this long unless refreshed
const RECENT_ACTIVITY = 120; // s: someone who just wrote counts as online (only without Buzz's presence)
const PRESENCE_FRESH = 5 * 60_000; // ms: an answer older than this says nothing (the view was hidden, nobody asked again)

/** What the open thread, the thread list and the channel header show about typing and working. */
export interface WorkingState {
  /** in the thread on screen */
  items: WorkingItem[];
  /** threads with activity (moving dots in the list) */
  busy: string[];
  /** typing in the channel, outside any thread */
  channel: Typist[];
  /** ms epoch: the earliest typing signal expires then, so the state should be posted again */
  nextExpiry?: number;
}

type Client = Pick<BuzzClient, 'presence' | 'nameOf' | 'isAgent' | 'myPubkey'>;

export class PresenceTracker {
  private readonly working = new Map<string, { since: number; thread: string }>(); // agent -> thread it was asked in ('new' while a thread is being created)
  private readonly typing = new Map<string, { thread?: string; until: number }>(); // pubkey -> real typing signal
  private readonly activity = new Map<string, number>(); // pubkey -> last time we saw them write (s)
  private readonly presence = new Map<string, { status: Presence; at: number }>(); // Buzz's answers, when given
  private brokenUntil = 0; // ms: no presence reads before this time (forever when the CLI has no 'users presence')

  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now, // ms; a clock of their own for the tests
  ) {}

  /** Another channel: what was typed or asked there no longer matters. Presence is global and stays. */
  clear(): void {
    this.working.clear();
    this.typing.clear();
  }

  /** An agent was asked and has not answered yet (polling speeds up). */
  get expecting(): boolean {
    return this.working.size > 0;
  }

  /** After sending: the agents among `pubkeys` are expected to answer in `thread` ('new' until the new thread's root arrives). */
  expect(pubkeys: string[], thread: string, since: number): void {
    for (const p of pubkeys) if (this.client.isAgent(p)) this.working.set(p, { since, thread });
  }

  /** The new thread has its id: guesses made while it was being created move there. */
  retarget(thread: string): void {
    for (const w of this.working.values()) if (w.thread === 'new') w.thread = thread;
  }

  /** A message arrived: its author is no longer typing or working, and was active just now. */
  saw(e: NostrEvent): void {
    const w = this.working.get(e.pubkey);
    if (w && e.created_at >= w.since) this.working.delete(e.pubkey);
    this.typing.delete(e.pubkey);
    this.activity.set(e.pubkey, Math.max(this.activity.get(e.pubkey) ?? 0, e.created_at));
  }

  /** A typing signal from the live connection; false for our own, which change nothing. */
  typingSignal(s: TypingSignal): boolean {
    if (s.pubkey === this.client.myPubkey) return false;
    const now = this.now() / 1000;
    if (s.active) {
      this.typing.set(s.pubkey, { thread: s.thread, until: now + TYPING_TTL });
      this.activity.set(s.pubkey, now);
    } else {
      this.typing.delete(s.pubkey);
    }
    return true;
  }

  /** Asks Buzz who is online; false when there is nothing new to show. */
  async refresh(keys: string[]): Promise<boolean> {
    if (this.now() < this.brokenUntil || !keys.length) return false;
    try {
      const answer = await this.client.presence(keys);
      // Buzz lists only the people with a live presence entry: Buzz Desktop and each agent renew it every minute and
      // it lapses three minutes after the last renewal. Whoever was asked about and is not listed is offline, as
      // Buzz Desktop shows them (keeping the previous answer left people "online" long after they had gone).
      const at = this.now();
      for (const k of keys) {
        const key = k.toLowerCase();
        this.presence.set(key, { status: answer[key] ?? 'offline', at });
      }
      return true;
    } catch (e) {
      // older CLI without 'users presence' (rejected input): stop asking; typing and activity still show who is
      // around. Any other failure (network, garbled output) is tried again in a few minutes.
      const code = (e as { code?: number }).code;
      this.brokenUntil = code === CliExit.Rejected ? Infinity : this.now() + 5 * 60_000;
      log.info(`[presence] ${friendlyError(e)}`);
      return false;
    }
  }

  /**
   * Buzz's recent answers, and whoever is typing right now (a live signal from their client). Who wrote in the last
   * two minutes counts as online only when Buzz cannot say (an older CLI): with presence, Buzz decides, as in Buzz
   * Desktop (a message timestamp is the sender's clock, and a phone or an agent may write for someone who is away).
   */
  effective(): Record<string, Presence> {
    const ms = this.now();
    const now = ms / 1000;
    const out: Record<string, Presence> = {};
    for (const [p, v] of this.presence) if (ms - v.at < PRESENCE_FRESH) out[p] = v.status;
    for (const [p, x] of this.typing) if (x.until > now) out[p] = 'online';
    if (this.brokenUntil === Infinity) for (const [p, ts] of this.activity) if (!out[p] && now - ts < RECENT_ACTIVITY) out[p] = 'online';
    return out;
  }

  /** Drops what expired, then describes the rest. `openThread`: the thread on screen (undefined: "New thread"). */
  state(openThread: string | undefined): WorkingState {
    const now = this.now() / 1000;
    for (const [p, w] of this.working) if (now - w.since > WORKING_TIMEOUT) this.working.delete(p);
    for (const [p, x] of this.typing) if (x.until <= now) this.typing.delete(p);
    const presence = this.effective();
    const here = openThread ?? 'new';
    const people = new Map<string, WorkingItem>();
    const busy = new Set<string>();
    const channel: Typist[] = [];
    for (const [p, x] of this.typing) {
      const entry = { name: this.client.nameOf(p), isAgent: this.client.isAgent(p), real: true };
      if (x.thread) busy.add(x.thread);
      if ((x.thread ?? 'new') === here) people.set(p, entry);
      else if (!x.thread) channel.push(entry);
    }
    for (const [p, w] of this.working) {
      if (presence[p] === 'offline') continue; // asked an agent that isn't running: don't pretend it works
      busy.add(w.thread);
      if (w.thread === here && !people.has(p)) people.set(p, { name: this.client.nameOf(p), isAgent: true, real: false });
    }
    const next = Math.min(...[...this.typing.values()].map((x) => x.until), ...[...this.working.values()].map((w) => w.since + WORKING_TIMEOUT));
    return { items: [...people.values()], busy: [...busy], channel, nextExpiry: isFinite(next) ? next * 1000 : undefined };
  }
}
