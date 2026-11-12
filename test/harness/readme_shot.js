// README screenshot: the real chat webview (template, chat.css, chat.js) with VS Code's light theme variables,
// English strings and neutral sample data, rendered headless at 2x.
const fs = require('fs');
const path = require('path');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');
const OUT = process.argv[3];
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

// VS Code "Light Modern" values for the variables chat.css uses
const theme = `
:root {
  --vscode-font-family: "Segoe WPC", "Segoe UI", system-ui, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Consolas, "Cascadia Mono", "Courier New", monospace;
  --vscode-editor-font-size: 13px;
  --vscode-foreground: #3b3b3b;
  --vscode-descriptionForeground: #6f6f6f;
  --vscode-textLink-foreground: #005fb8;
  --vscode-panel-border: #e5e5e5;
  --vscode-widget-border: #e5e5e5;
  --vscode-focusBorder: #005fb8;
  --vscode-editor-background: #ffffff;
  --vscode-sideBar-background: #f8f8f8;
  --vscode-editorWidget-background: #f8f8f8;
  --vscode-textCodeBlock-background: #f3f3f3;
  --vscode-textBlockQuote-border: #005fb8;
  --vscode-button-foreground: #ffffff;
  --vscode-button-background: #005fb8;
  --vscode-button-secondaryForeground: #3b3b3b;
  --vscode-button-secondaryBackground: #e5e5e5;
  --vscode-badge-foreground: #3b3b3b;
  --vscode-badge-background: #e1e1e1;
  --vscode-toolbar-hoverBackground: rgba(184, 184, 184, 0.31);
  --vscode-list-activeSelectionForeground: #000000;
  --vscode-list-activeSelectionBackground: #e8e8e8;
  --vscode-list-hoverBackground: #f2f2f2;
  --vscode-input-background: #ffffff;
  --vscode-input-foreground: #3b3b3b;
  --vscode-input-placeholderForeground: #767676;
  --vscode-quickInput-foreground: #3b3b3b;
  --vscode-errorForeground: #e51400;
  --vscode-inputValidation-errorBorder: #be1100;
  --vscode-inputValidation-errorBackground: #f2dede;
}`;
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${theme}</style><style>${fs.readFileSync(path.join(PROJ, 'media/chat.css'), 'utf8')}</style>
<script>window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(m),getState:()=>({}),setState:()=>{}});</script>
</head><body class="app vscode-light">${body}<script>${fs.readFileSync(path.join(PROJ, 'media/chat.js'), 'utf8')}</script></body></html>`;
const file = path.join(require('os').tmpdir(), 'readme_shot.html');
fs.writeFileSync(file, html);

// ---- sample data: a made-up online marketplace's analytics team, the same story as the demo video (SHOP issue keys)
const { chipColor } = require(path.join(PROJ, 'out/core.js'));
const md = (text) => renderMarkdown(text, { jiraUrl: 'https://jira.example.com', jiraKeys: ['SHOP'] });
const now = Math.floor(Date.now() / 1000);
const day = 86400;
const P = { me: 'me', lead: 'lead', jira: 'jira', review: 'review', dev: 'dev', qa: 'qa' };
const people = {
  me: { name: 'You', initials: 'YO', isAgent: false },
  lead: { name: 'lead_agent', initials: 'LE', isAgent: true },
  jira: { name: 'jira_agent', initials: 'JI', isAgent: true },
  review: { name: 'review_agent', initials: 'RE', isAgent: true },
  dev: { name: 'dev_agent', initials: 'DE', isAgent: true },
  qa: { name: 'qa_agent', initials: 'QA', isAgent: true },
};
const who = (k) => ({ pubkey: P[k], author: people[k].name, initials: people[k].initials, isAgent: people[k].isAgent, isMe: k === 'me' });
const part = (k) => ({ pubkey: P[k], name: people[k].name, initials: people[k].initials, isAgent: people[k].isAgent });
const row = (id, k, ts, snippet, replies, last, ppl) => ({
  id,
  ...who(k),
  snippet,
  replies,
  lastAuthor: last ? people[last].name : undefined,
  lastIsMe: last === 'me',
  people: ppl.map(part),
  time: new Date(ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
  ts,
});
const threads = [
  row('t1', 'me', now - 600, '@lead_agent SHOP-142: can you plan the fix for the seller ranking?', 4, 'lead', ['me', 'lead', 'jira', 'review']),
  row('t2', 'qa', now - 3 * 3600, 'Nightly regression finished: 412/412 green · coverage 96.7%', 1, 'me', ['qa', 'me']),
  row(
    't3',
    'lead',
    now - day - 7200,
    '[SHOP-157] Finding 41: REFUND_STATUS counts returns within 30 days as in window; the returns policy says 14. Window: sql/refunds.sql:18-20',
    2,
    'me',
    ['lead', 'jira', 'me'],
  ),
  row('t4', 'lead', now - day - 5 * 3600, 'Release 2.4 goes out on Thursday at 18:00 UTC. Anything still blocking it?', 3, 'dev', ['lead', 'dev', 'me']),
  row('t5', 'dev', now - 2 * day, 'Seller base counts completed orders only: sql/seller_base.sql:18 · tests green.', 0, undefined, ['dev']),
];
const msg = (id, k, ts, text, extra = {}) => ({
  id,
  ...who(k),
  isRoot: false,
  time: new Date(ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
  ts,
  html: md(text),
  patches: [],
  depth: 0,
  snippet: text.slice(0, 80),
  ...extra,
});
const diff = [
  '```diff',
  '- df = df.sort_values(["score"], ascending=False)',
  '+ df = df.sort_values(["score", "seller_id"], ascending=[False, True])',
  '```',
].join('\n');
const items = [
  msg('m1', 'me', now - day - 1800, '@lead_agent SHOP-142: can you plan the fix for the seller ranking?', { isRoot: true }),
  msg(
    'm2',
    'lead',
    now - day - 1700,
    'Here is the plan:\n\n1. **Dev**: `sql/seller_base.sql:18` count completed orders only\n2. **Review**: `pipeline/steps/seller_score.py` check the ordering\n\n@jira_agent can you read the SHOP-142 description?',
  ),
  msg('m3', 'jira', now - day - 1500, '[SHOP-142] Status: **In Test** · Acceptance: sellers with equal scores keep a stable order.', {
    depth: 1,
    parentId: 'm2',
    parentAuthor: 'lead_agent',
  }),
  msg('m4', 'me', now - 600, '@review_agent can you check the scoring step?'),
  msg('m5', 'review', now - 420, '`pipeline/steps/seller_score.py:142` sellers with equal scores do not keep a stable order. Proposal:\n\n' + diff, {
    patches: [{ block: 0, files: ['pipeline/steps/seller_score.py'], local: false }],
  }),
  msg(
    'm6',
    'lead',
    now - 60,
    '[SHOP-142] Dev applied the fix, review approved.\nBranch: feature/shop-142-stable-ranking · commit 4f2ea21\nWaiting on you: the merge approval.',
    {
      git: { branches: ['feature/shop-142-stable-ranking'], commits: ['4f2ea21c0ffee0ddba11f00d5eedc0de1234abcd'] },
    },
  ),
];

