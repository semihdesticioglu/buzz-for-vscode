// Turns code blocks in agent messages into edits the user can preview (diff view) and apply.
// Pure logic (no vscode) so it is unit tested. Three shapes are understood:
//   unified  - a standard unified diff with @@ hunks (one or more files)
//   loose    - "- old" / "+ new" lines without @@ headers; the file comes from a file:line reference in the message
//   replace  - a plain code block that follows a "path:L10-L20" reference; the block replaces those lines
//              (only when the block's language fits the file, so quoted errors or commands are never proposals)
import { FileRef } from './core';

export interface Block {
  index: number;
  lang: string;
  content: string;
  ref?: FileRef;
}

export interface Hunk {
  oldStart: number; // 1-based, 0 when unknown
  oldLines: string[];
  newLines: string[];
}

export type Plan =
  | { kind: 'unified'; files: { path: string; isNew: boolean; hunks: Hunk[] }[] }
  | { kind: 'loose'; path: string; oldLines: string[]; newLines: string[]; near?: number }
  | { kind: 'replace'; path: string; start: number; end: number; newLines: string[] };

// applied: the file already holds the proposed lines; exists: a "new file" proposal for a file that is already there
export type ApplyResult = { ok: true; text: string } | { ok: false; reason: 'notFound' | 'ambiguous' | 'applied' | 'exists' };

const isDiffLang = (lang: string) => lang === 'diff' || lang === 'patch';

// Blocks in these languages are output or commands, never file contents to paste in.
const NOT_FILE_CONTENT = new Set(['', 'text', 'txt', 'plaintext', 'console', 'log', 'output', 'shell-session', 'terminal']);
// File extension -> fence languages that can hold that file's contents.
const EXT_LANGS: Record<string, string[]> = {
  py: ['python', 'py'],
  sql: ['sql', 'plsql', 'pgsql'],
  ts: ['typescript', 'ts'],
  tsx: ['typescript', 'ts', 'tsx'],
  js: ['javascript', 'js'],
  jsx: ['javascript', 'js', 'jsx'],
  json: ['json', 'jsonc'],
  yaml: ['yaml', 'yml'],
  yml: ['yaml', 'yml'],
  sh: ['bash', 'sh', 'shell', 'zsh'],
  ps1: ['powershell', 'ps1', 'pwsh'],
  java: ['java'],
  scala: ['scala'],
  md: ['markdown', 'md'],
  xml: ['xml', 'html'],
  html: ['xml', 'html'],
  ini: ['ini', 'toml', 'cfg'],
  toml: ['ini', 'toml'],
  cfg: ['ini', 'cfg'],
  go: ['go', 'golang'],
  rb: ['ruby', 'rb'],
  rs: ['rust', 'rs'],
  kt: ['kotlin', 'kt'],
  cs: ['csharp', 'cs', 'c#'],
  c: ['c', 'h'],
  h: ['c', 'h', 'cpp'],
  cpp: ['cpp', 'c++', 'cc'],
  css: ['css'],
  scss: ['scss', 'css'],
  r: ['r'],
  php: ['php'],
};
// Commands are never file contents (unless the file itself is a script in that language).
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat', 'batch']);

/** A plain code block can only replace file lines when its language fits the file. */
function langFitsFile(lang: string, path: string): boolean {
  const l = lang.toLowerCase();
  if (NOT_FILE_CONTENT.has(l)) return false;
  const ext = path.split('/').pop()?.split('.').slice(1).pop()?.toLowerCase() ?? '';
  const want = EXT_LANGS[ext];
  if (want) return want.includes(l);
  // an extension we don't know: only a block that names it exactly (```txt for .txt is excluded above)
  return !!ext && l === ext && !SHELL_LANGS.has(l);
}

/** "--- x" / "+++ y" on consecutive lines: a file header. Alone, such a line is a removed "-- x" or added "++ y" line. */
const isHeaderPair = (lines: string[], i: number): boolean =>
  (lines[i].startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) || (lines[i].startsWith('+++ ') && i > 0 && lines[i - 1].startsWith('--- '));
