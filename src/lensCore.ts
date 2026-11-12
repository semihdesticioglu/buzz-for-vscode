// Buzz Lens logic (no vscode): which Buzz conversations talk about a file, and where in the file.
// Nothing is stored: the source is Buzz's own message search, read when a file is opened.
import { channelOf, JIRA_PROJECT_KEY, plainSnippet, replyRootOf } from './core';
import { t } from './i18n';

export interface LensMessage {
  id: string;
  pubkey: string;
  channel: string;
  root: string; // thread root id (the message itself when it is a root)
  created_at: number;
  content: string;
}

export interface LensThread {
  channel: string;
  root: string;
  messages: LensMessage[]; // the messages in this thread that mention the file, oldest first
  last: number;
  lines: number[]; // line numbers written next to the file name (e.g. "a.sql:22")
  jira?: string;
  title: string;
}

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Reads 'messages search' output defensively: a list of events, or {messages|results|events|data: [...]}, items may wrap {event}. */
export function parseSearch(raw: unknown): LensMessage[] {
  let list: unknown = raw;
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    const r = list as Raw;
    list = r['messages'] ?? r['results'] ?? r['events'] ?? r['data'] ?? [];
  }
  if (!Array.isArray(list)) return [];
  const out: LensMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Raw;
    const ev = (it['event'] && typeof it['event'] === 'object' ? it['event'] : it) as Raw;
    const id = str(ev['id']) ?? str(it['event_id']);
    const content = typeof ev['content'] === 'string' ? (ev['content'] as string) : undefined;
    const tags = Array.isArray(ev['tags']) ? (ev['tags'] as string[][]) : [];
    const channel = channelOf({ tags }) ?? str(it['channel_id']) ?? str(it['channel']) ?? str(ev['channel_id']);
    const created = Number(ev['created_at'] ?? it['created_at'] ?? it['timestamp']);
    if (!id || content === undefined || !channel || !isFinite(created)) continue;
    out.push({
      id,
      pubkey: str(ev['pubkey']) ?? str(it['pubkey']) ?? str(it['author']) ?? '',
      channel,
      root: replyRootOf({ tags }) ?? id,
      created_at: created,
      content,
    });
  }
  return out;
}

/** The shape of an output (field names only, never values), for the log when parseSearch can't read it. */
export function describeShape(raw: unknown): string {
  const keys = (o: unknown) =>
    o && typeof o === 'object' && !Array.isArray(o)
      ? Object.keys(o as Raw)
          .slice(0, 12)
          .join(', ')
      : typeof o;
  if (Array.isArray(raw)) return raw.length ? `list of ${raw.length}; first item: ${keys(raw[0])}` : 'empty list';
  if (raw && typeof raw === 'object') {
    const r = raw as Raw;
    const inner = Object.entries(r).find(([, v]) => Array.isArray(v) && v.length);
    return `object: ${keys(r)}${inner ? `; ${inner[0]}[0]: ${keys((inner[1] as unknown[])[0])}` : ''}`;
  }
  return raw === null || raw === undefined ? 'empty' : typeof raw;
}