(async () => {
  const browser = await puppeteer.launch(require('./browser').launchOptions(['--hide-scrollbars', '--font-render-hinting=none', '--force-color-profile=srgb']));
  const pg = await browser.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.setViewport({ width: 1180, height: 760, deviceScaleFactor: 2 });
  await pg.goto('file:///' + file.split(path.sep).join('/'));
  const send = (m) => pg.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), m);
  await send({ type: 'i18n', lang: 'en', strings: S });
  await send({ type: 'live', state: 'live' });
  await send({
    type: 'channels',
    ready: true,
    items: [
      { id: 'A', name: 'marketplace-dev', isDm: false, color: chipColor('c-market') },
      { id: 'B', name: 'data-platform', isDm: false, color: chipColor('c-platform') },
      { id: 'C', name: 'sprint-reports', isDm: false, color: chipColor('c-sprint') },
      { id: 'D', name: 'releases', isDm: false, color: chipColor('c-releases') },
      { id: 'E', name: 'review_agent', isDm: true, color: 0, peer: P.review },
    ],
  });
  await send({ type: 'channel', id: 'A', name: 'marketplace-dev', isDm: false, color: chipColor('c-market') });
  await send({
    type: 'members',
    items: Object.keys(people)
      .filter((k) => k !== 'me')
      .map((k) => ({ pubkey: P[k], name: people[k].name, isAgent: people[k].isAgent })),
  });
  await send({ type: 'presence', map: { lead: 'online', jira: 'online', review: 'online', dev: 'online', qa: 'away' } });
  await send({ type: 'threads', channelId: 'A', items: threads, initial: true });
  await send({ type: 'thread', id: 't1', title: threads[0].snippet, items });
  await send({ type: 'working', items: [{ name: 'dev_agent', isAgent: true, real: true }], busy: ['t1'], channel: [] });
  await pg.evaluate(() => {
    const input = document.getElementById('input');
    input.value = '@dev_agent ';
    input.dispatchEvent(new Event('input'));
    const log = document.getElementById('log');
    log.scrollTop = log.scrollHeight;
  });
  await new Promise((r) => setTimeout(r, 300));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await pg.screenshot({ path: OUT });
  console.log(`wrote ${OUT}; page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
