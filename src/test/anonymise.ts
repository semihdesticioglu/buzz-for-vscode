// Anonymises what the real Buzz CLI printed, for test/cli-contract/recorded.json (written by
// test/cli-contract/capture.js). Every id, key, name, text and address is replaced, the same value always by the same
// stand-in, and every time moves by one constant. What the extension's parsers depend on stays: object keys, numbers,
// booleans, null, the shape of lists, tag names, and the words the extension reads as values (presence, roles, channel
// types, thread markers). The default is to replace: a string that is not one of those becomes a stand-in.
//
// The leak check does not trust the anonymiser: `originalsOf` collects every string of the raw output that is not kept
// by design, on its own, and `leaks` reports any of them still in the result.
import { createHmac, randomBytes } from 'node:crypto';

/** Words the extension reads as values (core.presenceWord, roles, channel types, thread markers, feed types). */
const KEEP = new Set([
  ...['online', 'active', 'available', 'connected', 'here', 'away', 'idle', 'busy', 'dnd', 'inactive', 'offline'],
  ...['owner', 'admin', 'member', 'moderator', 'guest', 'bot', 'agent', 'human', 'user'],
  ...['open', 'private', 'public', 'closed', 'stream', 'forum', 'dm', 'group', 'channel', 'thread'],
  ...['root', 'reply', 'mention', 'mentions', 'needs_action', 'message', 'messages', 'true', 'false'],
]);
/** Keys whose values are codes (`not_found`, `stream`): kept when they look like one. */
const CODE_KEYS = new Set(['error', 'code', 'category', 'type', 'kind', 'status', 'state', 'presence', 'role', 'visibility', 'marker']);
const CODE = /^[a-z][a-z0-9_.-]{0,30}$/;
/** Keys whose values are written text. */
const TEXT_KEYS = new Set(['content', 'about', 'description', 'message', 'text', 'snippet', 'summary', 'title', 'topic', 'subject']);
/** Keys whose values are names. */
const NAME_KEYS = new Set(['name', 'display_name', 'displayName', 'username', 'author', 'channel_name', 'nip05']);
/** core.looksLikeAgent: a stand-in for an agent's name must still look like one. */
const AGENT_NAME = /(_agent|agent_|_claude|bot)\b/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BECH32 = /^(nsec|npub|note|nevent|nprofile|naddr|nrelay)1[0-9a-z]+$/;
const TAG_NAME = /^[A-Za-z0-9_-]{1,30}$/;
const FLAG = /^--?[a-z][a-z0-9-]*$/i;
const COMMAND_WORD = /^[a-z][a-z-]*$/;
const isEpoch = (n: number) => Number.isInteger(n) && n >= 1_400_000_000 && n <= 2_200_000_000;
const isEpochMs = (n: number) => Number.isInteger(n) && n >= 1_400_000_000_000 && n <= 2_200_000_000_000;

/** A field name, kept as it is (and listed by capture.js for review): a plain identifier that is not an id. */
const isFieldName = (k: string) => /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) && !/^[0-9a-f]{20,}$/i.test(k);

/** Strings kept as they are, by design: empty, the words above, codes under code keys, numbers of up to six digits. */
function keptByDesign(s: string, key?: string): boolean {
  return s === '' || KEEP.has(s.toLowerCase()) || (!!key && CODE_KEYS.has(key) && CODE.test(s)) || /^\d{1,6}$/.test(s);
}

export interface Anonymiser {
  /** A parsed JSON value; `key` is the object key it was found under. */
  value(v: unknown, key?: string): unknown;
  /** A command line: command words and flags stay, values are replaced as they are in the output. */
  args(a: string[]): string[];
  /** Output that is not JSON: only its length is kept. */
  text(s: string): string;
  /** The field names kept, for the person who reviews the recording. */
  readonly keys: ReadonlySet<string>;
}

