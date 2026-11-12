// Drafts in the real chat webview (src/chatHtml.ts + media/chat.js + media/chat.css) in headless Chrome: what is typed
// stays with the thread (or a channel's "New thread") it was typed in, comes back with it, survives a reload through
// the extension, and leaves the draft it was sent from even when another thread is on screen by then.
//   node test/harness/draft_webview_check.js [repo]
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
// window.__state stands for the view's own state (an older version kept a single draft there)
const html = (state) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fs.readFileSync(path.join(PROJ, 'media/chat.css'), 'utf8')}</style>
<script>window.__posted=[];window.__state=${JSON.stringify(state)};window.__setState=[];
window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(JSON.parse(JSON.stringify(m))),getState:()=>window.__state,setState:(s)=>{window.__setState.push(s);window.__state=s;}});</script>
</head><body class="app">${body}<script>${fs.readFileSync(path.join(PROJ, 'media/chat.js'), 'utf8')}</script></body></html>`;
const tmp = require('os').tmpdir();
const file = (name, state) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, html(state));
  return 'file:///' + f.split(path.sep).join('/');
};

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
const item = (id, txt, root = true) => ({
  id,
  pubkey: 'p',
  author: 'agent',
  initials: 'AG',
  isMe: false,
  isAgent: true,
  isRoot: root,
  time: '10:00',
  ts: 1,
  html: `<p>${txt}</p>`,
  patches: [],
  depth: 0,
  snippet: txt,
});
const THREADS_A = [thread('t1', 300, 'one'), thread('t2', 200, 'two'), thread('t3', 100, 'three')];
const THREADS_B = [thread('u1', 300, 'b one')];

let pass = 0;
let fail = 0;
const ok = (name, cond, info) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info)));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch(require('./browser').launchOptions());
  const pg = await browser.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.setViewport({ width: 1200, height: 700 });
  const send = (m) => pg.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), m);
  const ev = (fn, ...a) => pg.evaluate(fn, ...a);
  const value = () => ev(() => document.getElementById('input').value);
  const type = (text) =>
    ev((text) => {
      const i = document.getElementById('input');
      i.value = text;
      i.dispatchEvent(new Event('input'));
    }, text);
  const click = (sel) => ev((sel) => document.querySelector(sel).click(), sel);
  const pencils = () => ev(() => [...document.querySelectorAll('.titem')].filter((r) => r.querySelector('.t-draft')).map((r) => r.dataset.id));
  const lastDrafts = () => ev(() => [...window.__posted].reverse().find((m) => m.type === 'drafts'));
  /** The extension's side of opening a thread: it answers 'openThread' with the thread. */
  const answerOpen = async (id, items) => {
    await send({ type: 'thread', id, title: id, items: items || [item(id + 'r', 'root of ' + id)] });
  };
  const open = async (id) => {
    await click(`.titem[data-id="${id}"]`);
    await answerOpen(id);
  };
  const boot = async (url, drafts) => {
    await pg.goto(url);
    await send({ type: 'i18n', lang: 'en', strings: S });
    await send({ type: 'host', kind: 'view' });
    if (drafts) await send({ type: 'drafts', items: drafts });
    await send({
      type: 'channels',
      ready: true,
      items: [
        { id: 'A', name: 'a', isDm: false, color: 1 },
        { id: 'B', name: 'b', isDm: false, color: 2 },
      ],
    });
    await send({ type: 'channel', id: 'A', name: 'a', isDm: false, color: 1 });
    await send({ type: 'threads', channelId: 'A', items: THREADS_A, initial: true, more: false }); // the wide layout opens t1
    await answerOpen('t1');
  };

  // ---------------------------------------------------------------- 1. each thread keeps its own text
  await boot(file('draft_check.html', {}), {});
  ok('the first thread opens with an empty composer', (await value()) === '', await value());
  await type('draft for t1');
  await click('.titem[data-id="t2"]');
  ok('the composer switches at the click, before the extension sends the thread', (await value()) === '', await value());
  await answerOpen('t2');
  ok('another thread shows its own (empty) composer, not the text typed in the first', (await value()) === '', await value());
  ok('the thread left with a draft gets a pencil in the list; the open one does not', JSON.stringify(await pencils()) === '["t1"]', await pencils());
  await type('draft for t2');
  await open('t1');
  ok('back in the first thread, its text is there again', (await value()) === 'draft for t1', await value());
  ok('both other drafts are marked', JSON.stringify(await pencils()) === '["t2"]', await pencils());

  // ---------------------------------------------------------------- 2. "New thread" has its own draft per channel
  await click('#newBtn');
  await send({ type: 'thread', id: null, title: 'New thread', items: [] });
  ok('"New thread" starts empty', (await value()) === '', await value());
  await type('new thread in A');
  await open('t1');
  ok('a thread after "New thread" shows its own text', (await value()) === 'draft for t1', await value());
  await click('#newBtn');
  await send({ type: 'thread', id: null, title: 'New thread', items: [] });
  ok('"New thread" brings its text back', (await value()) === 'new thread in A', await value());

  // ---------------------------------------------------------------- 3. another channel, and back
  await send({ type: 'channel', id: 'B', name: 'b', isDm: false, color: 2 });
  ok('switching channel empties the composer while the channel loads', (await value()) === '', await value());
  await send({ type: 'threads', channelId: 'B', items: THREADS_B, initial: true, more: false });
  await answerOpen('u1');
  ok("the other channel's thread shows its own composer", (await value()) === '', await value());
  await click('#newBtn');
  await send({ type: 'thread', id: null, title: 'New thread', items: [] });
  ok('"New thread" in another channel is a different draft', (await value()) === '', await value());
  await send({ type: 'channel', id: 'A', name: 'a', isDm: false, color: 1 });
  await send({ type: 'threads', channelId: 'A', items: THREADS_A, initial: true, more: false });
  await answerOpen('t1');
  ok('back in the first channel, its open thread has its text', (await value()) === 'draft for t1', await value());

  // ---------------------------------------------------------------- 4. kept by the extension (debounced), restored after a reload
  await sleep(450);
  const d1 = await lastDrafts();
  const keys = d1 ? Object.keys(d1.items).sort() : [];
  ok('the drafts reach the extension a moment after the last change', JSON.stringify(keys) === '["A:new","A:t1","A:t2"]', keys);
  await boot(file('draft_check.html', {}), d1 && d1.items);
  ok('after a reload the open thread shows its draft again', (await value()) === 'draft for t1', await value());
  ok('and the list marks the others', JSON.stringify(await pencils()) === '["t2"]', await pencils());

  // ---------------------------------------------------------------- 5. people picked with @ come back with the draft
  await send({ type: 'members', items: [{ pubkey: 'pkAda', name: 'Ada', isAgent: false }] });
  await open('t3');
  await pg.focus('#input');
  await pg.keyboard.type('@Ad');
  await pg.keyboard.press('Enter'); // picks Ada from the menu
  await pg.keyboard.type('please look');
  await open('t2');
  await open('t3');
  ok('a mention picked before leaving is in the text when coming back', (await value()) === '@Ada please look', await value());
  await ev(() => (window.__posted.length = 0));
  await click('#sendBtn');
  const sent3 = await ev(() => window.__posted.find((m) => m.type === 'send'));
  ok(
    'sent from the restored draft, the mention still names the person',
    !!sent3 && JSON.stringify(sent3.mentions) === '["pkAda"]' && sent3.thread === 't3',
    sent3,
  );
  await send({ type: 'sent', text: '@Ada please look' });
  await send({ type: 'sending', on: false });
  ok('the composer is empty after sending', (await value()) === '', await value());

  // ---------------------------------------------------------------- 5b. ...and across a channel switch
  await open('t3');
  await pg.focus('#input');
  await pg.keyboard.type('@Ad');
  await pg.keyboard.press('Enter');
  await pg.keyboard.type('once more');
  await send({ type: 'channel', id: 'B', name: 'b', isDm: false, color: 2 });
  await send({ type: 'threads', channelId: 'B', items: THREADS_B, initial: true, more: false });
  await answerOpen('u1');
  await send({ type: 'channel', id: 'A', name: 'a', isDm: false, color: 1 });
  await send({ type: 'threads', channelId: 'A', items: THREADS_A, initial: true, more: false });
  await answerOpen('t1');
  await send({ type: 'members', items: [{ pubkey: 'pkAda', name: 'Ada', isAgent: false }] });
  await open('t3');
  await ev(() => (window.__posted.length = 0));
  await click('#sendBtn');
  const sent3b = await ev(() => window.__posted.find((m) => m.type === 'send'));
  ok('a mention picked before switching channel still names the person when sent', !!sent3b && JSON.stringify(sent3b.mentions) === '["pkAda"]', sent3b);
  await send({ type: 'sent', text: '@Ada once more' });
  await send({ type: 'sending', on: false });

  // ---------------------------------------------------------------- 6. the message a reply answers comes back with the draft
  await open('t1');
  await send({ type: 'thread', id: 't1', title: 't1', items: [item('t1r', 'root of t1'), item('t1x', 'an answer', false)] });
  await click('article.msg[data-id="t1x"] .reply-btn');
  await type('draft for t1, answering t1x');
  await open('t2');
  ok('another thread has no reply bar', await ev(() => document.getElementById('replyBar').hidden));
  await open('t1');
  ok(
    'coming back, the reply bar is there again',
    await ev(() => !document.getElementById('replyBar').hidden && /agent/.test(document.getElementById('replyBar').textContent)),
  );

  // ---------------------------------------------------------------- 7. sent, and another thread opened before the extension confirmed it
  await ev(() => (window.__posted.length = 0));
  await click('#sendBtn');
  const sent1 = await ev(() => window.__posted.find((m) => m.type === 'send'));
  ok('the message names its thread and reply target', !!sent1 && sent1.thread === 't1' && sent1.replyTo === 't1x', sent1);
  await open('t2'); // the user moves on while it is on its way
  await send({ type: 'sent', text: 'draft for t1, answering t1x' });
  await send({ type: 'sending', on: false });
  ok("the thread on screen keeps its own text when the other one's message is confirmed", (await value()) === 'draft for t2', await value());
  ok('the sent thread has no pencil any more', JSON.stringify(await pencils()) === '[]', await pencils());
  await open('t1');
  ok('and its composer is empty', (await value()) === '', await value());

  // ---------------------------------------------------------------- 8. at most 30 drafts: the oldest goes
  const many = {};
  for (let i = 0; i < 30; i++) many['B:x' + i] = { text: 'old ' + i, at: 1000 + i };
  await send({ type: 'drafts', items: many });
  await type('one more draft');
  await sleep(450);
  const d2 = await lastDrafts();
  const k2 = d2 ? Object.keys(d2.items) : [];
  ok('30 drafts at most; the oldest is dropped for a new one', k2.length === 30 && !k2.includes('B:x0') && k2.includes('A:t1'), {
    n: k2.length,
    hasOldest: k2.includes('B:x0'),
  });

  // ---------------------------------------------------------------- 9. an older single draft (the view's own state) is not lost
  await boot(file('draft_legacy.html', { draft: 'typed in 0.8.5' }), {});
  ok("an older version's draft goes to the first thread opened", (await value()) === 'typed in 0.8.5', await value());
  ok('and the old single-draft state is cleared', await ev(() => window.__setState.length >= 1 && !(window.__state || {}).draft));
  await sleep(450);
  const d3 = await lastDrafts();
  ok("it is kept as that thread's draft from then on", !!d3 && d3.items['A:t1'] && d3.items['A:t1'].text === 'typed in 0.8.5', d3);

  // ---------------------------------------------------------------- 10. text typed before a thread was on screen is added, not dropped
  await boot(file('draft_check.html', {}), { 'B:u1': { text: 'saved in u1', at: 5 } });
  await send({ type: 'channel', id: 'B', name: 'b', isDm: false, color: 2 });
  await type('typed while loading');
  await send({ type: 'threads', channelId: 'B', items: THREADS_B, initial: true, more: false });
  await answerOpen('u1');
  ok("typed while the channel loaded: added to the thread's draft", (await value()) === 'saved in u1\n\ntyped while loading', await value());

  ok('no page errors', errors.length === 0, errors);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('FAIL the harness itself threw  ' + ((e && e.stack) || e));
  process.exit(1);
});
