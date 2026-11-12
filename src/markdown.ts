// Message content -> safe HTML. html:false escapes raw HTML; markdown-it refuses javascript: links.
// Adds: syntax highlighting (highlight.js), clickable file:line references, Jira issue links,
// @mention highlighting and numbered code blocks (so the webview can attach "Show diff / Apply").
// Visible labels (Copy, tooltips) are filled in by the webview in the user's language.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import scala from 'highlight.js/lib/languages/scala';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import MarkdownIt from 'markdown-it';
import { FILE_IN_TEXT, FileRef, JIRA_PROJECT_KEY, parseFileRef } from './core';
import { Block } from './patch';

for (const [name, lang] of Object.entries({
  bash,
  diff,
  ini,
  java,
  javascript,
  json,
  markdown,
  plaintext,
  powershell,
  python,
  scala,
  sql,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, lang);
}

/** highlight.js language for a fence info string; an untagged block that looks like a diff is a diff. */
export function codeLang(info: string, code: string): string | undefined {
  const l = info
    .trim()
    .split(/[\s:]+/)[0]
    ?.toLowerCase();
  if (l && hljs.getLanguage(l)) return l;
  if (!l && /^(@@|[-+] |--- |\+\+\+ )/m.test(code) && /^[-+]/m.test(code)) return 'diff';
  return undefined;
}

/** A file reference written in the fence info, e.g. ```python:etl/x.py or ```diff etl/x.py:10 */
function infoRef(info: string): FileRef | undefined {
  const rest = info.trim().replace(/^[\w+#-]+[\s:]+/, '');
  return rest && rest !== info.trim() ? parseFileRef(rest.split(/\s+/)[0]) : undefined;
}

export interface RenderEnv {
  jiraUrl?: string;
  jiraKeys?: string[];
  imageHost?: string; // images load inline only from this host (the relay); others are shown as links
  inLink?: number;
  block?: number;
}

const esc = (s: string) => md.utils.escapeHtml(s);

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight: (code, info) => {
    const lang = codeLang(info, code);
    if (!lang) return '';
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return '';
    }
  },
});

// ".py", ".sh" are country TLDs; without this "rollup.py:142" would become a web link. Only http(s):// and www.
md.linkify.set({ fuzzyLink: false });

/**
 * How deep blocks nest: a quote is one level, a list two. markdown-it skips whatever lies deeper without a trace, so a
 * sender could hide text from VS Code that other clients show. Here what lies deeper is kept, as plain text at the
 * deepest level drawn. 20 is markdown-it's CommonMark preset: plenty for real messages, narrow enough for a side bar.
 */
const MAX_NESTING = 20;
Object.assign(md.options, { maxNesting: MAX_NESTING }); // not in the typings, read by both of markdown-it's parsers
const tokenizeBlocks = md.block.tokenize.bind(md.block);
md.block.tokenize = (state, startLine, endLine) => {
  if (state.level < MAX_NESTING) return tokenizeBlocks(state, startLine, endLine);
  // each run of lines becomes a paragraph of plain text, ended as markdown-it ends a paragraph: at an empty line, or at
  // a less indented line that starts a block (a sibling list item, a fence, a heading), which belongs to an outer block;
  // a less indented plain line is a lazy continuation. A line less indented than this block, after an empty one, ends it.
  const terminators = md.block.ruler.getRules('paragraph');
  const parent = state.parentType;
  let line = startLine;
  let runs = 0;
  while (line < endLine) {
    line = state.skipEmptyLines(line);
    if (line >= endLine || state.sCount[line] < state.blkIndent) break;
    let next = line + 1;
    state.parentType = 'paragraph'; // as markdown-it's paragraph rule asks its terminators
    while (next < endLine && !state.isEmpty(next)) {
      const outdented = state.sCount[next] >= 0 && state.sCount[next] < state.blkIndent;
      if (outdented && terminators.some((rule) => rule(state, next, endLine, true))) break;
      next++;
    }
    state.parentType = parent;
    if (runs++) state.tight = false; // a second paragraph (after an empty line): the item is loose, as markdown-it marks it
    state.push('paragraph_open', 'p', 1).map = [line, next];
    const inline = state.push('inline', '', 0);
    inline.content = state.getLines(line, next, state.blkIndent, false).trim();
    inline.map = [line, next];
    inline.children = [];
    state.push('paragraph_close', 'p', -1);
    line = next;
  }
  state.line = line;
};

// code block: highlighted content + language label + copy button, numbered in document order
const fence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env: RenderEnv, self) => {
  const t = tokens[idx];
  const n = (env.block = (env.block ?? -1) + 1);
  const lang = codeLang(t.info, t.content);
  const label = lang && lang !== 'plaintext' ? `<span class="lang" lang="en">${esc(lang)}</span>` : '';
  return `<div class="code" data-block="${n}"${lang ? ` data-lang="${esc(lang)}"` : ''}>${fence(tokens, idx, options, env, self)}${label}<button class="copy" type="button"></button></div>`;
};

