// Helpers that don't depend on VS Code (unit tests use them directly).
// Note: VS Code's Electron/BoringSSL runtime has no secp256k1, so the curve math is done with plain BigInt.
import { lang, localeUpper, t } from './i18n';

/** A Buzz CLI failure. code: CLI exit code (1 input, 2 network, 3 auth, 4 other, 5 conflict). */
/** Exit codes of the Buzz CLI. */
export enum CliExit {
  Rejected = 1,
  Network = 2,
  Auth = 3,
  Other = 4,
  Conflict = 5,
}

/** Nostr event kinds Buzz shows as messages in a channel: chat, diffs and their reviews, forum posts and comments. */
/** Everything the chat shows as a message; 40003 is a reply kind the CLI's thread read includes. */
export const CHANNEL_MESSAGE_KINDS = [9, 40002, 40003, 40008, 45001, 45003];
/** NIP-29 member list of a channel: one replaceable event per channel (`d` = channel id), members as `p` tags. */
export const MEMBERS_KIND = 39002;

/** A 64-character hex string: an event id or a public key. */
export const isHex64 = (s: string): boolean => /^[0-9a-f]{64}$/i.test(s);

/** Jira project key (ABC) and issue key (ABC-123). */
export const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9]{0,9}$/;
export const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9]{0,9}-\d+$/;

export class BuzzError extends Error {
  constructor(
    public readonly code: number,
    public readonly category: string,
    message: string,
  ) {
    super(message);
    this.name = 'BuzzError';
  }
}

/** Setup is incomplete (no key, relay or CLI). */
export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

export function normalizeRelay(url: string): string {
  return url.trim().replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/+$/, '');
}

/** Relay address from the "- Relay: ws://..." line in ~/.buzz/AGENTS.md. */
export function relayFromAgentsMd(text: string): string | undefined {
  const m = /^\s*-?\s*Relay:\s*(\S+)\s*$/m.exec(text);
  return m ? normalizeRelay(m[1]) : undefined;
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

/** bech32 decoding (NIP-19 nsec/npub) with checksum verification. */
export function bech32Decode(s: string): { hrp: string; bytes: Buffer } | undefined {
  const str = s.trim().toLowerCase();
  const pos = str.lastIndexOf('1');
  if (pos < 1 || pos + 7 > str.length) return undefined;
  const hrp = str.slice(0, pos);
  const data: number[] = [];
  for (const c of str.slice(pos + 1)) {
    const v = BECH32.indexOf(c);
    if (v < 0) return undefined;
    data.push(v);
  }
  const exp = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  if (polymod([...exp, ...data]) !== 1) return undefined;
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const v of data.slice(0, -6)) {
    acc = ((acc << 5) | v) & 0xffff;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return { hrp, bytes: Buffer.from(out) };
}

/** The private key as 64 hex characters (input is hex or nsec1...). */
export function privateKeyHex(key: string): string | undefined {
  const k = key.trim();
  if (/^[0-9a-fA-F]{64}$/.test(k)) return k.toLowerCase();
  if (/^nsec1/i.test(k)) {
    const d = bech32Decode(k);
    if (d && d.hrp === 'nsec' && d.bytes.length === 32) return d.bytes.toString('hex');
  }
  return undefined;
}

// secp256k1 in plain BigInt (no external library or OpenSSL needed)
const CP = 2n ** 256n - 2n ** 32n - 977n;
const CN = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const CG: [bigint, bigint] = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
];
type Pt = [bigint, bigint] | null;
const md = (a: bigint): bigint => ((a % CP) + CP) % CP;

