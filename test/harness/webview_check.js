// The real chat webview (the body from src/chatHtml.ts, media/chat.css, media/chat.js) in headless Chrome, wide (the
// editor tab) and narrow (the side bar): reopening a thread keeps its scroll position and does not reload it,
// unread marks, a double Enter sends once, text typed while sending stays, a channel switch shows "Loading", and
// the git bar and proposal buttons.
const fs = require('fs');
const path = require('path');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');
const puppeteer = require('puppeteer-core');
const i18n = require(path.join(PROJ, 'out/i18n.js'));
i18n.setLang('en');
const S = i18n.webviewStrings();

const chatTs = fs.readFileSync(path.join(PROJ, 'src/chatHtml.ts'), 'utf8');
const tpl = /return `(<!DOCTYPE html>[\s\S]*?<\/html>)`;/.exec(chatTs)[1];
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
const file = path.join(require('os').tmpdir(), 'webview_check.html');
fs.writeFileSync(file, html);
const PAGE_URL = 'file:///' + file.split(path.sep).join('/');

const thread = (id, ts, txt) => ({
  id,
  pubkey: 'p',
  author: 'agent',
  initials: 'AG',
  isAgent: true,
  isMe: false,
  snippet: txt,
  replies: 1,
  people: [],
  time: '10:00',
  ts,
});
const item = (id, txt) => ({
  id,
  pubkey: 'p',
  author: 'agent',
  initials: 'AG',
  isMe: false,
  isAgent: true,
  isRoot: true,
  time: '10:00',
  ts: 1,
  html: `<p>${txt}</p>`,
  patches: [],
  depth: 0,
  snippet: txt,
});

