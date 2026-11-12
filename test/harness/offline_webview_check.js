// The real chat webview in headless Chrome: the agents-offline bar and its button, the "+" note that opens the
// channel menu, and the live dot naming a certificate this computer does not trust (not an ordinary drop).
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
const file = path.join(require('os').tmpdir(), 'offline_webview_check.html');
fs.writeFileSync(file, html);

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
  await pg.setViewport({ width: 1100, height: 700 });
  await pg.goto('file:///' + file.split(path.sep).join('/'));
  await send({ type: 'i18n', lang: 'en', strings: S });

  // no channels yet: the "+" is still there (join / new is exactly what is needed)
  await send({ type: 'channels', ready: true, items: [] });
  let st = await ev(() => ({ add: !!document.querySelector('.note.add'), muted: !!document.querySelector('#channelChips .muted') }));
  ok('with no channels the "+" note is shown next to the hint', st.add && st.muted, st);

  await send({
    type: 'channels',
    ready: true,
    items: [
      { id: 'A', name: 'a', isDm: false, color: 1 },
      { id: 'B', name: 'b', isDm: false, color: 2 },
    ],
  });
  await send({ type: 'channel', id: 'A', name: 'a', isDm: false, color: 1 });
  st = await ev((title) => {
    const add = document.querySelector('.note.add');
    add.click();
    return {
      count: document.querySelectorAll('.note.add').length,
      last: add === document.querySelector('#channelChips').lastElementChild,
      title: add.title === title,
    };
  }, S.channelMenu);
  ok('one "+" note at the end of the channel notes, titled', st.count === 1 && st.last && st.title, st);
  ok(
    'clicking "+" asks the extension for the channel menu',
    (await posted()).some((m) => m.type === 'channelMenu'),
  );

  await send({ type: 'agentsOffline', offline: true, names: ['lead_agent', 'qa_agent'] });
  st = await ev(() => ({
    hidden: document.getElementById('agentsOff').hidden,
    text: document.querySelector('#agentsOff .ao-text').textContent,
    btn: document.getElementById('openDesktopBtn').textContent,
    disabled: document.getElementById('openDesktopBtn').disabled,
  }));
  ok(
    'all agents offline -> the bar names them and offers Open Buzz Desktop',
    !st.hidden && /lead_agent, qa_agent/.test(st.text) && st.btn === S.openDesktop && !st.disabled,
    st,
  );

  await ev(() => document.getElementById('openDesktopBtn').click());
  st = await ev(() => ({ text: document.querySelector('#agentsOff .ao-text').textContent, disabled: document.getElementById('openDesktopBtn').disabled }));
  ok(
    'the button asks the extension to start Buzz Desktop and shows "starting…"',
    (await posted()).some((m) => m.type === 'openDesktop') && st.disabled && st.text === S.desktopStarting,
    st,
  );

  await send({ type: 'agentsOffline', offline: true, names: ['lead_agent', 'qa_agent'] });
  st = await ev(() => ({ text: document.querySelector('#agentsOff .ao-text').textContent, disabled: document.getElementById('openDesktopBtn').disabled }));
  ok('still offline after the start: the button comes back', !st.disabled && /lead_agent/.test(st.text), st);

  await send({ type: 'agentsOffline', offline: false, names: [] });
  ok('agents online -> the bar goes away', await ev(() => document.getElementById('agentsOff').hidden));

  await send({ type: 'agentsOffline', offline: true, names: ['lead_agent'] });
  await send({ type: 'channel', id: 'B', name: 'b', isDm: false, color: 2 });
  ok('another channel -> the bar is hidden until that channel reports', await ev(() => document.getElementById('agentsOff').hidden));

  await send({ type: 'host', kind: 'panel' });
  let wb = await ev(() => ({ text: document.getElementById('wideBtn').textContent, title: document.getElementById('wideBtn').title }));
  ok('in the editor tab the wide button says "back to the side bar"', wb.text === '⤡' && wb.title === S.wideBack, wb);
  await send({ type: 'host', kind: 'view' });
  wb = await ev(() => ({ text: document.getElementById('wideBtn').textContent, title: document.getElementById('wideBtn').title }));
  ok('in the side bar it opens the wide view', wb.text === '⤢' && wb.title === S.wide, wb);

  // the relay's certificate is not trusted: the live dot says so, in plain words
  await send({ type: 'live', state: 'error', detail: 'self-signed certificate', reason: 'certificate' });
  const tip = await ev(() => document.getElementById('liveDot').title);
  ok('a certificate the computer does not trust is named in the live dot', tip.startsWith(S.certTip) && tip.includes('self-signed certificate'), tip);
  await send({ type: 'live', state: 'offline', detail: 'connection closed (1006)' });
  const tip2 = await ev(() => document.getElementById('liveDot').title);
  ok('an ordinary drop is not called a certificate problem', !tip2.includes(S.certTip) && tip2.startsWith(S.offlineTip), tip2);

  ok('no script errors', !errors.length, errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