export function anonymiser(o: { salt?: Buffer; now?: number; shiftTo?: number } = {}): Anonymiser {
  const salt = o.salt ?? randomBytes(32); // never stored: the stand-ins cannot be traced back
  const now = o.now ?? Date.now() / 1000;
  // one constant shift, whole days: order and differences stay, the dates do not
  const delta = Math.round(((o.shiftTo ?? 1_700_000_000) - now) / 86_400) * 86_400;
  const memo = new Map<string, string>();
  const counters = new Map<string, number>();
  const keys = new Set<string>();
  const hex = (v: string, n: number) => createHmac('sha512', salt).update(v).digest('hex').slice(0, n);
  const next = (label: string) => {
    const n = (counters.get(label) ?? 0) + 1;
    counters.set(label, n);
    return n;
  };
  const num = (n: number) => (isEpoch(n) ? n + delta : isEpochMs(n) ? n + delta * 1000 : n);

  function str(s: string, key?: string): string {
    if (keptByDesign(s, key)) return s;
    const known = memo.get(s);
    if (known !== undefined) return known;
    let out: string;
    if (/^[0-9a-f]{64}$/i.test(s)) out = hex(s.toLowerCase(), 64);
    else if (/^[0-9a-f]{128}$/i.test(s)) out = hex(s.toLowerCase(), 128);
    else if (BECH32.test(s)) out = `${s.slice(0, s.indexOf('1'))}1${hex(s, 58)}`;
    else if (/^\d+$/.test(s)) out = isEpoch(Number(s)) ? String(Number(s) + delta) : hex(s, s.length).replace(/[a-f]/g, (c) => String(c.charCodeAt(0) % 10));
    else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) out = `${s.slice(0, s.indexOf(':')).toLowerCase()}://host-${next('host')}.example.invalid`;
    else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) out = `user-${next('email')}@example.invalid`;
    else if (UUID.test(s)) out = hex(s, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    else if (key && TEXT_KEYS.has(key)) out = `text ${next('text')}`;
    else if (AGENT_NAME.test(s)) out = `helper${next('agent')}_agent`;
    else if (key && NAME_KEYS.has(key)) out = `name ${next('name')}`;
    else out = `value-${next('value')}`;
    memo.set(s, out);
    return out;
  }

  function value(v: unknown, key?: string): unknown {
    if (typeof v === 'string') return str(v, key);
    if (typeof v === 'number') return num(v);
    if (Array.isArray(v)) {
      if (key === 'tags')
        return v.map((t) => (Array.isArray(t) ? t.map((x, i) => (i === 0 && typeof x === 'string' && TAG_NAME.test(x) ? x : value(x))) : value(t)));
      return v.map((x) => value(x, key));
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const k2 = isFieldName(k) ? k : str(k);
        if (isFieldName(k)) keys.add(k);
        out[k2] = value(x, k);
      }
      return out;
    }
    return v; // boolean, null
  }

  function args(a: string[]): string[] {
    let command = true; // the words before the first flag are the command ("messages get")
    return a.map((x) => {
      if (FLAG.test(x)) {
        command = false;
        return x;
      }
      if (command && COMMAND_WORD.test(x)) return x;
      command = false;
      const eq = /^(--[a-z][a-z0-9-]*=)([\s\S]*)$/i.exec(x);
      if (eq) return eq[1] + str(eq[2]);
      return x.includes(',')
        ? x
            .split(',')
            .map((p) => str(p))
            .join(',')
        : str(x);
    });
  }

  const text = (s: string) => (s.trim() ? `(${s.length} characters of text, replaced)` : s);

  return { value, args, text, keys };
}

/** Every string of a raw output that must not survive anonymisation, collected without the anonymiser. */
export function originalsOf(v: unknown, key?: string, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') {
    if (!keptByDesign(v, key)) out.add(v);
  } else if (Array.isArray(v)) {
    for (const x of v) {
      if (key === 'tags' && Array.isArray(x))
        x.forEach((y, i) => (i === 0 && typeof y === 'string' && TAG_NAME.test(y) ? undefined : originalsOf(y, undefined, out)));
      else originalsOf(x, key, out);
    }
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!isFieldName(k)) out.add(k);
      originalsOf(x, k, out);
    }
  }
  return out;
}

/** The same for a command line: everything but the command words and flags. */
export function originalsOfArgs(a: string[], out = new Set<string>()): Set<string> {
  let command = true;
  for (const x of a) {
    if (FLAG.test(x)) {
      command = false;
      continue;
    }
    if (command && COMMAND_WORD.test(x)) continue;
    command = false;
    const eq = /^--[a-z][a-z0-9-]*=([\s\S]*)$/i.exec(x);
    for (const p of eq ? [eq[1]] : x.split(',')) if (!keptByDesign(p)) out.add(p);
  }
  return out;
}

/**
 * Originals and secrets still in the anonymised output; empty when it is clean. A short string counts when it is a
 * whole value or key ("lin" inside "online" is not a leak), a long one (eight characters or more) anywhere.
 */
export function leaks(output: unknown, originals: Iterable<string>, secrets: string[] = []): string[] {
  const text = JSON.stringify(output);
  const whole = new Set<string>();
  // a value inside a command-line argument counts as a whole value too: --query=<value>, a,b,c
  const addWhole = (w: string) => {
    whole.add(w);
    const eq = /^--[a-z][a-z0-9-]*=([\s\S]*)$/i.exec(w);
    if (eq) whole.add(eq[1]);
    if (w.includes(',')) for (const part of (eq ? eq[1] : w).split(',')) whole.add(part);
  };
  const walk = (v: unknown): void => {
    if (typeof v === 'string') addWhole(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        whole.add(k);
        walk(x);
      }
    }
  };
  walk(output);
  const found = new Set<string>();
  const inside = (s: string, ci = false) =>
    ci ? text.toLowerCase().includes(JSON.stringify(s).slice(1, -1).toLowerCase()) : text.includes(JSON.stringify(s).slice(1, -1));
  for (const s of originals) if (whole.has(s) || (s.length >= 8 && inside(s))) found.add(s);
  const wholeLower = new Set([...whole].map((w) => w.toLowerCase()));
  for (const s of secrets) if (s && (wholeLower.has(s.toLowerCase()) || (s.length >= 6 && inside(s, true)))) found.add(s);
  return [...found];
}