function inv(a: bigint): bigint {
  let [r0, r1, s0, s1] = [md(a), CP, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return md(s0);
}

function padd(a: Pt, b: Pt): Pt {
  if (!a) return b;
  if (!b) return a;
  if (a[0] === b[0] && md(a[1] + b[1]) === 0n) return null;
  const l = a[0] === b[0] && a[1] === b[1] ? md(3n * a[0] * a[0] * inv(2n * a[1])) : md((b[1] - a[1]) * inv(b[0] - a[0]));
  const x = md(l * l - a[0] - b[0]);
  return [x, md(l * (a[0] - x) - a[1])];
}

type Point = [bigint, bigint];
export const SECP_N = CN;
export const SECP_P = CP;
export const pointAdd = (a: Point | null, b: Point | null): Point | null => padd(a, b);

/** k * P (double-and-add). */
export function mulPoint(p0: Point, k0: bigint): Point | null {
  let k = k0;
  let r: Pt = null;
  let p: Pt = p0;
  while (k > 0n) {
    if (k & 1n) r = padd(r, p);
    p = padd(p, p);
    k >>= 1n;
  }
  return r;
}

export const mulG = (k: bigint): Point | null => mulPoint(CG, k);

function powMod(b0: bigint, e0: bigint, m: bigint): bigint {
  let r = 1n;
  let b = b0 % m;
  let e = e0;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

/** BIP-340 lift_x: the point with even y for an x coordinate. */
export function liftX(x: bigint): Point | null {
  if (x >= CP) return null;
  const c = md(x * x * x + 7n);
  const y = powMod(c, (CP + 1n) / 4n, CP);
  if (md(y * y) !== c) return null;
  return [x, y % 2n === 0n ? y : CP - y];
}

/** Nostr public key (x-only, 64 hex) derived locally from the private key; nothing is sent anywhere. */
export function pubkeyFromPrivate(key: string): string | undefined {
  const hex = privateKeyHex(key);
  if (!hex) return undefined;
  const k = BigInt('0x' + hex);
  if (k <= 0n || k >= CN) return undefined;
  const r = mulG(k);
  return r ? r[0].toString(16).padStart(64, '0') : undefined;
}

/** Strips whitespace, invisible characters and quotes that sneak in when copying. */
export function sanitizeKey(s: string): string {
  return s.replace(/[\s\u200B-\u200D\u2060\uFEFF"'`]/g, '');
}

/** A Nostr private key: 64 hex characters or an nsec1... with a valid checksum. */
export function isValidKey(k: string): boolean {
  return pubkeyFromPrivate(sanitizeKey(k)) !== undefined;
}

/** CLI failure output: {"error": category, "message": details} on stderr. */
export function parseCliFailure(code: number, stdout: string, stderr: string): BuzzError {
  for (const text of [stderr, stdout]) {
    for (const line of text.split(/\r?\n/).reverse()) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const j = JSON.parse(t);
        if (j && typeof j.error === 'string') {
          return new BuzzError(code, j.error, String(j.message ?? j.error));
        }
      } catch {
        /* not JSON */
      }
    }
  }
  const raw = (stderr || stdout).trim().split(/\r?\n/).slice(-3).join(' ');
  return new BuzzError(code, 'unknown', raw || t('err.cliExit', code));
}

/** Error text shown to the user, in the UI language. */
export function friendlyError(e: unknown): string {
  if (e instanceof SetupError) return e.message;
  if (e instanceof BuzzError) {
    if (e.category === 'key_error') return t('err.keyInvalid');
    switch (e.code) {
      case CliExit.Auth:
        return t('err.auth', e.message);
      case CliExit.Network:
        return t('err.network', e.message);
      case CliExit.Rejected:
        return t('err.rejected', e.message);
      case CliExit.Conflict:
        return t('err.conflict', e.message);
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

export interface NostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  created_at: number;
  tags: string[][];
  sig?: string;
}

function tagValue(ev: { tags?: string[][] }, name: string): string | undefined {
  return ev.tags?.find((x) => x[0] === name)?.[1];
}

/**
 * A CLI row shaped like a message: what the renderer and the cursors rely on. A null, a number for content, a row
 * without a key or a time would throw in the middle of the list, so such rows are dropped rather than trusted.
 */
export function looksLikeEvent(x: unknown): x is NostrEvent {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    typeof e.pubkey === 'string' &&
    e.pubkey.length > 0 &&
    typeof e.kind === 'number' &&
    typeof e.created_at === 'number' &&
    Number.isFinite(e.created_at) &&
    typeof e.content === 'string' &&
    Array.isArray(e.tags) &&
    e.tags.every((tag) => Array.isArray(tag))
  );
}

/**
 * A page of messages read from the CLI. Rows dropped as malformed are counted in `dropped`: they still count toward
 * the page size, so a full page with a bad row in it is not taken for the end of the history (or of a thread).
 */
export type EventPage = NostrEvent[] & { dropped?: number };

/**
 * The rows of a CLI page that are messages (see looksLikeEvent); the others are dropped and counted, across layers
 * too, and handed to `rejected` when given (to be reported).
 */
export function eventPage(rows: unknown, rejected?: unknown[]): EventPage {
  if (!Array.isArray(rows)) return [];
  const page: NostrEvent[] = [];
  for (const r of rows) {
    if (looksLikeEvent(r)) page.push(r);
    else rejected?.push(r);
  }
  const out = page as EventPage;
  const dropped = rows.length - page.length + ((rows as EventPage).dropped ?? 0);
  if (dropped) out.dropped = dropped;
  return out;
}

/** What was typed in a composer and not sent: the text, the people picked with @, the message it answers. */
export interface Draft {
  text: string;
  mentions?: [string, string][]; // [name, pubkey]
  replyTo?: { id: string; author: string; snippet?: string } | null;
  at?: number; // ms, when it was last changed: the newest are kept
}

/**
 * Drafts as the webview sends them (or as stored), checked: strings where strings belong, empty ones dropped, the
 * newest `max` kept, each text at most `maxChars` (a message cannot be longer anyway).
 */
export function cleanDrafts(v: unknown, max = 30, maxChars = 65536): Record<string, Draft> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const rows: [string, Draft][] = [];
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (key.length > 300 || !raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.text !== 'string' || !r.text.trim()) continue;
    const d: Draft = { text: r.text.slice(0, maxChars), at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0 };
    if (Array.isArray(r.mentions)) {
      d.mentions = r.mentions
        .filter((m): m is [string, string] => Array.isArray(m) && m.length === 2 && typeof m[0] === 'string' && typeof m[1] === 'string')
        .slice(0, 50);
    }
    const to = r.replyTo as Record<string, unknown> | null | undefined;
    if (to && typeof to === 'object' && typeof to.id === 'string' && typeof to.author === 'string') {
      d.replyTo = { id: to.id, author: to.author, ...(typeof to.snippet === 'string' ? { snippet: to.snippet.slice(0, 300) } : {}) };
    }
    rows.push([key, d]);
  }
  rows.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0));
  return Object.fromEntries(rows.slice(0, max));
}