function fileLink(text: string): string | undefined {
  const r = parseFileRef(text);
  if (!r) return undefined;
  const attrs = `data-path="${esc(r.path)}"${r.line ? ` data-line="${r.line}"` : ''}${r.end ? ` data-end="${r.end}"` : ''}`;
  return `<a class="ref" href="#" ${attrs}>${esc(text)}</a>`;
}

const projectKeys = (env: RenderEnv) => (env.jiraKeys ?? []).filter((k) => JIRA_PROJECT_KEY.test(k));

function jiraLink(key: string, env: RenderEnv): string {
  const href = env.jiraUrl ? `${env.jiraUrl}/browse/${key}` : '#';
  return `<a class="jira" href="${esc(href)}" data-key="${esc(key)}">${esc(key)}</a>`;
}

// inline code: a file reference or a Jira key becomes a link, anything else stays code
const codeInline = md.renderer.rules.code_inline!;
md.renderer.rules.code_inline = (tokens, idx, options, env: RenderEnv, self) => {
  const c = tokens[idx].content;
  if (!env.inLink) {
    const f = fileLink(c);
    if (f) return f;
    const keys = projectKeys(env);
    if (keys.length && new RegExp(`^(?:${keys.join('|')})-\\d+$`).test(c.trim())) return jiraLink(c.trim(), env);
  }
  return codeInline(tokens, idx, options, env, self);
};

// text inside a link is not linked again
// Images: inline only from the relay host or as data URIs; anything else becomes a link, so a message
// can't load a tracking pixel from an arbitrary server when it is shown.
const image = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, env: RenderEnv, self) => {
  const tok = tokens[idx];
  const src = tok.attrGet('src') ?? '';
  let host = '';
  try {
    host = new URL(src).host;
  } catch {
    /* relative or invalid */
  }
  if (/^data:image\//i.test(src) || (host && env?.imageHost && host === env.imageHost)) return image(tokens, idx, options, env, self);
  const alt = tok.children?.length ? self.renderInlineAsText(tok.children, options, env) : tok.content;
  if (!/^https?:\/\//i.test(src)) return esc(alt);
  return `<a href="${esc(src)}">🖼 ${esc(alt || src)}</a>`;
};

const linkOpen = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
const linkClose = md.renderer.rules.link_close ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = (t, i, o, env: RenderEnv, s) => {
  env.inLink = (env.inLink ?? 0) + 1;
  return linkOpen(t, i, o, env, s);
};
md.renderer.rules.link_close = (t, i, o, env: RenderEnv, s) => {
  env.inLink = Math.max(0, (env.inLink ?? 1) - 1);
  return linkClose(t, i, o, env, s);
};

function textPattern(env: RenderEnv): RegExp {
  const keys = projectKeys(env);
  const parts = [
    String.raw`(?<mention>(?<=^|[\s(\[])@[\p{L}\p{N}_.\-]+)`,
    keys.length ? String.raw`(?<jira>\b(?:${keys.join('|')})-\d+\b)` : '',
    String.raw`(?<file>(?<![\w/@.\-])(?:${FILE_IN_TEXT})(?![\w/]))`,
  ].filter(Boolean);
  return new RegExp(parts.join('|'), 'gu');
}

// plain text: @name, Jira keys and file:line (code is not a 'text' token, so it is untouched)
md.renderer.rules.text = (tokens, idx, _o, env: RenderEnv) => {
  const text = tokens[idx].content;
  if (env.inLink) return esc(text);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(textPattern(env))) {
    const g = m.groups ?? {};
    let html: string | undefined;
    if (g.mention) html = `<span class="mention">${esc(g.mention)}</span>`;
    else if (g.jira) html = jiraLink(g.jira, env);
    else if (g.file) html = fileLink(g.file);
    if (!html) continue;
    out += esc(text.slice(last, m.index)) + html;
    last = (m.index ?? 0) + m[0].length;
  }
  return out + esc(text.slice(last));
};

export function renderMarkdown(src: string, env: RenderEnv = {}): string {
  return md.render(src, { ...env, inLink: 0, block: -1 });
}

/**
 * Code blocks of a message in document order (same numbering as data-block), each with the
 * nearest file reference written before it (or in its fence info).
 */
export function extractBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let ref: FileRef | undefined;
  const seeText = (text: string) => {
    for (const m of text.matchAll(new RegExp(`(?<![\\w/@.\\-])(?:${FILE_IN_TEXT})(?![\\w/])`, 'g'))) {
      const r = parseFileRef(m[0]);
      if (r) ref = r;
    }
  };
  for (const tok of md.parse(src, {})) {
    if (tok.type === 'inline') {
      for (const c of tok.children ?? []) {
        if (c.type === 'code_inline') {
          const r = parseFileRef(c.content);
          if (r) ref = r;
        } else if (c.type === 'text') {
          seeText(c.content);
        }
      }
    } else if (tok.type === 'fence') {
      blocks.push({
        index: blocks.length,
        lang: codeLang(tok.info, tok.content) ?? (tok.info.trim().split(/[\s:]+/)[0] ?? '').toLowerCase(),
        content: tok.content,
        ref: infoRef(tok.info) ?? ref,
      });
      ref = undefined; // a reference belongs to the block right after it, not to every later one
    }
  }
  return blocks;
}