/** True when the output holds something (so an empty parse means we didn't understand it). */
export function hasResults(raw: unknown): boolean {
  if (Array.isArray(raw)) return raw.length > 0;
  return !!raw && typeof raw === 'object' && Object.values(raw as Raw).some((v) => Array.isArray(v) && v.length > 0);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
/** Comparable form of a path: NFC, lower case (both sides of a comparison go through it). */
const fold = (s: string) => s.normalize('NFC').toLowerCase().replace(/i̇|ı/g, 'i'); // İ lower-cases to i + a combining dot, ı is Turkish i: both count as i
/** A name as a regular expression; the Turkish dotted/dotless i's match each other's cases. */
const nameRe = (s: string) => escapeRe(s).replace(/[iıIİ]/g, '[iıIİ]');

/**
 * Search text per distinct file name, for Buzz's full-text search (Postgres, `websearch_to_tsquery`): the name
 * without its extension, the name, and the path, joined with OR, so a mention is found however it was written
 * ("rollup", "rollup.py", "pipeline/steps/rollup.py:142"). mentionsFile() then keeps only real mentions.
 */
export function searchTexts(paths: string[]): string[] {
  const out = new Map<string, string>();
  for (const p of paths) {
    const rel = p.replace(/\\/g, '/').replace(/^\.\//, ''); // as written: the relay folds case itself
    const base = rel.split('/').pop() ?? '';
    const key = fold(base);
    if (!base || out.has(key)) continue;
    const stem = base.replace(/\.[^.]+$/, '');
    const terms = [...new Set([stem.length >= 4 ? stem : '', base, rel.includes('/') ? rel : ''].filter(Boolean))];
    out.set(key, terms.join(' OR '));
  }
  return [...out.values()];
}

/** Search text for a file: the name without its extension (full-text search splits on dots), or the full name when short. */
export function fileQuery(path: string): string {
  const base = norm(path).split('/').pop() ?? '';
  const stem = base.replace(/\.[^.]+$/, '');
  return stem.length >= 4 ? stem : base;
}

/**
 * Does the message mention this file? A bare name ("monthly_sales.sql") counts; a path must fit the
 * file's path ("sql/monthly_sales.sql" fits "reports/sql/monthly_sales.sql", "other/monthly_sales.sql" doesn't).
 * Returns the line numbers written next to it.
 */
export function mentionsFile(content: string, paths: string[]): { lines: number[] } | undefined {
  let hit = false;
  const lines: number[] = [];
  for (const path of paths) {
    const raw = path.replace(/\\/g, '/').replace(/^\.\//, '');
    const base = raw.split('/').pop();
    if (!base) continue;
    const rel = fold(raw);
    // the name as written (case-insensitive, Unicode-aware): lower-casing it first would break İ, which has no
    // one-code-point lower case
    const re = new RegExp(`(?<![\\p{L}\\p{N}_.\\-/])((?:[\\p{L}\\p{N}_.\\-]+/)*)(${nameRe(base)})(?::L?(\\d+)(?:-L?\\d+)?)?(?![\\p{L}\\p{N}_])`, 'giu');
    for (const m of content.matchAll(re)) {
      const p = fold(m[1] + m[2]);
      if (m[1] && !(rel === p || rel.endsWith('/' + p) || p.endsWith('/' + rel))) continue;
      hit = true;
      if (m[3]) lines.push(Number(m[3]));
    }
  }
  return hit ? { lines: [...new Set(lines)] } : undefined;
}

/** Code-like names in a message (snake_case, UPPER_SNAKE, camelCase): used to find the spot in the file. Mentions are skipped. */
export function codeIdentifiers(content: string): string[] {
  const text = content.replace(/@[\p{L}\p{N}_.-]+/gu, ' ').replace(/https?:\/\/\S+/g, ' ');
  const out = new Set<string>();
  for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g)) {
    const w = m[0];
    const snake = /[A-Za-z]_[A-Za-z0-9]/.test(w);
    const camel = /[a-z][A-Z]/.test(w);
    if (snake || camel) out.add(w);
  }
  return [...out];
}

/**
 * Where a thread belongs in the file (0-based line): the first occurrence of the most specific name the
 * messages use (fewest occurrences in the file), otherwise a line number from the messages.
 */
export interface WordIndex {
  lines: number;
  words: Map<string, { first: number; count: number }>; // word -> first line (0-based) and how many lines hold it
}

/** Every code word of a file with where it first appears; built once per file version. */
export function wordIndex(fileLines: string[]): WordIndex {
  const words = new Map<string, { first: number; count: number }>();
  fileLines.forEach((l, i) => {
    const seen = new Set<string>();
    for (const m of l.matchAll(/[A-Za-z0-9_]+/g)) {
      const w = m[0];
      if (seen.has(w)) continue;
      seen.add(w);
      const hit = words.get(w);
      if (hit) hit.count++;
      else words.set(w, { first: i, count: 1 });
    }
  });
  return { lines: fileLines.length, words };
}

export function anchorLine(fileLines: string[] | WordIndex, idents: string[], lineRefs: number[]): number | undefined {
  const index = Array.isArray(fileLines) ? wordIndex(fileLines) : fileLines;
  let best: { line: number; count: number } | undefined;
  for (const id of idents) {
    const hit = index.words.get(id);
    if (hit && (!best || hit.count < best.count)) best = { line: hit.first, count: hit.count };
  }
  if (best) return best.line;
  const n = lineRefs.find((x) => x >= 1 && x <= index.lines);
  return n ? n - 1 : undefined;
}

/** The file's own name and folders, which every message about it mentions: never an anchor. */
export function pathWords(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    for (const seg of p.replace(/\\/g, '/').split('/')) {
      if (!seg) continue;
      out.add(seg.toLowerCase());
      out.add(seg.replace(/\.[^.]*$/, '').toLowerCase());
    }
  }
  return out;
}

/** Messages that mention the file, grouped by thread, most recent first. */
export function groupLens(msgs: LensMessage[], paths: string[], jiraKeys: string[] = []): LensThread[] {
  const keys = jiraKeys.filter((k) => JIRA_PROJECT_KEY.test(k));
  const jiraRe = new RegExp(keys.length ? `\\b(?:${keys.join('|')})-\\d+\\b` : '\\b[A-Z][A-Z0-9]{1,9}-\\d+\\b');
  const byThread = new Map<string, LensThread>();
  const seen = new Set<string>();
  for (const m of [...msgs].sort((a, b) => a.created_at - b.created_at)) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const hit = mentionsFile(m.content, paths);
    if (!hit) continue;
    const key = `${m.channel}:${m.root}`;
    let th = byThread.get(key);
    if (!th) {
      const title = plainSnippet(m.content, 120)
        .replace(/^\[[A-Z][A-Z0-9]*-\d+\]\s*/, '')
        .replace(/^(@\S+\s+)+/, '');
      byThread.set(
        key,
        (th = { channel: m.channel, root: m.root, messages: [], last: 0, lines: [], title: title.length > 60 ? title.slice(0, 59) + '…' : title }),
      );
    }
    th.messages.push(m);
    th.last = Math.max(th.last, m.created_at);
    th.lines.push(...hit.lines);
    th.jira ??= jiraRe.exec(m.content)?.[0];
  }
  return [...byThread.values()].sort((a, b) => b.last - a.last);
}

/** "just now", "5 min ago", "yesterday", "3 days ago"… in the UI language. */
export function relTime(ts: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - ts);
  if (s < 60) return t('time.now');
  if (s < 3600) return t('time.min', Math.floor(s / 60));
  if (s < 86400) return t('time.hour', Math.floor(s / 3600));
  const d = Math.floor(s / 86400);
  if (d === 1) return t('time.yesterday');
  if (d < 45) return t('time.day', d);
  return t('time.month', Math.round(d / 30));
}