/** TLS errors that mean "this computer does not trust the relay's certificate" (Node's error codes). */
const CERT_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Whether a connection failed because the relay's TLS certificate is not trusted here (unknown issuer, expired, wrong name). */
export function isCertificateError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  return (typeof code === 'string' && CERT_ERRORS.has(code)) || (typeof message === 'string' && /\bcertificate\b/i.test(message));
}

/** How many rows the CLI sent for a page, malformed ones included: what "a full page" is judged by. */
export function rowsSent(page: EventPage): number {
  return page.length + (page.dropped ?? 0);
}

/**
 * Malformed rows already reported, known by what they are: each is logged once, however often a poll reads it again
 * and whichever read brings it (the latest page, an older one, a thread). The oldest are forgotten past `max`.
 */
export class ReportedRows {
  private readonly seen = new Set<string>();

  constructor(private readonly max = 500) {}

  /** How many of these rows were not reported before; from now on they count as reported. */
  fresh(rows: unknown[]): number {
    let n = 0;
    for (const r of rows) {
      let key: string;
      try {
        key = String(JSON.stringify(r) ?? r).slice(0, 400);
      } catch {
        key = '(a row too deeply nested to write out)'; // JSON.stringify gives up a few thousand levels down
      }
      if (this.seen.has(key)) continue;
      if (this.seen.size >= this.max) this.seen.delete(this.seen.values().next().value as string);
      this.seen.add(key);
      n++;
    }
    return n;
  }
}

/** Channel UUID of a channel message (the 'h' tag). */
export function channelOf(ev: { tags?: string[][] }): string | undefined {
  return tagValue(ev, 'h');
}

/** Root message id when the event is a thread reply (NIP-10 'e' tag with a root/reply marker). */
export function replyRootOf(ev: { tags?: string[][] }): string | undefined {
  const es = (ev.tags ?? []).filter((x) => x[0] === 'e');
  return (es.find((x) => x[3] === 'root') ?? es.find((x) => x[3] === 'reply'))?.[1];
}

/** Deletion events: NIP-09 (kind 5) and NIP-29 moderation delete (kind 9005). */
const DELETION_KINDS = [5, 9005];