(async () => {
  const browser = await puppeteer.launch(require('./browser').launchOptions());
  const pg = await browser.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, info) => {
    cond ? pass++ : fail++;
    console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info)));
  };
  const send = (m) => pg.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), m);
  const ev = (fn) => pg.evaluate(fn);

  for (const narrowW of [1200, 380]) {
    await pg.setViewport({ width: narrowW, height: 700 });
    await pg.goto('file:///' + file.replace(/\\/g, '/'));
    await send({ type: 'i18n', lang: 'en', strings: S });
    await send({
      type: 'channels',
      ready: true,
      items: [
        { id: 'A', name: 'a', isDm: false, color: 1 },
        { id: 'B', name: 'b', isDm: false, color: 2 },
      ],
    });
    await send({ type: 'channel', id: 'A', name: 'a', isDm: false, color: 1 });
    const many = Array.from({ length: 30 }, (_, i) => item('m' + i, 'message ' + i));
    await send({ type: 'threads', channelId: 'A', items: [thread('t1', 100, 'one'), thread('t2', 90, 'two')], initial: true });
    const tag = narrowW < 500 ? '[narrow] ' : '[wide] ';

    // open t1 with a long conversation, scroll up a bit
    await ev(() => document.querySelectorAll('.titem')[0].click());
    await send({ type: 'thread', id: 't1', title: 'one', items: many });
    await new Promise((r) => setTimeout(r, 50));
    await ev(() => (document.getElementById('log').scrollTop = 200));

    if (narrowW < 500) {
      // back to the list; a re-render of the open thread must not pull the view away from the list
      await ev(() => document.getElementById('backBtn').click());
      await send({ type: 'thread', id: 't1', title: 'one', items: many.concat([item('m30', 'late reply')]) });
      ok(tag + 're-render of the open thread keeps you on the list', await ev(() => !document.body.classList.contains('show-thread')));
      // opened from outside (Lens/notification): the view does switch
      await send({ type: 'thread', id: 't1', title: 'one', items: many, reveal: true });
      ok(tag + 'a thread opened from outside is shown', await ev(() => document.body.classList.contains('show-thread')));
      await ev(() => document.getElementById('backBtn').click());
    }

    // clicking the thread that is already on screen keeps the scroll position (no jump to the top)
    const posted0 = await ev(() => window.__posted.length);
    await ev(() => (document.getElementById('log').scrollTop = 200));
    await ev(() => document.querySelectorAll('.titem')[0].click());
    const top = await ev(() => document.getElementById('log').scrollTop);
    ok(tag + 'reopening the open thread keeps its scroll position', top === 200, { top });
    ok(tag + 'reopening the open thread does not reload it', (await ev(() => window.__posted.length)) === posted0);

    // "Load older" threads are not marked unread
    await send({ type: 'threads', channelId: 'A', items: [thread('t1', 100, 'one'), thread('t2', 90, 'two'), thread('t0', 10, 'old one')] });
    const unread = await ev(() => [...document.querySelectorAll('.titem.unread')].map((x) => x.textContent));
    ok(tag + 'older threads loaded later are not unread', unread.length === 0, unread);
    // a genuinely new message elsewhere is unread
    await send({ type: 'threads', channelId: 'A', items: [thread('t2', 200, 'two'), thread('t1', 100, 'one'), thread('t0', 10, 'old one')] });
    ok(tag + 'new activity is unread', (await ev(() => document.querySelectorAll('.titem.unread').length)) === 1);

    // send: locked at once (no double send); text typed while sending stays
    await ev(() => {
      const i = document.getElementById('input');
      i.value = 'hello';
      i.dispatchEvent(new Event('input'));
    });
    await ev(() => {
      window.__posted.length = 0;
      document.getElementById('sendBtn').click();
      document.getElementById('sendBtn').click();
      const i = document.getElementById('input');
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const sends = await ev(() => window.__posted.filter((m) => m.type === 'send').length);
    ok(tag + 'double click / Enter sends once', sends === 1, { sends });
    await ev(() => (document.getElementById('input').value = 'hello and more'));
    await send({ type: 'sent', text: 'hello' });
    await send({ type: 'sending', on: false });
    ok(tag + 'text typed while sending stays in the box', (await ev(() => document.getElementById('input').value)) === 'and more');

    // a channel switched from outside: the old list is not left clickable
    await send({ type: 'channel', id: 'B', name: 'b', isDm: false, color: 2 });
    ok(tag + 'channel switch replaces the old list with "Loading"', (await ev(() => document.querySelectorAll('.titem').length)) === 0);
  }
  // sending carries the thread on screen
  await pg.setViewport({ width: 1200, height: 700 });
  await pg.goto(PAGE_URL);
  await send({ type: 'i18n', lang: 'en', strings: S });
  await send({ type: 'channels', ready: true, items: [{ id: 'A', name: 'a', isDm: false, color: 1 }] });
  await send({ type: 'channel', id: 'A', name: 'a', isDm: false, color: 1 });
  await send({ type: 'threads', channelId: 'A', items: [thread('t1', 100, 'one')], initial: true });
  await send({
    type: 'thread',
    id: 't1',
    title: 'one',
    items: [Object.assign(item('pp', 'proposal'), { patches: [{ block: 0, files: ['sql/x.sql'], local: false }] })],
  });
  await ev(() => {
    const i = document.getElementById('input');
    i.value = 'ok';
    i.dispatchEvent(new Event('input'));
    window.__posted.length = 0;
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  const sent = await ev(() => window.__posted.find((m) => m.type === 'send'));
  ok('[send] the message carries the thread on screen', sent && sent.thread === 't1', sent);
  // a message that reports a branch/commit gets Show diff / Approve / Request changes
  const gitItem = Object.assign(item('gg', 'Dev fix commit 9c4e2b7 on feature/abc-1201-rank-ties'), {
    git: { branches: ['feature/abc-1201-rank-ties'], commits: ['9c4e2b7'] },
  });
  await send({ type: 'thread', id: 't1', title: 'one', items: [gitItem] });
  const bar = await ev(() => {
    const b = document.querySelector('.msg[data-id="gg"] .gitbar');
    return b && { text: b.querySelector('.p-file').textContent, btns: [...b.querySelectorAll('.pbtn')].map((x) => x.textContent + ':' + x.dataset.act) };
  });
  ok(
    '[git] the bar shows the branch and commit with only Show diff',
    bar && bar.text === 'feature/abc-1201-rank-ties · 9c4e2b7' && bar.btns.join() === 'Show diff:gitDiff',
    bar,
  );
  await ev(() => {
    window.__posted.length = 0;
    document.querySelector('.msg[data-id="gg"] .gitbar .pbtn').click();
  });
  ok('[git] Show diff posts the message id', await ev(() => window.__posted[0] && window.__posted[0].type === 'gitDiff' && window.__posted[0].id === 'gg'));
  // a proposal (diff in the message): only Show diff unless the local Apply is switched on
  await send({
    type: 'thread',
    id: 't1',
    title: 'one',
    items: [
      Object.assign(item('p2', 'x'), {
        html: '<div class="code" data-block="0"><pre>-a +b</pre></div>',
        patches: [{ block: 0, files: ['sql/x.sql'], local: false }],
      }),
    ],
  });
  ok(
    '[proposal] only Show diff',
    (await ev(() => [...document.querySelectorAll('.msg[data-id="p2"] .patch .pbtn')].map((x) => x.dataset.act).join())) === 'patchDiff',
  );
  await send({
    type: 'thread',
    id: 't1',
    title: 'one',
    items: [
      Object.assign(item('p3', 'x'), {
        html: '<div class="code" data-block="0"><pre>-a +b</pre></div>',
        patches: [{ block: 0, files: ['sql/x.sql'], local: true }],
      }),
    ],
  });
  ok(
    '[proposal] with the local mode on: Show diff and Apply',
    (await ev(() => [...document.querySelectorAll('.msg[data-id="p3"] .patch .pbtn')].map((x) => x.dataset.act).join())) === 'patchDiff,patchApply',
  );
  ok('no script errors', errors.length === 0, errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
