// The Jira card in the real chat webview: a status that changed (ETL -> Done) shows up after a minute.
const fs = require('fs');
const path = require('path');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');
const puppeteer = require('puppeteer-core');
const i18n = require(path.join(PROJ, 'out/i18n.js'));
i18n.setLang('tr');
const S = i18n.webviewStrings();
const chatTs = fs.readFileSync(path.join(PROJ, 'src/chatHtml.ts'), 'utf8');
const tpl = /return `(<!DOCTYPE html>[\s\S]*?<\/html>)`;/.exec(chatTs)[1];
const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const tx = (k) => `data-i18n="${k}">${esc(S[k] ?? k)}`;
const ti = (k) => `data-i18n-title="${k}" title="${esc(S[k] ?? k)}"`;
const page0 = new Function('s', 'esc', 'tx', 'ti', 'cur', 'n', 'css', 'js', 'img', 'w', 'return `' + tpl + '`;')(S, esc, tx, ti, 'tr', 'x', '', '', '', {
  cspSource: '',
});
const body = /<body class="app">\n([\s\S]*?)<script nonce=/.exec(page0)[1];
// Date.now can be moved forward from the test (a minute passing)
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fs.readFileSync(path.join(PROJ, 'media/chat.css'), 'utf8')}</style>
<script>window.__posted=[];window.__skew=0;const __now=Date.now.bind(Date);Date.now=()=>__now()+window.__skew;window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(m),getState:()=>({}),setState:()=>{}});</script>
</head><body class="app">${body}<script>${fs.readFileSync(path.join(PROJ, 'media/chat.js'), 'utf8')}</script></body></html>`;
const file = path.join(require('os').tmpdir(), 'jira_card_check.html');
fs.writeFileSync(file, html);

(async () => {
  const browser = await puppeteer.launch(require('./browser').launchOptions());
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1200, height: 700 });
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.goto('file:///' + file.split(path.sep).join('/'));
  const send = (m) => pg.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), m);
  const ev = (fn, arg) => pg.evaluate(fn, arg);
  let pass = 0;
  let fail = 0;
  const ok = (n, c, info) => {
    c ? pass++ : fail++;
    console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(info)));
  };
  await send({ type: 'i18n', lang: 'tr', strings: S });
  await send({ type: 'channels', ready: true, items: [{ id: 'A', name: 'a', isDm: false, color: 1 }] });
  await send({ type: 'channel', id: 'A', name: 'a', isDm: false, color: 1 });
  const th = { id: 't1', pubkey: 'p', author: 'lead', initials: 'L', isAgent: true, isMe: false, snippet: 'x', replies: 0, people: [], time: '10:00', ts: 1 };
  await send({ type: 'threads', channelId: 'A', items: [th], initial: true });
  const msg = {
    id: 'm1',
    pubkey: 'p',
    author: 'lead',
    initials: 'L',
    isMe: false,
    isAgent: true,
    isRoot: true,
    time: '10:00',
    ts: 1,
    html: '<p><a class="jira" href="https://jira.example/browse/ABC-321" data-key="ABC-321">ABC-321</a> açıldı</p>',
    patches: [],
    depth: 0,
    snippet: 'x',
  };
  await send({ type: 'thread', id: 't1', title: 'x', items: [msg] });
  const issue = (status) => ({
    key: 'ABC-321',
    url: 'https://jira.example/browse/ABC-321',
    summary: 'Dışa aktarma tekrar denemesi',
    status,
    statusCategory: status === 'Done' ? 'done' : 'indeterminate',
    type: 'Task',
    assignee: 'Data team',
  });
  const hover = async () => {
    await ev(() => {
      window.__posted.length = 0;
      document.querySelector('a.jira').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 450));
  };
  const asked = () => ev(() => window.__posted.filter((m) => m.type === 'jiraInfo').length);
  const cardText = () =>
    ev(() => (document.getElementById('jcard') ? document.getElementById('jcard').textContent : document.querySelector('.jcard')?.textContent || ''));

  await hover();
  ok('first hover asks Jira', (await asked()) === 1);
  await send({ type: 'jiraInfo', key: 'ABC-321', data: issue('ETL') });
  ok('card shows ETL', /ETL/.test(await cardText()), await cardText());
  await ev(() => document.querySelector('a.jira').dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
  await new Promise((r) => setTimeout(r, 400));

  await hover();
  ok('within a minute: shown from memory, not asked again', (await asked()) === 0);
  await ev(() => document.querySelector('a.jira').dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
  await new Promise((r) => setTimeout(r, 400));

  await ev(() => (window.__skew = 61000)); // a minute later; meanwhile the issue was closed
  await hover();
  ok('after a minute: asked again', (await asked()) === 1);
  ok('meanwhile the known status is shown at once', /ETL/.test(await cardText()));
  await send({ type: 'jiraInfo', key: 'ABC-321', data: issue('Done') });
  const t = await cardText();
  ok('the open card updates to the new status', /Done/i.test(t) && !/ETL/.test(t), t);
  ok('no script errors', errors.length === 0, errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