/** Ids removed by a deletion event (its 'e' tags); undefined for any other event. */
export function deletedIdsOf(ev: { kind: number; tags?: string[][] }): string[] | undefined {
  if (!DELETION_KINDS.includes(ev.kind)) return undefined;
  return (ev.tags ?? []).filter((x) => x[0] === 'e' && isHex64(x[1] ?? '')).map((x) => x[1].toLowerCase());
}

/**
 * Compares a fresh page of the latest channel messages with what is shown.
 * removed: shown messages the page should contain but doesn't (deleted in Buzz). Only messages that an
 * earlier page returned are judged (`pageSeen`), and only inside the time window the page covers, so
 * messages that arrived another way (thread fetch, older pages) are never dropped by mistake.
 * edited: messages whose content changed.
 */
export function reconcilePage(
  known: ReadonlyMap<string, NostrEvent>,
  page: NostrEvent[],
  pageSeen: ReadonlySet<string>,
): { removed: string[]; edited: NostrEvent[] } {
  const got = new Map(page.map((e) => [e.id, e]));
  const edited = page.filter((e) => {
    const old = known.get(e.id);
    return !!old && old.content !== e.content;
  });
  const removed: string[] = [];
  if (page.length) {
    // only the page's own time window can be judged: a short page may be the relay's cap, not the whole channel
    const from = Math.min(...page.map((e) => e.created_at));
    for (const [id, e] of known) if (e.created_at > from && !got.has(id) && pageSeen.has(id)) removed.push(id);
  }
  return { removed, edited };
}

/** The message a reply directly answers: the NIP-10 'reply' marker, otherwise the root. */
export function replyParentOf(ev: { tags?: string[][] }): string | undefined {
  const es = (ev.tags ?? []).filter((x) => x[0] === 'e');
  return (es.find((x) => x[3] === 'reply') ?? es.find((x) => x[3] === 'root'))?.[1];
}

export interface ThreadEntry {
  ev: NostrEvent;
  depth: number; // 0: the root and replies to it; 1+: replies to a reply
  parent?: string; // set when depth > 0
}

/**
 * A thread in conversation order, as Buzz Desktop shows it: every reply comes right after the
 * message it answers (and that message's earlier replies), siblings in time order.
 * A reply whose parent isn't loaded is shown at the top level.
 */