const stripPrefix = (p: string) => p.replace(/^[ab]\//, '');

/** Every file a plan touches. */
export function planFiles(plan: Plan): string[] {
  return plan.kind === 'unified' ? plan.files.map((f) => f.path) : [plan.path];
}

/** Parse a unified diff. A hunk before any file header belongs to an unnamed file (path ''). */
export function parseUnified(text: string): { path: string; isNew: boolean; hunks: Hunk[] }[] {
  const files: { path: string; isNew: boolean; hunks: Hunk[] }[] = [];
  let oldPath = '';
  let hunk: Hunk | undefined;
  const all = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < all.length; i++) {
    const raw = all[i];
    const header = !hunk || isHeaderPair(all, i);
    if (header && raw.startsWith('--- ')) {
      oldPath = raw.slice(4).trim().split('\t')[0];
      hunk = undefined;
      continue;
    }
    if (header && raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim().split('\t')[0];
      files.push({ path: stripPrefix(p === '/dev/null' ? oldPath : p), isNew: oldPath === '/dev/null', hunks: [] });
      hunk = undefined;
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
    if (h) {
      if (!files.length) files.push({ path: '', isNew: false, hunks: [] });
      hunk = { oldStart: Number(h[1]), oldLines: [], newLines: [] };
      files[files.length - 1].hunks.push(hunk);
      continue;
    }
    if (!hunk || raw.startsWith('\\') || raw.startsWith('diff --git') || raw.startsWith('index ')) continue;
    const c = raw[0];
    const body = raw.slice(1);
    if (c === '-') hunk.oldLines.push(body);
    else if (c === '+') hunk.newLines.push(body);
    else if (c === ' ' || raw === '') {
      hunk.oldLines.push(body);
      hunk.newLines.push(body);
    }
  }
  // the same file named twice: one entry with all its hunks
  const merged: { path: string; isNew: boolean; hunks: Hunk[] }[] = [];
  for (const f of files.filter((x) => x.hunks.length)) {
    const same = merged.find((m) => m.path === f.path);
    if (same) same.hunks.push(...f.hunks);
    else merged.push(f);
  }
  return merged;
}

/** Decide what (if anything) a code block proposes. */
export function planFor(b: Block): Plan | undefined {
  const content = b.content.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const looksDiff = isDiffLang(b.lang) || (/^[-+]/m.test(content) && /^(@@|--- |\+\+\+ )/m.test(content));
  if (looksDiff && /^@@ /m.test(content)) {
    const files = parseUnified(content).map((f) => (f.path ? f : { ...f, path: b.ref?.path ?? '' }));
    if (!files.length || files.some((f) => !f.path)) return undefined;
    return { kind: 'unified', files };
  }
  if (isDiffLang(b.lang)) {
    if (!b.ref) return undefined;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let changed = false;
    const all = content.split('\n');
    for (let i = 0; i < all.length; i++) {
      const line = all[i];
      const c = line[0];
      if (isHeaderPair(all, i)) continue; // a file header, not part of the change
      if (c === '-') {
        oldLines.push(line.slice(1));
        changed = true;
      } else if (c === '+') {
        newLines.push(line.slice(1));
        changed = true;
      } else {
        const ctx = c === ' ' ? line.slice(1) : line;
        oldLines.push(ctx);
        newLines.push(ctx);
      }
    }
    if (!changed || !oldLines.some((l) => l.trim())) return undefined;
    return { kind: 'loose', path: b.ref.path, oldLines, newLines, near: b.ref.line };
  }
  if (b.ref?.line && langFitsFile(b.lang, b.ref.path)) {
    const newLines = content.split('\n');
    const end = b.ref.end ?? (newLines.length === 1 ? b.ref.line : undefined);
    if (end === undefined || end < b.ref.line) return undefined;
    return { kind: 'replace', path: b.ref.path, start: b.ref.line, end, newLines };
  }
  return undefined;
}

function split(text: string): { lines: string[]; eol: string } {
  return { lines: text.split(/\r?\n/), eol: /\r\n/.test(text) ? '\r\n' : '\n' };
}

const lead = (s: string) => /^\s*/.exec(s)![0];

/** All positions where `needle` occurs in `lines` (exact, or ignoring surrounding whitespace). */
function findAll(lines: string[], needle: string[], loose: boolean): number[] {
  const eq = loose ? (a: string, b: string) => a.trim() === b.trim() : (a: string, b: string) => a === b;
  const out: number[] = [];
  outer: for (let i = 0; i + needle.length <= lines.length; i++) {
    for (let j = 0; j < needle.length; j++) if (!eq(lines[i + j], needle[j])) continue outer;
    out.push(i);
  }
  return out;
}

const width = (s: string) => [...s].reduce((a, c) => a + (c === '\t' ? 4 : 1), 0);

/**
 * Re-indent replacement lines when the match ignored whitespace (e.g. "- " style diffs): every line moves by
 * the same amount as the first matched line, so a line indented less than it stays less indented.
 */
function reindent(newLines: string[], oldFirst: string, fileFirst: string): string[] {
  const from = lead(oldFirst);
  const to = lead(fileFirst);
  if (from === to) return newLines;
  const shift = width(to) - width(from);
  const tabs = to.includes('\t');
  return newLines.map((l) => {
    if (l.trim() === '') return '';
    if (l.startsWith(from)) return to + l.slice(from.length);
    const w = Math.max(0, width(lead(l)) + shift);
    return (tabs && w % 4 === 0 ? '\t'.repeat(w / 4) : ' '.repeat(w)) + l.trimStart();
  });
}

/** Replace one occurrence of oldLines with newLines; picks the occurrence nearest `near` (0-based). */
function replaceBlock(
  lines: string[],
  oldLines: string[],
  newLines: string[],
  near: number | undefined,
  mustBeUnique: boolean,
): string[] | 'notFound' | 'ambiguous' | 'applied' {
  // trailing blank lines in a proposal should not prevent a match; the same blank lines go from the new side
  const old = [...oldLines];
  const neu = [...newLines];
  while (old.length > 1 && old[old.length - 1].trim() === '') {
    old.pop();
    if (neu.length > 1 && neu[neu.length - 1].trim() === '') neu.pop();
  }
  const same = old.length === neu.length && old.every((l, i) => l === neu[i]);
  for (const loose of [false, true]) {
    const hits = findAll(lines, old, loose);
    if (!hits.length) continue;
    let at = hits[0];
    if (hits.length > 1) {
      if (near === undefined) {
        if (mustBeUnique) return 'ambiguous';
      } else {
        at = hits.reduce((a, b) => (Math.abs(b - near) < Math.abs(a - near) ? b : a));
      }
    }
    // the new lines are already where they would go (e.g. a line added after context, applied before)
    if (!same && findAll(lines.slice(at, at + neu.length), neu, loose).includes(0)) return 'applied';
    const repl = loose ? reindent(neu, old[0], lines[at]) : neu;
    return [...lines.slice(0, at), ...repl, ...lines.slice(at + old.length)];
  }
  // the old lines are gone but the new ones are there: applied before
  if (!same && neu.some((l) => l.trim()) && (findAll(lines, neu, false).length || findAll(lines, neu, true).length)) return 'applied';
  return 'notFound';
}

/** Apply a plan to the current text of one file. */
export function applyPlan(plan: Plan, path: string, text: string): ApplyResult {
  const { lines, eol } = split(text);
  let out: string[] | 'notFound' | 'ambiguous' | 'applied' = lines;
  if (plan.kind === 'replace') {
    if (plan.start < 1 || plan.end > lines.length) return { ok: false, reason: 'notFound' };
    out = [...lines.slice(0, plan.start - 1), ...plan.newLines, ...lines.slice(plan.end)];
  } else if (plan.kind === 'loose') {
    out = replaceBlock(lines, plan.oldLines, plan.newLines, plan.near ? plan.near - 1 : undefined, true);
  } else {
    const file = plan.files.find((f) => f.path === path);
    if (!file) return { ok: false, reason: 'notFound' };
    if (file.isNew) {
      const created = file.hunks.flatMap((h) => h.newLines);
      if (text.trim() === '') out = created;
      else if (text.replace(/\r\n/g, '\n').replace(/\n$/, '') === created.join('\n').replace(/\n$/, '')) return { ok: false, reason: 'applied' };
      else return { ok: false, reason: 'exists' };
    } else {
      let offset = 0;
      let done = 0;
      for (const h of file.hunks) {
        if (!h.oldLines.length) {
          // pure insertion
          const at = Math.min(Math.max(h.oldStart + offset, 0), (out as string[]).length);
          out = [...(out as string[]).slice(0, at), ...h.newLines, ...(out as string[]).slice(at)];
        } else {
          const r = replaceBlock(out as string[], h.oldLines, h.newLines, h.oldStart ? h.oldStart - 1 + offset : undefined, false);
          if (r === 'applied') done++;
          else if (typeof r === 'string') return { ok: false, reason: r };
          else out = r;
        }
        offset += h.newLines.length - h.oldLines.length;
      }
      if (done && done === file.hunks.length) return { ok: false, reason: 'applied' };
    }
  }
  if (typeof out === 'string') return { ok: false, reason: out };
  return { ok: true, text: out.join(eol) };
}
