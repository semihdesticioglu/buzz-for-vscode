// Hostile content in the real webview: the extension's markdown renderer (out/markdown.js) turns attack-shaped
// messages into the html it would send, the real page (src/chatHtml.ts + media/chat.css + media/chat.js) renders
// them in headless Chrome WITHOUT the CSP the real webview carries, so any handler or script that survived the
// renderer would actually run and bump window.__xss. Usage: node stress_hostile.js <repo>
const fs = require('fs');
const path = require('path');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');
if (!PROJ) {
  console.error('usage: node stress_hostile.js <repo path>');
  process.exit(1);
}
const puppeteer = require('puppeteer-core');
const i18n = require(path.join(PROJ, 'out/i18n.js'));
const { renderMarkdown } = require(path.join(PROJ, 'out/markdown.js'));
const { isSafeRel, normalizeRel } = require(path.join(PROJ, 'out/core.js'));
i18n.setLang('en');
const S = i18n.webviewStrings();

let pass = 0;
let fail = 0;
const ok = (name, cond, info) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info)));
};
const unexpected = [];
process.on('unhandledRejection', (e) => unexpected.push('unhandledRejection: ' + (e && e.stack ? e.stack : e)));
process.on('uncaughtException', (e) => unexpected.push('uncaughtException: ' + (e && e.stack ? e.stack : e)));
const hardStop = setTimeout(() => {
  console.log('FAIL harness exceeded 170 s');
  process.exit(1);
}, 170_000);