export function threadOrder(root: NostrEvent | undefined, replies: NostrEvent[]): ThreadEntry[] {
  const ids = new Set(replies.map((r) => r.id));
  if (root) ids.add(root.id);
  const top = '\u0000top';
  const children = new Map<string, NostrEvent[]>();
  for (const r of replies) {
    const p = replyParentOf(r);
    const key = p && p !== r.id && ids.has(p) && p !== root?.id ? p : top;
    const list = children.get(key) ?? [];
    list.push(r);
    children.set(key, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  const out: ThreadEntry[] = [];
  const seen = new Set<string>();
  const walk = (key: string, depth: number) => {
    for (const ev of children.get(key) ?? []) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      out.push(depth ? { ev, depth, parent: key } : { ev, depth });
      walk(ev.id, depth + 1);
    }
  };
  if (root) out.push({ ev: root, depth: 0 });
  walk(top, 0);
  // anything left (e.g. a reply cycle in malformed data) goes at the end
  for (const r of replies) if (!seen.has(r.id)) out.push({ ev: r, depth: 0 });
  return out;
}

/** Short plain-text summary (markdown removed) for lists. */
export function plainSnippet(content: string, max = 140): string {
  // only the start matters for a snippet; this also keeps the regexes fast on very long messages
  return content
    .slice(0, Math.max(2000, max * 20))
    .replace(/```[\s\S]*?```/g, ` [${t('snip.code')}] `)
    .replace(/!\[[^\]\n[]*\]\([^)\n]*\)/g, ` [${t('snip.image')}] `)
    .replace(/\[([^\]\n[]+)\]\([^)\n]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__|~~|[`*|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export interface ThreadGroup {
  id: string; // root message id
  root?: NostrEvent; // may not be loaded yet when the root is older
  replies: NostrEvent[];
  last: number; // time of the latest activity
}

/** Groups messages into threads (root + replies); most recent activity first. */
export function groupThreads(evs: NostrEvent[]): ThreadGroup[] {
  const byId = new Map(evs.map((e) => [e.id, e] as const));
  const rootOf = (e: NostrEvent): string | undefined => {
    let r = replyRootOf(e);
    for (let i = 0; r && i < 20; i++) {
      const parent = byId.get(r);
      const up = parent && replyRootOf(parent);
      if (!up) break;
      r = up;
    }
    return r;
  };
  const groups = new Map<string, ThreadGroup>();
  for (const e of evs) {
    const r = rootOf(e);
    const id = r ?? e.id;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { id, replies: [], last: 0 }));
    if (r) g.replies.push(e);
    else g.root = e;
    g.last = Math.max(g.last, e.created_at);
  }
  for (const g of groups.values()) g.replies.sort((a, b) => a.created_at - b.created_at);
  return [...groups.values()].sort((a, b) => b.last - a.last);
}

/** Post-it color (0-5) of a channel; stable for a channel id. */
export function chipColor(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 6;
}

export type Presence = 'online' | 'away' | 'offline';

function presenceWord(v: unknown): Presence | undefined {
  if (typeof v === 'boolean') return v ? 'online' : 'offline';
  if (typeof v !== 'string') return undefined;
  const s = v.toLowerCase();
  if (/^(online|active|available|connected|here)$/.test(s)) return 'online';
  if (/^(away|idle|busy|dnd|inactive)$/.test(s)) return 'away';
  return 'offline';
}

/**
 * Reads 'users presence' output. The CLI does not document its shape, so this accepts
 * [{pubkey, status}], {pubkey: status}, {pubkey: {status}} and {presence|users|data: ...}.
 */
export function parsePresence(raw: unknown): Record<string, Presence> {
  const out: Record<string, Presence> = {};
  const isKey = (k: unknown): k is string => typeof k === 'string' && isHex64(k);
  const statusOf = (o: unknown): Presence | undefined => {
    if (o === null || typeof o !== 'object') return presenceWord(o);
    const r = o as Record<string, unknown>;
    return presenceWord(r['status'] ?? r['presence'] ?? r['state'] ?? r['online']);
  };
  const walk = (v: unknown, depth: number): void => {
    if (depth > 3 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (x && typeof x === 'object' && !Array.isArray(x)) {
          const r = x as Record<string, unknown>;
          const k = r['pubkey'] ?? r['user'] ?? r['id'];
          const st = statusOf(r);
          if (isKey(k) && st) out[k.toLowerCase()] = st;
        }
      }
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (isKey(k)) {
        const st = statusOf(x);
        if (st) out[k.toLowerCase()] = st;
      } else {
        walk(x, depth + 1);
      }
    }
  };
  walk(raw, 0);
  return out;
}

/** Ephemeral typing event (kind 20002): who, where, and whether it starts or stops. */
export interface TypingSignal {
  pubkey: string;
  channel?: string;
  thread?: string;
  active: boolean;
}

export const TYPING_KIND = 20002;

export function parseTyping(ev: NostrEvent): TypingSignal | undefined {
  if (ev.kind !== TYPING_KIND || !ev.pubkey) return undefined;
  let active = true;
  const c = (ev.content ?? '').trim();
  if (c) {
    let v: unknown = c;
    try {
      v = JSON.parse(c);
    } catch {
      /* plain text */
    }
    if (v && typeof v === 'object') {
      const r = v as Record<string, unknown>;
      if (r['typing'] === false || r['active'] === false) active = false;
      v = r['status'] ?? r['state'] ?? '';
    }
    if (typeof v === 'string' && /^(stop|stopped|idle|done|false|0|end|ended|cancel(l)?ed)$/i.test(v.trim())) active = false;
    if (v === false || v === 0) active = false;
  }
  return { pubkey: ev.pubkey, channel: channelOf(ev), thread: replyRootOf(ev) ?? tagValue(ev, 'e'), active };
}

/** A code fence longer than any backtick run inside the code. */
export function fenceFor(code: string): string {
  let max = 2;
  for (const m of code.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return '`'.repeat(max + 1);
}

const LANG: Record<string, string> = {
  typescriptreact: 'tsx',
  javascriptreact: 'jsx',
  shellscript: 'bash',
  powershell: 'powershell',
  plaintext: '',
};

function fenceLang(languageId: string): string {
  return languageId in LANG ? LANG[languageId] : languageId;
}

export interface CodeContext {
  /** code: an editor selection; error: a problem from the Problems panel; terminal: terminal output */
  kind?: 'code' | 'error' | 'terminal';
  relPath: string; // empty for terminal output
  startLine: number; // 1-based
  endLine: number;
  languageId: string;
  code: string;
  /** error: "line 12: Cannot find name 'x' (ts 2304)"; terminal: the terminal's name */
  message?: string;
}

/** Short label for a context chip. */
export function contextLabel(c: CodeContext): string {
  if (c.kind === 'terminal') return `${t('ctx.terminal')}${c.message ? ` · ${c.message}` : ''}`;
  const range = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
  const file = `${c.relPath.split('/').pop()}:${range}`;
  return c.kind === 'error' ? `${t('ctx.error')} · ${file}` : file;
}

/** A context as Markdown: `path:L10-L25` + fenced code; errors and terminal output get a heading line. */
export function codeBlock(c: CodeContext): string {
  const f = fenceFor(c.code);
  const body = c.code.replace(/\s+$/, '');
  if (c.kind === 'terminal') {
    return `**${t('ctx.terminal')}**${c.message ? ` (${c.message})` : ''}\n${f}text\n${body}\n${f}`;
  }
  const range = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}-L${c.endLine}`;
  const code = `\`${c.relPath}:${range}\`\n${f}${fenceLang(c.languageId)}\n${body}\n${f}`;
  if (c.kind === 'error') {
    const msg = (c.message ?? '')
      .trim()
      .split(/\r?\n/)
      .map((l) => `> ${l}`)
      .join('\n');
    return `**${t('ctx.error')}**\n${msg}\n\n${code}`;
  }
  return code;
}

/** Message sent to a channel: "@agent note" + the code block. */
export function composeCodeMessage(mentionNames: string[], note: string, c: CodeContext): string {
  const head = [mentionNames.map((n) => `@${n}`).join(' '), note.trim()].filter(Boolean).join(' ');
  return [head, codeBlock(c)].filter(Boolean).join('\n\n');
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Buzz content limit: 65,536 bytes. */
export const MAX_CONTENT_BYTES = 65536;

/**
 * Branches and commits an agent message reports, for "Show diff / Approve / Request changes".
 * Branches: feature/..., fix/..., hotfix/... (not the base branch). Commits: a hash right after "commit" or "merge"
 * ("commit'i 9c4e2b7", "merge e27c4a8") or in backticks; a base mentioned in passing ("taban buzz 6b0f19d",
 * "3d81a5e üstüne") is not the work itself. Code blocks are ignored (logs, diffs, commands).
 */
export function gitRefsIn(content: string): { branches: string[]; commits: string[] } {
  const text = content.replace(/```[\s\S]*?```/g, ' ');
  const branches = new Set<string>();
  for (const m of text.matchAll(/(?<![\w/.-])((?:feature|fix|bugfix|hotfix|release|chore)\/[A-Za-z0-9._\-/]*[A-Za-z0-9_])/g)) branches.add(m[1]);
  const commits = new Set<string>();
  const suffix = "(?:'?[a-zçğıöşü]{1,4})?";
  const after = new RegExp(`\\b(?:commit|merge)${suffix}(?:\\s+commit${suffix})?\\s*[:#]?\\s*\`?([0-9a-f]{7,40})(?![0-9a-z])`, 'gi');
  for (const m of text.matchAll(after)) commits.add(m[1].toLowerCase());
  for (const m of text.matchAll(/`([0-9a-f]{7,40})`/g)) if (/[a-f]/.test(m[1]) && /\d/.test(m[1])) commits.add(m[1].toLowerCase());
  return { branches: [...branches].slice(0, 5), commits: [...commits].slice(0, 5) };
}

/** The Buzz CLI's file name on this platform. */
export const cliName = (platform: string): string => (platform === 'win32' ? 'buzz.exe' : 'buzz');

/**
 * Places the Buzz CLI is looked for, most likely first. On Windows Buzz Desktop puts it in %LOCALAPPDATA%\Buzz,
 * on a Mac in ~/.local/bin (seen on a team member's Mac); the app bundle is checked too. `apps`: Buzz app bundles
 * found in /Applications or ~/Applications (macOS). Then the usual command-line folders and PATH.
 */
export function cliCandidates(env: Record<string, string | undefined>, platform: string, home: string, apps: string[] = []): string[] {
  const win = platform === 'win32';
  const exe = cliName(platform);
  const sep = win ? '\\' : '/';
  const join = (...p: string[]) => p.join(sep);
  const out: string[] = [];
  if (win) {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    out.push(join(local, 'Buzz', exe), join(local, 'Programs', 'Buzz', exe));
    for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)']]) if (pf) out.push(join(pf, 'Buzz', exe));
  } else if (platform === 'darwin') {
    out.push(join(home, '.local', 'bin', 'buzz'));
    for (const app of [...apps, '/Applications/Buzz.app', join(home, 'Applications', 'Buzz.app')]) {
      out.push(join(app, 'Contents', 'MacOS', exe), join(app, 'Contents', 'Resources', exe));
    }
    out.push('/usr/local/bin/buzz', '/opt/homebrew/bin/buzz', join(home, '.local', 'bin', 'buzz'), join(home, '.buzz', 'bin', 'buzz'));
  } else {
    out.push(
      '/usr/bin/buzz',
      '/usr/local/bin/buzz',
      '/opt/Buzz/buzz',
      '/opt/buzz/buzz',
      join(home, '.local', 'bin', 'buzz'),
      join(home, '.buzz', 'bin', 'buzz'),
    );
  }
  for (const dir of (env.PATH || env.Path || '').split(win ? ';' : ':')) if (dir.trim()) out.push(join(dir.trim().replace(/[\\/]+$/, ''), exe));
  return [...new Set(out)];
}

/** A relative path from a message: forward slashes, no leading "./" or "/". */
export const normalizeRel = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

/** A path from a message stays inside the workspace: no "..", no drive letter, no UNC or URI. */
export const isSafeRel = (p: string): boolean => {
  const raw = p.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('//') || /^[a-z][\w+.-]*:/i.test(raw)) return false;
  return !normalizeRel(raw)
    .split('/')
    .some((s) => s === '..');
};

