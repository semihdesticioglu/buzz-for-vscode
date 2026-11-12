// The production CSP, enforced: the webview document is served over http with the CSP from src/chatHtml.ts
// (cspSource = 'self'), the chat is exercised, and every policy violation is a failure.
const fs = require('fs');
const http = require('http');
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
const img = "'self' data:";
const page = new Function('s', 'esc', 'tx', 'ti', 'cur', 'n', 'css', 'js', 'img', 'w', 'return `' + tpl + '`;')(
  S,
  esc,
  tx,
  ti,
  'en',
  'nonce123',
  '/chat.css',
  '/chat.js',
  img,
  { cspSource: "'self'" },
);
const csp = /Content-Security-Policy" content="([^"]+)"/.exec(page)[1];
// the host's acquireVsCodeApi, as a nonce-locked script like the real one
const shim = 'window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(m),getState:()=>({}),setState:()=>{}});';
const served = page.replace(
  '<script nonce="nonce123" src="/chat.js">',
  '<script nonce="nonce123" src="/shim.js"></script><script nonce="nonce123" src="/chat.js">',
);
if (served === page) throw new Error('script tag not found in the template');
const files = {
  '/': { body: served, type: 'text/html; charset=utf-8' },
  '/shim.js': { body: shim, type: 'text/javascript' },
  '/chat.css': { body: fs.readFileSync(path.join(PROJ, 'media/chat.css')), type: 'text/css' },
  '/chat.js': { body: fs.readFileSync(path.join(PROJ, 'media/chat.js')), type: 'text/javascript' },
};
const server = http.createServer((req, res) => {
  const f = files[req.url.split('?')[0]];
  if (!f) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': f.type });
  res.end(f.body);
});

const md = (t) => renderMarkdown(t, { jiraUrl: 'https://jira.example.com', jiraKeys: ['ABC'] });
const item = (i) => ({
  id: 'm' + i,
  pubkey: 'p' + (i % 3),
  author: 'agent_' + (i % 3),
  initials: 'A',
  isMe: i % 4 === 0,
  isAgent: true,
  isRoot: i === 0,
  time: '10:00',
  ts: 1_700_000_000 + i * 60,
  html: md('Hello **' + i + '** `etl/x.py:12` ABC-' + (100 + i) + '\n\n```python\nprint(' + i + ')\n```'),
  patches: i === 2 ? [{ block: 0, files: ['etl/x.py'], local: false }] : [],
  git: i === 3 ? { branches: ['feature/x'], commits: [] } : undefined,
  depth: i % 5 === 0 && i ? 1 : 0,
  parentId: i % 5 === 0 && i ? 'm' + (i - 1) : undefined,
  parentAuthor: 'agent_1',
  snippet: 'x',
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await puppeteer.launch(require('./browser').launchOptions());
  const pg = await browser.newPage();
  const violations = [];
  const errors = [];
  pg.on('console', (m) => {
    if (/Content Security Policy|Refused to/.test(m.text())) violations.push(m.text());
  });
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || ''}`));
  });
  await pg.setViewport({ width: 1100, height: 720 });
  await pg.goto(url);
  const send = (m) => pg.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), m);
  await send({ type: 'i18n', lang: 'en', strings: S });
  await send({ type: 'live', state: 'live' });
  await send({
    type: 'channels',
    ready: true,
    items: [
      { id: 'A', name: 'a', isDm: false, color: 1 },
      { id: 'B', name: 'b', isDm: true, color: 2, peer: 'p1' },
    ],
  });
  await send({ type: 'channel', id: 'A', name: 'a', isDm: false, color: 1 });
  await send({ type: 'presence', map: { p1: 'online', p2: 'away' } });
  await send({
    type: 'threads',
    channelId: 'A',
    items: [
      {
        id: 't1',
        pubkey: 'p1',
        author: 'agent_1',
        initials: 'A1',
        isAgent: true,
        isMe: false,
        snippet: 'one',
        replies: 3,
        people: [{ pubkey: 'p1', initials: 'A1', isAgent: true, name: 'agent_1' }],
        time: '10:00',
        ts: 100,
      },
    ],
    initial: true,
  });
  await send({ type: 'thread', id: 't1', title: 'one', items: Array.from({ length: 12 }, (_, i) => item(i)) });
  await send({ type: 'working', items: [{ name: 'agent_1', isAgent: true, real: true }], busy: ['t1'], channel: [] });
  await send({ type: 'contexts', items: [{ label: 'rollup.py:1-3', kind: 'code', title: 'pipeline/rollup.py' }] });
  await send({ type: 'jiraInfo', key: 'ABC-100', data: { key: 'ABC-100', summary: 'x', status: 'Open', assignee: 'a', estimateText: '2h', spentText: '1h' } });
  // things the script styles from JS: the note tilt, the composer height, the Jira card position
  const checks = await pg.evaluate(async () => {
    const out = {};
    const note = document.querySelector('#channelChips button');
    out.tilt = note ? getComputedStyle(note).getPropertyValue('--tilt').trim() : 'no note';
    const input = document.getElementById('input');
    input.value = 'line1\nline2\nline3\nline4';
    input.dispatchEvent(new Event('input'));
    out.inputGrew = input.style.height !== '' && parseInt(input.style.height, 10) > 30;
    const key = document.querySelector('.jira, [data-jira], a[href*="ABC-"]');
    if (key) {
      key.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      key.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
    }
    out.hasKey = !!key;
    out.cssLoaded = getComputedStyle(document.body).display === 'flex';
    return out;
  });
  const cspEvents = await pg.evaluate(() => window.__csp);
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, info) => {
    cond ? pass++ : fail++;
    console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info)));
  };
  console.log('CSP: ' + csp);
  ok('the stylesheet loads under the policy', checks.cssLoaded, checks);
  ok('styles set from the script still apply (note tilt, composer height)', /deg$/.test(checks.tilt) && checks.inputGrew, checks);
  ok('no policy violation reported by the browser', !violations.length && !cspEvents.length, { violations, cspEvents });
  ok('no script errors', !errors.length, errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