// ------------------------------------------------------------------ the page, built exactly like the other webview harnesses
const tpl = /return `(<!DOCTYPE html>[\s\S]*?<\/html>)`;/.exec(fs.readFileSync(path.join(PROJ, 'src/chatHtml.ts'), 'utf8'))[1];
const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const tx = (k) => `data-i18n="${k}">${esc(S[k] ?? k)}`;
const ti = (k) => `data-i18n-title="${k}" title="${esc(S[k] ?? k)}"`;
const page0 = new Function('s', 'esc', 'tx', 'ti', 'cur', 'n', 'css', 'js', 'img', 'w', 'return `' + tpl + '`;')(S, esc, tx, ti, 'en', 'x', '', '', '', {
  cspSource: '',
});
const body = /<body class="app">\n([\s\S]*?)<script nonce=/.exec(page0)[1];
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fs.readFileSync(path.join(PROJ, 'media/chat.css'), 'utf8')}</style>
<script>
window.__posted=[];window.__xss=0;window.__xssWhat=[];
window.pwn=function(w){window.__xss++;window.__xssWhat.push(String(w||'pwn'));};
window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(m),getState:()=>({}),setState:()=>{}});
</script>
</head><body class="app">${body}<script>${fs.readFileSync(path.join(PROJ, 'media/chat.js'), 'utf8')}</script></body></html>`;
const file = path.join(require('os').tmpdir(), 'stress_hostile_page.html');
fs.writeFileSync(file, html);

// ------------------------------------------------------------------ hostile sources -> html through the real renderer
const ENV = { jiraUrl: 'https://jira.example.com', jiraKeys: ['ABC'], imageHost: 'relay.example' };
const TR = 'İstanbul ığüşöçĞÜŞÖÇ IŞIK çalışıyor, Diyarbakır\u2019da yağmur';
const RTL = 'مرحبا بالعالم \u202Eevil reversed\u202C שלום עולם \u2067isolate\u2069 end';
const EMOJI = '👨\u200d👩\u200d👧\u200d👦 🏳️\u200d🌈 👩🏽\u200d💻 🇹🇷';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const cases = [
  ['script tag', '<script>pwn("script")</script>'],
  ['script tag split', '<scr<script>ipt>pwn("split")</script>'],
  ['img onerror', '<img src=x onerror=pwn("img")>'],
  ['svg onload', '<svg onload=pwn("svg")></svg>'],
  ['svg nested', '<svg><script>pwn("svg2")</script></svg>'],
  ['iframe srcdoc', '<iframe srcdoc="<script>parent.pwn(1)</script>"></iframe>'],
  ['javascript link', '[click](javascript:pwn("js"))'],
  ['JAVASCRIPT link upper', '[click](JAVASCRIPT:pwn("JS"))'],
  ['javascript link with tab', '[click](java\tscript:pwn("jstab"))'],
  ['javascript link entity', '[click](&#106;avascript:pwn("jsent"))'],
  ['javascript autolink', '<javascript:pwn("auto")>'],
  ['vbscript link', '[click](vbscript:pwn("vb"))'],
  ['data:text/html link', '[click](data:text/html,<script>pwn("data")</script>)'],
  ['data:text/html base64 link', '[click](data:text/html;base64,PHNjcmlwdD5wd24oKTwvc2NyaXB0Pg==)'],
  ['link text is html', '[<b onmouseover=pwn("lt")>bold</b><img src=x onerror=pwn("lt2")>](https://ok.example/x)'],
  ['link title with quote', '[t](https://ok.example/y "x\\" onmouseover=\\"pwn(1)")'],
  ['link href with quote', '[t](https://ok.example/z"onmouseover="pwn(2))'],
  ['image other host', '![tracker](https://evil.example/pixel.png)'],
  ['image other host with onerror in alt', '![x" onerror="pwn(3)](https://evil.example/p.png)'],
  ['image relay host', '![ok](https://relay.example/p.png)'],
  ['image relay host lookalike', '![nope](https://relay.example.evil.example/p.png)'],
  ['image relay host userinfo', '![nope](https://relay.example@evil.example/p.png)'],
  ['image data:image/png', `![dot](${PNG})`],
  ['image data:text/html', '![nope](data:text/html,<script>pwn(4)</script>)'],
  ['image javascript', '![nope](javascript:pwn(5))'],
  ['blockquotes 200 deep', '> '.repeat(200) + 'DEEPEST'],
  ['blockquotes 200 lines', Array.from({ length: 200 }, (_, i) => '>'.repeat(i + 1) + ' bq' + i).join('\n')],
  ['lists 60 deep', '- '.repeat(60) + 'LISTDEEP'],
  ['quotes and lists 60 deep', '> - '.repeat(60) + 'QLDEEP'],
  ['list indented 60 levels', Array.from({ length: 60 }, (_, i) => '  '.repeat(i) + '- item' + i).join('\n') + '\n\nAFTERLIST'],
  ['64 KB message', Array.from({ length: 9000 }, (_, i) => 'word' + i).join(' ') + ' END64K'],
  ['10,000-line code block', '```python\n' + Array.from({ length: 10000 }, (_, i) => `def f${i}(x): return x + ${i}  # "<b>"`).join('\n') + '\n```'],
  ['2,000 inline code spans', Array.from({ length: 2000 }, (_, i) => '`c' + i + '`').join(' ')],
  ['broken fence unclosed', '```js\nunclosed <script>pwn(6)</script>'],
  ['broken fence nested ticks', '````\n```\nx\n````\n```'],
  ['broken fence one line', '``` js ``` <img src=x onerror=pwn(7)> ```'],
  ['broken fence tilde mix', '~~~\n```\n<svg onload=pwn(8)>\n~~~'],
  ['broken fence only backticks', '``````````'],
  ['fence 200-char language', '```' + 'x'.repeat(200) + '\nfoo\n```'],
  ['fence hostile info', '```js" onmouseover="pwn(9)\nbar\n```'],
  ['fence info html', '```<img src=x onerror=pwn(10)>\nbaz\n```'],
  ['turkish', TR],
  ['rtl bidi', RTL],
  ['emoji zwj', EMOJI],
  ['mention html', '@<b>bob</b> and @ali<img src=x onerror=pwn(11)> and @<script>pwn(12)</script>'],
  ['mention 5000 chars', '@' + 'a'.repeat(5000)],
  [
    'refs dotdot and absolute',
    'see ../../etc/passwd:3 and etl/../../x.py:7 and /etc/passwd:1 and C:/Windows/win.ini:2 and \\\\srv\\share\\x.py:4 and `../x.py:1` and `/abs/x.py:2` and `C:\\abs\\y.py:3` and `etl/../z.py:5` and `file:///etc/passwd:1` and etl/ok.py:9',
  ],
  ['jira long key', 'ABC-123456789012 and ABC-1 and ABCD-5 and XYZ-9 and abc-3'],
  ['jira in code span', '`ABC-42` and `ABC-123456789012345678901234567890`'],
  ['jira hostile url', 'ABC-7"onmouseover="pwn(13) and ABC-8'],
  ['entities', '&lt;script&gt;pwn(14)&lt;/script&gt; &#x3C;img src=x onerror=pwn(15)&#x3E; &quot;'],
  ['html comment and cdata', '<!-- <script>pwn(16)</script> --> <![CDATA[<script>pwn(17)</script>]]>'],
  ['math-looking and template', '${pwn(18)} {{pwn(19)}} <%= pwn(20) %>'],
  ['table with html', '| a | b |\n|---|---|\n| <img src=x onerror=pwn(21)> | [x](javascript:pwn(22)) |'],
  ['heading with html', '# <svg onload=pwn(23)> title\n## [j](javascript:pwn(24))'],
  ['autolink www', 'www.example.com and http://example.com/<script>pwn(25)</script> and https://ok.example/?a=1&b=<b>'],
  ['nul and controls', 'a\u0000b\u0001c\u001bd\u0085e\u2028f\u2029g'],
  ['long unbroken line', 'x'.repeat(20000)],
];