/**
 * The repository address to publish with a diff: https, without user name, password or token.
 * scp-style and ssh:// remotes become https. Undefined when no web address can be made (local repo).
 */
export function publicRepoUrl(origin: string): string | undefined {
  let s = origin.trim();
  if (!s || /^[a-zA-Z]:[\\/]/.test(s)) return undefined; // a Windows path
  const scp = /^(?:[^@/\s]+@)?([\w.-]{2,}):(?!\/\/)\/?(.+)$/.exec(s); // git@host:org/repo.git
  if (scp && !/^[a-z][\w+.-]*:\/\//i.test(s)) s = `https://${scp[1]}/${scp[2]}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (/^(ssh|git|git\+ssh|ssh\+git):$/.test(u.protocol)) return u.hostname ? `https://${u.hostname}${u.pathname}` : undefined;
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  u.username = '';
  u.password = '';
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** Cuts text so its UTF-8 size stays within `max` bytes (never in the middle of a character). */
export function truncateBytes(s: string, max: number): string {
  if (utf8Bytes(s) <= max) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(s.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  let cut = s.slice(0, lo);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

export function displayNameOf(p: Record<string, unknown> | undefined, pubkey: string): string {
  const n = p && (p['display_name'] || p['displayName'] || p['name']);
  return typeof n === 'string' && n.trim() ? n.trim() : pubkey.slice(0, 8);
}

/** Profiles that look like agents (bot flag or agent-style names). */
export function looksLikeAgent(p: Record<string, unknown> | undefined, name: string): boolean {
  if (p && (p['bot'] === true || p['agent'] === true)) return true;
  return /(_agent|agent_|_claude|bot)\b/i.test(name);
}

export function initials(name: string): string {
  const parts = name
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .split(/\s+/);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return localeUpper(s);
}

/** Short time: 14:05 today, otherwise 06.11 14:05. */
export function shortTime(ts: number, now = Date.now() / 1000): string {
  const d = new Date(ts * 1000);
  const n = new Date(now * 1000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`;
}

// ------------------------------------------------------------------ file and Jira references

export interface FileRef {
  path: string;
  line?: number;
  end?: number;
}

const FILE_RE = /^((?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7})(?::L?(\d+)(?:-L?(\d+))?)?$/;

/** "pipeline/steps/rollup.py:142", "a.sql:10-20", "sql/order_status.sql" -> a file reference. Needs a line or a folder. */
export function parseFileRef(s: string): FileRef | undefined {
  const m = FILE_RE.exec(s.trim());
  if (!m) return undefined;
  if (!m[2] && !/[\\/]/.test(m[1])) return undefined; // a bare "order_status.sql" is not treated as a file
  if (/^https?:/i.test(s) || /^\d/.test(m[1].split(/[\\/]/).pop() ?? '')) return undefined;
  return { path: m[1].replace(/\\/g, '/'), line: m[2] ? Number(m[2]) : undefined, end: m[3] ? Number(m[3]) : undefined };
}

/** Pattern for file references inside plain (non-code) text. */
export const FILE_IN_TEXT = String.raw`(?:[\w.\-]+/)+[\w.\-]+\.[A-Za-z][A-Za-z0-9]{0,7}(?::L?\d+(?:-L?\d+)?)?|[\w.\-]+\.[A-Za-z][A-Za-z0-9]{0,7}:L?\d+(?:-L?\d+)?`;

/** Seconds as hours: "2.5 h" in English, "2,5 sa" in Turkish. */
export function formatHours(seconds: number): string {
  const h = Math.round((seconds / 3600) * 100) / 100;
  return t('hours', lang() === 'tr' ? String(h).replace('.', ',') : String(h));
}

export interface FeedCursor {
  since: number;
  ids: string[]; // events at exactly `since`, so the same second is not announced twice
}

/** The feed events newer than the cursor, and the cursor to store for the next read. */
export function advanceCursor(cur: FeedCursor, events: NostrEvent[]): { fresh: NostrEvent[]; next: FeedCursor } {
  const seen = new Set(cur.ids);
  const fresh = events.filter((e) => e.created_at >= cur.since && !seen.has(e.id));
  if (!fresh.length) return { fresh, next: cur };
  const max = Math.max(...fresh.map((e) => e.created_at));
  const ids = [...fresh.filter((e) => e.created_at === max).map((e) => e.id), ...(max === cur.since ? cur.ids : [])];
  return { fresh, next: { since: max, ids } };
}

/** Where Buzz Desktop itself is installed (to start it when the agents are offline). */
export function desktopCandidates(env: Record<string, string | undefined>, platform: string, home: string, apps: string[] = []): string[] {
  const out: string[] = [];
  if (platform === 'win32') {
    const join = (...p: string[]) => p.join('\\');
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    out.push(join(local, 'Buzz', 'buzz-desktop.exe'), join(local, 'Programs', 'Buzz', 'buzz-desktop.exe'), join(local, 'Programs', 'Buzz', 'Buzz.exe'));
    for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)']]) if (pf) out.push(join(pf, 'Buzz', 'buzz-desktop.exe'));
  } else if (platform === 'darwin') {
    out.push(...apps, '/Applications/Buzz.app', `${home}/Applications/Buzz.app`, '/Applications/Buzz Desktop.app');
  } else {
    out.push('/usr/bin/buzz-desktop', '/usr/local/bin/buzz-desktop', '/opt/Buzz/buzz-desktop', '/opt/buzz/buzz-desktop', `${home}/.local/bin/buzz-desktop`);
    for (const d of (env.PATH ?? '').split(':').filter(Boolean)) out.push(`${d.replace(/\/+$/, '')}/buzz-desktop`);
  }
  return [...new Set(out)];
}

/** One row of `dms list`. */
export interface DmRow {
  id: string;
  /** the other participants */
  peers: string[];
  created: number;
  name?: string;
}

/** A DM as the chat shows it: every conversation with the same people, newest first. */
export interface DmGroup {
  ids: string[];
  peers: string[];
  name?: string;
}

/**
 * Buzz may hold several DM conversations with the same participants (every `dms open` makes a new one, and the list
 * does not dedupe them); Buzz Desktop shows one per person. So does the chat: one group per set of participants,
 * repeated ids counted once. A row whose participants are unknown stays on its own.
 */
export function groupDmRows(rows: DmRow[]): DmGroup[] {
  const groups = new Map<string, { peers: string[]; name?: string; rows: DmRow[] }>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const peers = [...new Set(r.peers)].sort();
    const key = peers.length ? peers.join(',') : `id:${r.id}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { peers, rows: [] }));
    g.rows.push(r);
    g.name ??= r.name;
  }
  return [...groups.values()].map((g) => ({ ids: [...g.rows].sort((a, b) => b.created - a.created).map((r) => r.id), peers: g.peers, name: g.name }));
}
