// Search box and thread filter in the real webview: Enter searches, results replace the list and stay until cleared,
// the scope toggle re-runs, a result opens through the extension, Escape returns to the list; the filter hides
// non-matching messages instantly with a count.
const fs = require('fs');
const path = require('path');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');
const puppeteer = require('puppeteer-core');
const i18n = require(path.join(PROJ, 'out/i18n.js'));
i18n.setLang('en');
const S = i18n.webviewStrings();

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
const file = path.join(require('os').tmpdir(), 'search_webview_check.html');
fs.writeFileSync(file, html);

const thread = (i) => ({
  id: 't' + i,
  pubkey: 'p1',
  author: 'agent',
  initials: 'AG',
  isAgent: true,
  isMe: false,
  snippet: 'thread ' + i,
  replies: 0,
  people: [],
  time: '10:00',
  ts: 100 - i,
});
const row = (i, ch) => ({
  id: 'r' + i,
  channelId: ch,
  channelName: '#' + ch,
  matchId: 'm' + i,
  matches: i,
  pubkey: 'p1',
  author: 'agent',
  initials: 'AG',
  isAgent: true,
  isMe: false,
  snippet: 'match ' + i,
  time: '10:00',
  ts: 50 - i,
});
const item = (i, text) => ({
  id: 'm' + i,
  pubkey: 'p1',
  author: 'agent',
  initials: 'AG',
  isMe: false,
  isAgent: true,
  isRoot: i === 0,
  time: '10:00',
  ts: 1_700_000_000 + i * 60,
  html: `<p>${text}</p>`,
  patches: [],
  depth: 0,
  snippet: text,
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
  const ev = (fn, ...a) => pg.evaluate(fn, ...a);
  const posted = () => ev(() => window.__posted.splice(0));
  await pg.setViewport({ width: 1100, height: 720 });
  await pg.goto('file:///' + file.split(path.sep).join('/'));
  await send({ type: 'i18n', lang: 'en', strings: S });
  await send({
    type: 'channels',
    ready: true,
    items: [
      { id: 'A', name: 'general', isDm: false, color: 1 },
      { id: 'B', name: 'ops', isDm: false, color: 2 },
    ],
  });
  await send({ type: 'channel', id: 'A', name: 'general', isDm: false, color: 1 });
  await send({ type: 'threads', channelId: 'A', items: [thread(1), thread(2), thread(3)], initial: true });

  await pg.type('#searchBox', 'rollup');
  await pg.keyboard.press('Enter');
  let p = await posted();
  ok(
    'Enter asks the extension to search this channel',
    p.some((m) => m.type === 'search' && m.query === 'rollup' && m.scope === 'channel'),
    p,
  );
  ok(
    'the list shows "searching" (with a Clear link, so a lost answer cannot trap it)',
    await ev((t) => document.getElementById('searchHead').textContent.startsWith(t), S.searching),
  );

  await send({ type: 'searchResults', query: 'rollup', scope: 'channel', items: [row(1, 'A'), row(2, 'A')], capped: false });
  let st = await ev(() => ({
    rows: document.querySelectorAll('#threadList .titem.result').length,
    head: document.getElementById('searchHead').textContent,
    plain: document.querySelectorAll('#threadList .titem:not(.result)').length,
  }));
  ok(
    'results replace the thread list, with a header and a Clear link',
    st.rows === 2 && st.plain === 0 && st.head.includes('2 threads') && st.head.includes(S.clear),
    st,
  );
  await send({ type: 'threads', channelId: 'A', items: [thread(1), thread(2), thread(3), thread(4)] });
  ok('a live list update does not replace the results', (await ev(() => document.querySelectorAll('#threadList .titem.result').length)) === 2);

  await ev(() => document.getElementById('searchScope').click());
  p = await posted();
  ok(
    'the scope toggle re-runs the search over all channels',
    p.some((m) => m.type === 'search' && m.scope === 'all') && (await ev(() => document.getElementById('searchScope').textContent)) === '∗',
    p,
  );
  await send({ type: 'searchResults', query: 'rollup', scope: 'all', items: [row(1, 'A'), row(3, 'B')], capped: true, cap: 300 });
  st = await ev(() => ({
    badges: [...document.querySelectorAll('#threadList .s-ch')].map((e) => e.textContent),
    head: document.getElementById('searchHead').textContent,
  }));
  ok(
    'all channels: rows carry their channel and the header says the result is capped',
    st.badges.includes('#B') && st.badges.includes('#A') && /first 300 matches/.test(st.head),
    st,
  );

  await ev(() => document.querySelectorAll('#threadList .titem.result')[1].click());
  p = await posted();
  ok(
    'clicking a result asks the extension to open it in its channel',
    p.some((m) => m.type === 'openResult' && m.channel === 'B' && m.id === 'r3'),
    p,
  );

  await pg.focus('#searchBox');
  await pg.keyboard.press('Escape');
  st = await ev(() => ({
    rows: document.querySelectorAll('#threadList .titem:not(.result)').length,
    hidden: document.getElementById('searchHead').hidden,
    box: document.getElementById('searchBox').value,
  }));
  ok('Escape clears the search and brings the thread list back', st.rows === 4 && st.hidden && st.box === '', st);

  // the in-thread filter
  await ev(() => document.querySelectorAll('.titem')[0].click());
  await send({ type: 'thread', id: 't1', title: 'thread 1', items: [item(0, 'alpha start'), item(1, 'beta'), item(2, 'gamma alpha'), item(3, 'delta')] });
  await ev(() => document.getElementById('filterBtn').click());
  ok('the filter row opens from the header button', !(await ev(() => document.getElementById('filterRow').hidden)));
  await pg.type('#filterBox', 'ALPHA');
  st = await ev(() => ({
    shown: [...document.querySelectorAll('.msg')].filter((m) => !m.classList.contains('filtered-out')).length,
    count: document.getElementById('filterCount').textContent,
  }));
  ok('typing filters the messages instantly (case-insensitive) with a count', st.shown === 2 && st.count === '2 of 4', st);
  await send({ type: 'threadAppend', id: 't1', items: [item(4, 'alpha again'), item(5, 'omega')] });
  await new Promise((r) => setTimeout(r, 50));
  st = await ev(() => ({
    shown: [...document.querySelectorAll('.msg')].filter((m) => !m.classList.contains('filtered-out')).length,
    count: document.getElementById('filterCount').textContent,
  }));
  ok('new messages follow the filter', st.shown === 3 && st.count === '3 of 6', st);
  await pg.keyboard.press('Escape');
  st = await ev(() => ({
    shown: [...document.querySelectorAll('.msg')].filter((m) => !m.classList.contains('filtered-out')).length,
    hidden: document.getElementById('filterRow').hidden,
  }));
  ok('Escape clears the filter and hides the row', st.shown === 6 && st.hidden, st);

  ok('no script errors', !errors.length, errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