const render = (src) => renderMarkdown(src, ENV);
const metrics = [];
const items = [];
let n = 0;
const base = 1_700_000_000;
const mk = (text, html, extra) => ({
  id: 'm' + n++,
  pubkey: 'p1',
  author: 'agent',
  initials: 'AG',
  isMe: false,
  isAgent: true,
  isRoot: n === 1,
  time: '10:00',
  ts: base + n * 60,
  html,
  patches: [],
  depth: 0,
  snippet: text.slice(0, 80),
  ...extra,
});
for (const [name, src] of cases) {
  const t0 = process.hrtime.bigint();
  const h = render(src);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  metrics.push({ name, srcBytes: Buffer.byteLength(src), htmlBytes: Buffer.byteLength(h), renderMs: +ms.toFixed(1) });
  items.push(mk(src, h, { snippet: name }));
}
// hostile metadata: the webview must place these as text, never as markup
const HOSTILE_ID = '"><img src=x onerror=pwn("id")>';
items.push(
  mk('meta', render('metadata message'), {
    id: HOSTILE_ID,
    author: '<img src=x onerror=pwn("author")>',
    initials: '<svg onload=pwn("ini")>',
    time: '<b>10:00</b>',
    snippet: '<script>pwn("snip")</script>',
    parentAuthor: '<img src=x onerror=pwn("pa")>',
    depth: 1,
    parentId: 'm0',
    git: { branches: ['<img src=x onerror=pwn("br")>'], commits: ['<svg onload=pwn("c")>'] },
  }),
);
// 300 messages each with a code block and a patch bar
const PATCH_SRC = 'Change `pipeline/steps/rollup.py:12`:\n```python\ndef score(x):\n    return x * 2  # <script>pwn(99)</script>\n```';
const patchHtml = render(PATCH_SRC);
const firstPatch = items.length;
for (let i = 0; i < 300; i++) {
  items.push(
    mk('patch ' + i, patchHtml, {
      patches: [{ block: 0, files: [i % 2 ? '<img src=x onerror=pwn("pf")>' : 'pipeline/steps/rollup.py'], local: true }],
      snippet: 'patch ' + i,
    }),
  );
}
const totalHtml = items.reduce((a, it) => a + it.html.length, 0);

