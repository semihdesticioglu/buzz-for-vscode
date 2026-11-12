// Speed and memory of the real chat webview: a 400-thread list, a 300-message thread, repeated re-renders.
const fs = require('fs');
const path = require('path');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');
const puppeteer = require('puppeteer-core');
const i18n = require(path.join(PROJ, 'out/i18n.js'));
i18n.setLang('en');
const S = i18n.webviewStrings();
const { renderMarkdown } = require(path.join(PROJ, 'out/markdown.js'));
const tpl = /return `(<!DOCTYPE html>[\s\S]*?<\/html>)`;/.exec(fs.readFileSync(path.join(PROJ, 'src/chatHtml.ts'), 'utf8'))[1];
const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const tx = (k) => `data-i18n="${k}">${esc(S[k] ?? k)}`;
const ti = (k) => `data-i18n-title="${k}" title="${esc(S[k] ?? k)}"`;
const page0 = new Function('s', 'esc', 'tx', 'ti', 'cur', 'n', 'css', 'js', 'img', 'w', 'return `' + tpl + '`;')(S, esc, tx, ti, 'en', 'x', '', '', '', {
  cspSource: '',
});
const body = /<body class="app">\n([\s\S]*?)<script nonce=/.exec(page0)[1];
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fs.readFileSync(path.join(PROJ, 'media/chat.css'), 'utf8')}</style>
<script>window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(m),getState:()=>({}),setState:()=>{}});</script>
</head><body class="app">${body}<script>${fs.readFileSync(path.join(PROJ, 'media/chat.js'), 'utf8')}</script></body></html>`;
const file = path.join(require('os').tmpdir(), 'webview_perf.html');
fs.writeFileSync(file, html);

const LONG =
  'Lorem ipsum **dolor** sit amet, `code_name_x` consectetur adipiscing elit. See `pipeline/steps/rollup.py:142` and ABC-4321.\n\n```python\ndef f(x):\n    return x * 2\n```\n' +
  'More text here. '.repeat(8);
const htmlOf = renderMarkdown(LONG, { jiraUrl: 'https://jira.example', jiraKeys: ['ABC'] });
const thread = (i) => ({
  id: 't' + i,
  pubkey: 'p' + (i % 9),
  author: 'agent_' + (i % 9),
  initials: 'A' + (i % 9),
  isAgent: true,
  isMe: false,
  snippet: 'Thread ' + i + ' ' + LONG.slice(0, 120),
  replies: 6,
  lastAuthor: 'agent_1',
  people: [1, 2, 3].map((k) => ({ pubkey: 'p' + k, initials: 'A' + k, isAgent: true, name: 'agent_' + k })),
  time: '10:00',
  ts: 1_000_000 - i,
});
const item = (i) => ({
  id: 'm' + i,
  pubkey: 'p' + (i % 9),
  author: 'agent_' + (i % 9),
  initials: 'A',
  isMe: i % 7 === 0,
  isAgent: true,
  isRoot: i === 0,
  time: '10:00',
  ts: 1_700_000_000 + i * 60,
  html: htmlOf,
  patches: [],
  depth: i % 5 === 0 ? 1 : 0,
  parentId: i % 5 === 0 ? 'm' + (i - 1) : undefined,
  parentAuthor: i % 5 === 0 ? 'agent_1' : undefined,
  snippet: 'x',
});

(async () => {
  const browser = await puppeteer.launch(require('./browser').launchOptions(['--js-flags=--expose-gc']));
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1200, height: 800 });
  await pg.goto('file:///' + file.split(path.sep).join('/'));
  const send = (m) => pg.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), m);
  const timed = async (label, m) => {
    const t = await pg.evaluate((m) => {
      const t0 = performance.now();
      window.dispatchEvent(new MessageEvent('message', { data: m }));
      return performance.now() - t0;
    }, m);
    console.log(`${label}: ${t.toFixed(1)} ms`);
    return t;
  };
  const heap = async () => {
    await pg.evaluate(() => window.gc && window.gc());
    return (await pg.metrics()).JSHeapUsedSize / 1024 / 1024;
  };
  await send({ type: 'i18n', lang: 'en', strings: S });
  await send({ type: 'channels', ready: true, items: [{ id: 'A', name: 'a', isDm: false, color: 1 }] });
  await send({ type: 'channel', id: 'A', name: 'a', isDm: false, color: 1 });
  const threads = Array.from({ length: 400 }, (_, i) => thread(i));
  const items = Array.from({ length: 300 }, (_, i) => item(i));
  const h0 = await heap();
  await timed('list of 400 threads, first render', { type: 'threads', channelId: 'A', items, initial: true });
  await timed('list of 400 threads, re-render (a live message)', { type: 'threads', channelId: 'A', items: threads });
  await timed('thread of 300 messages, render', { type: 'thread', id: 't0', title: 'x', items });
  await timed('thread of 300 messages, re-render (nested reply)', { type: 'thread', id: 't0', title: 'x', items });
  await timed('append 1 message', { type: 'threadAppend', id: 't0', items: [item(301)] });
  const nodes = await pg.evaluate(() => document.getElementsByTagName('*').length);
  console.log(`DOM nodes: ${nodes}`);
  const h1 = await heap();
  for (let i = 0; i < 40; i++) {
    await send({ type: 'threads', channelId: 'A', items: threads });
    await send({ type: 'thread', id: 't' + (i % 3), title: 'x', items });
  }
  const h2 = await heap();
  console.log(
    `heap: ${h0.toFixed(1)} MB empty -> ${h1.toFixed(1)} MB rendered -> ${h2.toFixed(1)} MB after 40 list + 40 thread re-renders (${h2 - h1 > 5 ? 'GROWS' : 'stable'})`,
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