(async () => {
  const browser = await puppeteer.launch(require('./browser').launchOptions());
  const pg = await browser.newPage();
  const errors = [];
  const requests = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  pg.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });
  await pg.setRequestInterception(true);
  const png1x1 = Buffer.from(PNG.split(',')[1], 'base64');
  pg.on('request', (r) => {
    const u = r.url();
    if (u.startsWith('file:') || u.startsWith('data:')) return r.continue();
    requests.push(u);
    // the relay image is allowed: answer it locally (no network); anything else is refused and counted
    if (/^https:\/\/relay\.example\//.test(u)) return r.respond({ status: 200, contentType: 'image/png', body: png1x1 });
    r.abort();
  });
  const send = (m) => pg.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), m);
  const ev = (fn, ...a) => pg.evaluate(fn, ...a);
  const posted = () => ev(() => window.__posted.splice(0));
  const settle = () => ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));
  await pg.setViewport({ width: 1100, height: 720 });
  await pg.goto('file:///' + file.split(path.sep).join('/'));
  await send({ type: 'i18n', lang: 'en', strings: S });
  await send({ type: 'channels', ready: true, items: [{ id: 'A', name: 'general', isDm: false, color: 1 }] });
  await send({ type: 'channel', id: 'A', name: 'general', isDm: false, color: 1 });
  await send({
    type: 'threads',
    channelId: 'A',
    items: [
      {
        id: 'm0',
        pubkey: 'p1',
        author: 'agent',
        initials: 'AG',
        isAgent: true,
        isMe: false,
        snippet: '<img src=x onerror=pwn("row")>',
        replies: 0,
        lastIsMe: false,
        people: [],
        time: '10:00',
        ts: base,
      },
    ],
    initial: true,
    more: false,
  });
  await ev(() => document.querySelector('#threadList .titem').click());
  await posted();

  // ---------------------------------------------------------------- render the hostile thread
  const t0 = Date.now();
  await send({ type: 'thread', id: 'm0', title: '<svg onload=pwn("title")> thread <b>t</b>', items, reveal: true });
  await settle();
  const renderMs = Date.now() - t0;
  const t1 = Date.now();
  await ev(() => 1);
  const pingMs = Date.now() - t1;
  metrics.push({ name: 'thread of ' + items.length + ' messages', srcBytes: 0, htmlBytes: totalHtml, renderMs });
  ok(`the thread (${items.length} messages, ${(totalHtml / 1024).toFixed(0)} KB of html) renders in ${renderMs} ms`, renderMs < 30000, renderMs);
  ok(`the page stays responsive: a trivial evaluate returns in ${pingMs} ms`, pingMs < 1000, pingMs);

  const dom = await ev(() => {
    const log = document.getElementById('log');
    const all = [...document.querySelectorAll('*')];
    const handlers = [];
    for (const e of all) for (const a of e.attributes) if (/^on/i.test(a.name)) handlers.push(e.tagName + ' ' + a.name + '=' + a.value.slice(0, 60));
    const bad = [...log.querySelectorAll('script,iframe,object,embed,form,meta,base,link,style,svg,template')].map((e) => e.outerHTML.slice(0, 80));
    const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    const imgs = [...log.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    const msgs = log.querySelectorAll('article.msg').length;
    const text = log.textContent;
    const title = document.getElementById('threadTitle');
    return { handlers, bad, hrefs, imgs, msgs, text, titleHtmlChildren: title.children.length, titleText: title.textContent, msgCount: msgs };
  });
  const xss = await ev(() => ({ n: window.__xss, what: window.__xssWhat }));
  ok('window.__xss stays 0 (no handler, script or javascript: URL ran)', xss.n === 0, xss);
  ok('no pageerror / console.error while rendering', errors.length === 0, errors.slice(0, 5));
  ok(`all ${items.length} messages are in the thread`, dom.msgs === items.length, dom.msgs);
  ok('no inline event handler attribute survives anywhere in the page', dom.handlers.length === 0, dom.handlers.slice(0, 10));
  ok('no script/iframe/svg/object/form/style element inside the thread', dom.bad.length === 0, dom.bad.slice(0, 10));
  const badHref = dom.hrefs.filter((h) => !/^https?:\/\//i.test(h) && !/^#/.test(h));
  ok(`every <a> href is http(s) or an in-page anchor (${dom.hrefs.length} links)`, badHref.length === 0, badHref.slice(0, 10));
  const jsLike = dom.hrefs.filter((h) => /javascript|vbscript|data:/i.test(h.replace(/\s/g, '').toLowerCase()));
  ok('no javascript:/vbscript:/data: link in any form (case, tab, entity, autolink)', jsLike.length === 0, jsLike);
  const badImg = dom.imgs.filter((s) => {
    if (/^data:image\//i.test(s)) return false;
    try {
      return new URL(s).host !== 'relay.example';
    } catch {
      return true;
    }
  });
  ok(`images only from the relay host or data:image (${dom.imgs.length} <img>)`, badImg.length === 0 && dom.imgs.length === 2, { imgs: dom.imgs, badImg });
  ok(
    'an image from another host is a link, not an <img>',
    dom.hrefs.includes('https://evil.example/pixel.png') && !dom.imgs.some((s) => /evil\.example/.test(s)),
    dom.hrefs.filter((h) => /evil/.test(h)),
  );
  ok('no network request to a foreign host was attempted while rendering', !requests.some((u) => !/^https:\/\/relay\.example\//.test(u)), requests);
  ok('the thread title with html is shown as text', dom.titleHtmlChildren === 0 && dom.titleText.includes('<svg onload=pwn("title")>'), {
    children: dom.titleHtmlChildren,
    text: dom.titleText,
  });
  ok('Turkish text is intact in the thread', dom.text.includes(TR), TR);
  ok('RTL text with bidi overrides is intact', dom.text.includes(RTL));
  ok('emoji with ZWJ are intact', dom.text.includes(EMOJI));
  ok('the 64 KB message is there to its end', dom.text.includes('word8999 END64K'));
  // markdown-it drops whatever lies deeper than its nesting limit; the extension keeps it, as text at the deepest level
  // drawn (20), so nothing a sender writes can be hidden from VS Code users
  ok(
    'text inside lists nested deeper than markdown draws is still shown (one line, mixed with quotes, by indentation)',
    ['LISTDEEP', 'QLDEEP', 'item59', 'AFTERLIST'].every((s) => dom.text.includes(s)),
    Object.fromEntries(['LISTDEEP', 'QLDEEP', 'item59', 'AFTERLIST'].map((s) => [s, dom.text.includes(s)])),
  );
  ok('text inside blockquotes nested deeper than 100 is still shown (not silently dropped)', dom.text.includes('DEEPEST') && dom.text.includes('bq199'), {
    deepest: dom.text.includes('DEEPEST'),
    bq98: dom.text.includes('bq98'),
    bq99: dom.text.includes('bq99'),
    bq199: dom.text.includes('bq199'),
  });
  ok(
    'NUL and control characters do not break the message (NUL becomes U+FFFD)',
    /a[\s\S]?b[\s\S]?c[\s\S]?d[\s\S]?e[\s\S]?f[\s\S]?g/.test(dom.text) && !dom.text.includes('\u0000'),
    JSON.stringify((/a[\s\S]{0,12}g/.exec(dom.text) || [])[0]),
  );

  // per-message structure
  const struct = await ev((HOSTILE_ID) => {
    const q = (i, sel) => document.querySelectorAll('article.msg')[i].querySelectorAll(sel);
    const msg = (i) => document.querySelectorAll('article.msg')[i];
    const find = (snip) => [...document.querySelectorAll('article.msg')].findIndex((m) => (m.querySelector('.reply-btn') || {}).dataset?.snippet === snip);
    const bq = (i) => {
      let d = 0;
      let e = msg(i).querySelector('blockquote');
      while (e) {
        d++;
        e = e.querySelector('blockquote');
      }
      return d;
    };
    const out = {};
    out.deep = bq(find('blockquotes 200 deep'));
    out.deepLines = bq(find('blockquotes 200 lines'));
    const code10 = msg(find('10,000-line code block')).querySelector('.code code');
    out.codeLines = code10 ? code10.textContent.split('\n').length : 0;
    out.codeHasLast = code10 ? code10.textContent.includes('def f9999') : false;
    out.spans = q(find('2,000 inline code spans'), 'code').length;
    out.langClass = (msg(find('fence 200-char language')).querySelector('code') || {}).className || '';
    out.langLabel = msg(find('fence 200-char language')).querySelector('.lang')?.textContent ?? null;
    out.hostileInfoClass = (msg(find('fence hostile info')).querySelector('code') || {}).className || '';
    out.mentionB = q(find('mention html'), 'b,img,script').length;
    out.mentionText = msg(find('mention html')).querySelector('.body').textContent;
    out.linkTextChildren = [...q(find('link text is html'), 'a')].map((a) => a.children.length + ':' + a.textContent);
    out.jiraLong = [...q(find('jira long key'), 'a.jira')].map((a) => a.dataset.key + '|' + a.getAttribute('href'));
    out.jiraCode = [...q(find('jira in code span'), 'a.jira, code')].map((e) => e.tagName + ':' + e.textContent);
    out.jiraHostile = [...q(find('jira hostile url'), 'a.jira')].map((a) => a.getAttribute('href'));
    out.refs = [...document.querySelectorAll('a.ref')].map((a) => a.dataset.path);
    out.patchBars = document.querySelectorAll('.patch:not(.gitbar)').length;
    out.gitBars = document.querySelectorAll('.patch.gitbar').length;
    out.patchFileImgs = document.querySelectorAll('.patch img, .patch svg').length;
    const hm = [...document.querySelectorAll('article.msg')].find((m) => m.dataset.id === HOSTILE_ID);
    out.hostileMeta = hm
      ? {
          nameText: hm.querySelector('.name').textContent,
          imgs: hm.querySelectorAll('img,svg,script').length,
          replyTo: hm.querySelector('.reply-to')?.textContent,
        }
      : null;
    out.folded = document.querySelectorAll('.body.fold').length;
    out.big64Fold = !!msg(find('64 KB message')).querySelector('.body.fold');
    out.entities = msg(find('entities')).querySelector('.body').textContent;
    out.tableImgs = q(find('table with html'), 'img,script').length;
    out.tableHtml = msg(find('table with html')).querySelector('table') ? 'table' : 'notable';
    out.heading = q(find('heading with html'), 'svg,a').length;
    return out;
  }, HOSTILE_ID);
  ok('200-deep blockquote renders as a bounded nesting without error (20 levels drawn)', struct.deep > 0 && struct.deep <= 21, struct.deep);
  ok('200 lines of growing blockquotes render', struct.deepLines > 0, struct.deepLines);
  ok('the 10,000-line code block is complete and highlighted', struct.codeLines >= 10000 && struct.codeHasLast, {
    lines: struct.codeLines,
    last: struct.codeHasLast,
  });
  ok('2,000 inline code spans all render as <code>', struct.spans === 2000, struct.spans);
  ok('a 200-char fence language becomes a class only, no label, no handler', /^language-x{200}$/.test(struct.langClass) && struct.langLabel === null, {
    cls: struct.langClass.slice(0, 40),
    label: struct.langLabel,
  });
  ok(
    'a hostile fence info string stays inside the class attribute',
    !/onmouseover/.test(struct.hostileInfoClass) || /^language-/.test(struct.hostileInfoClass),
    struct.hostileInfoClass,
  );
  ok('a @mention containing html is text, no <b>/<img>/<script> created', struct.mentionB === 0 && struct.mentionText.includes('@<b>bob</b>'), {
    els: struct.mentionB,
    text: struct.mentionText.slice(0, 80),
  });
  ok(
    'a markdown link whose text is html has no child elements',
    struct.linkTextChildren.every((s) => s.startsWith('0:')),
    struct.linkTextChildren,
  );
  ok(
    'ABC-123456789012 and ABC-1 are Jira links to https://jira.example.com, ABCD-5/XYZ-9/abc-3 are not',
    struct.jiraLong.length === 2 && struct.jiraLong.every((s) => /^ABC-\d+\|https:\/\/jira\.example\.com\/browse\/ABC-\d+$/.test(s)),
    struct.jiraLong,
  );
  ok(
    'a Jira key inside a code span: rendered as a Jira link or as code, never anything else',
    struct.jiraCode.length === 2 && struct.jiraCode.every((s) => /^(A|CODE):/.test(s)),
    struct.jiraCode,
  );
  ok(
    'a Jira key followed by a quoted attribute does not escape its href',
    struct.jiraHostile.every((h) => /^https:\/\/jira\.example\.com\/browse\/ABC-\d+$/.test(h)),
    struct.jiraHostile,
  );
  ok('300 patch bars, one per patch message, with file names as text', struct.patchBars === 300 && struct.patchFileImgs === 0, {
    bars: struct.patchBars,
    imgs: struct.patchFileImgs,
  });
  ok('a git bar with hostile branch names is text', struct.gitBars === 1, struct.gitBars);
  ok(
    'hostile author/initials/parentAuthor/snippet are text, no element created',
    struct.hostileMeta &&
      struct.hostileMeta.imgs === 0 &&
      struct.hostileMeta.nameText === '<img src=x onerror=pwn("author")>' &&
      /pwn\("pa"\)/.test(struct.hostileMeta.replyTo || ''),
    struct.hostileMeta,
  );
  ok('the 64 KB message is folded (show more), patch messages are not', struct.big64Fold && struct.folded < items.length, {
    folded: struct.folded,
    big: struct.big64Fold,
  });
  ok(
    'html entities in text are shown literally, not decoded into tags',
    struct.entities.includes('<script>pwn(14)</script>') && struct.entities.includes('<img src=x onerror=pwn(15)>'),
    struct.entities,
  );
  ok('html inside a table cell is text', struct.tableImgs === 0, { imgs: struct.tableImgs, table: struct.tableHtml });
  ok('html inside a heading is text', struct.heading === 0, struct.heading);

  // ---------------------------------------------------------------- file references: what does a click post?
  await posted();
  const refClicks = await ev(() => {
    const out = [];
    for (const a of document.querySelectorAll('a.ref')) {
      window.__posted.length = 0;
      a.click();
      out.push({ path: a.dataset.path, posted: window.__posted.slice() });
    }
    return out;
  });
  const dotdot = refClicks.filter((r) => /(^|\/)\.\.(\/|$)|^\/|^[a-zA-Z]:|^\\\\/.test(r.path));
  ok(
    `clicking a ref posts openRef with its path (${refClicks.length} refs)`,
    refClicks.length > 0 && refClicks.every((r) => r.posted.length === 1 && r.posted[0].type === 'openRef' && r.posted[0].path === r.path),
    refClicks.slice(0, 5),
  );
  ok(
    'every ref that is offered is either inside the workspace or refused by isSafeRel (refs.ts resolveWorkspaceFile)',
    refClicks.every((r) => isSafeRel(r.path) === !/(^|\/)\.\.(\/|$)|^\/|^[a-zA-Z]:|^\\\\/.test(r.path)),
    refClicks.map((r) => [r.path, isSafeRel(r.path)]),
  );
  ok(
    `the ".." refs that the renderer offers (${dotdot.map((r) => r.path).join(', ')}) are all refused by isSafeRel`,
    dotdot.length > 0 && dotdot.every((r) => isSafeRel(r.path) === false),
    dotdot.map((r) => [r.path, isSafeRel(r.path)]),
  );
  ok(
    'absolute paths in plain text are never offered as refs',
    !refClicks.some((r) => /^\/|^[a-zA-Z]:|^\\\\|^file:/.test(r.path)),
    refClicks.map((r) => r.path),
  );
  // a leading "/" is by design folded into the workspace by normalizeRel ("/abs/x.py" -> "abs/x.py"), so it cannot escape
  ok(
    'isSafeRel refuses "..", "etl/../..", "C:\\\\x", "\\\\\\\\srv", "file:///x"; accepts "etl/ok.py"; folds "/abs/x.py" into the workspace',
    !isSafeRel('../x.py') &&
      !isSafeRel('etl/../../x.py') &&
      !isSafeRel('C:\\abs\\y.py') &&
      !isSafeRel('\\\\srv\\share\\x.py') &&
      !isSafeRel('file:///etc/passwd') &&
      isSafeRel('etl/ok.py') &&
      isSafeRel('pipeline/steps/rollup.py') &&
      normalizeRel('/abs/x.py') === 'abs/x.py',
    {
      dotdot: isSafeRel('../x.py'),
      nested: isSafeRel('etl/../../x.py'),
      drive: isSafeRel('C:\\abs\\y.py'),
      unc: isSafeRel('\\\\srv\\share\\x.py'),
      uri: isSafeRel('file:///etc/passwd'),
      ok: isSafeRel('etl/ok.py'),
      abs: normalizeRel('/abs/x.py'),
    },
  );

  // ---------------------------------------------------------------- links: what does a click post?
  const linkClicks = await ev(() => {
    const out = [];
    for (const a of [...document.querySelectorAll('#log a[href]:not(.ref)')].slice(0, 60)) {
      window.__posted.length = 0;
      a.click();
      out.push({ href: a.getAttribute('href'), posted: window.__posted.slice() });
    }
    return out;
  });
  ok(
    `clicking a link posts 'open' with its http(s) url and nothing navigates (${linkClicks.length} links)`,
    linkClicks.length > 0 && linkClicks.every((l) => l.posted.length === 1 && l.posted[0].type === 'open' && /^https?:\/\//i.test(l.posted[0].url)),
    linkClicks.filter((l) => !(l.posted.length === 1 && /^https?:\/\//i.test(l.posted[0].url || ''))).slice(0, 5),
  );
  ok('the page did not navigate away after the clicks', (await ev(() => location.href)).startsWith('file:'), await ev(() => location.href));
  ok('still no network request to a foreign host after the clicks', !requests.some((u) => !/^https:\/\/relay\.example\//.test(u)), requests);

  // patch bar and copy on the biggest block
  await posted();
  const pb = await ev((first) => {
    window.__posted.length = 0;
    const m = document.querySelectorAll('article.msg')[first];
    m.querySelector('.pbtn[data-act="patchDiff"]').click();
    m.querySelector('.pbtn[data-act="patchApply"]').click();
    return window.__posted.slice();
  }, firstPatch);
  ok(
    'the patch bar buttons post patchDiff / patchApply with the message id and block',
    pb.length === 2 && pb[0].type === 'patchDiff' && pb[1].type === 'patchApply' && pb.every((x) => x.id === items[firstPatch].id && x.block === 0),
    pb,
  );
  const t2 = Date.now();
  const copy = await ev(() => {
    window.__posted.length = 0;
    const m = [...document.querySelectorAll('article.msg')].find((x) => (x.querySelector('.reply-btn') || {}).dataset?.snippet === '10,000-line code block');
    m.querySelector('.copy').click();
    const p = window.__posted[0];
    return { type: p && p.type, len: p && p.text.length, last: p && p.text.includes('def f9999') };
  });
  const copyMs = Date.now() - t2;
  ok(`Copy on the 10,000-line block posts the whole text (${copy.len} chars) in ${copyMs} ms`, copy.type === 'copy' && copy.last && copyMs < 5000, {
    copy,
    copyMs,
  });

  // Jira hover posts a jiraInfo request with the long key, nothing else
  // scroll first and let the scroll event pass (it hides any card and cancels the hover timer), then hover
  await ev(() => [...document.querySelectorAll('a.jira')].find((x) => x.dataset.key === 'ABC-123456789012').scrollIntoView());
  await settle();
  await ev(() => {
    window.__posted.length = 0;
    const a = [...document.querySelectorAll('a.jira')].find((x) => x.dataset.key === 'ABC-123456789012');
    a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 600));
  const jp = await posted();
  ok(
    'hovering ABC-123456789012 asks the extension for jiraInfo with that key',
    jp.some((m) => m.type === 'jiraInfo' && m.key === 'ABC-123456789012'),
    jp,
  );
  await send({
    type: 'jiraInfo',
    key: 'ABC-123456789012',
    data: {
      key: 'ABC-123456789012',
      summary: '<img src=x onerror=pwn("jira")>',
      status: '<svg onload=pwn(1)>',
      statusCategory: 'new',
      assignee: '<b>x</b>',
      url: 'https://jira.example.com/browse/ABC-123456789012',
      spentText: '0 h',
    },
  });
  await settle();
  const jc = await ev(() => {
    const c = document.querySelector('.jcard');
    return { hidden: c.hidden, imgs: c.querySelectorAll('img,svg,b').length, text: c.textContent.slice(0, 120) };
  });
  ok('a Jira card with hostile summary/status/assignee is text', jc.imgs === 0, jc);

  // a status / toast with html is text (the page template itself carries a couple of svg icons: take a baseline)
  const baselineIcons = await ev(() => document.querySelectorAll('body img:not(#log img), body svg').length);
  await send({ type: 'status', text: '<img src=x onerror=pwn("status")>' });
  await send({ type: 'toast', message: '<svg onload=pwn("toast")>' });
  await send({ type: 'elsewhere', count: 1, thread: 'm0', author: '<b>a</b>', snippet: '<img src=x onerror=pwn("ew")>' });
  await send({ type: 'working', items: [{ name: '<img src=x onerror=pwn("w")>', isAgent: true, real: true }], busy: [], channel: [] });
  await send({ type: 'agentsOffline', offline: true, names: ['<img src=x onerror=pwn("ao")>'] });
  await settle();
  const after = await ev(() => ({
    xss: window.__xss,
    what: window.__xssWhat,
    imgs: document.querySelectorAll('body img:not(#log img), body svg').length,
    handlers: [...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].filter((a) => /^on/i.test(a.name)).map((a) => e.tagName + ' ' + a.name)),
  }));
  ok('status, toast, elsewhere, working and agentsOffline with html are text', after.imgs === baselineIcons && after.handlers.length === 0 && after.xss === 0, {
    ...after,
    baselineIcons,
  });

  // a second render of the same thread (live refresh) and switching away must stay fast
  const t3 = Date.now();
  await send({ type: 'thread', id: 'm0', title: 't', items });
  await settle();
  const t4 = Date.now();
  await ev(() => 1);
  ok(`re-rendering the hostile thread stays responsive (${t4 - t3} ms, ping ${Date.now() - t4} ms)`, Date.now() - t4 < 1000);
  await send({ type: 'thread', id: null, title: '', items: [] });
  ok('leaving the thread clears it', (await ev(() => document.querySelectorAll('#log article.msg').length)) === 0);

  const finalXss = await ev(() => ({ n: window.__xss, what: window.__xssWhat }));
  ok('window.__xss is still 0 at the end', finalXss.n === 0, finalXss);
  ok('no pageerror / console.error during the whole run', errors.length === 0, errors.slice(0, 5));
  await browser.close();
  ok('no unhandled rejection / uncaught exception in the harness process', unexpected.length === 0, unexpected);

  console.log('\nname | src bytes | html bytes | render ms');
  for (const m of metrics) console.log(`${m.name} | ${m.srcBytes} | ${m.htmlBytes} | ${m.renderMs}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  clearTimeout(hardStop);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  console.log('FAIL harness crashed: ' + (e && e.message));
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
