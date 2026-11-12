import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  channelOf,
  composeCodeMessage,
  fenceFor,
  friendlyError,
  BuzzError,
  initials,
  looksLikeEvent,
  eventPage,
  rowsSent,
  ReportedRows,
  cleanDrafts,
  isCertificateError,
  isValidKey,
  looksLikeAgent,
  normalizeRelay,
  parseCliFailure,
  parseFileRef,
  privateKeyHex,
  pubkeyFromPrivate,
  relayFromAgentsMd,
  replyRootOf,
  sanitizeKey,
  groupThreads,
  advanceCursor,
  cliCandidates,
  cliName,
  desktopCandidates,
  groupDmRows,
  gitRefsIn,
  plainSnippet,
  publicRepoUrl,
  truncateBytes,
  chipColor,
  codeBlock,
  contextLabel,
  formatHours,
  parsePresence,
  parseTyping,
  replyParentOf,
  threadOrder,
  deletedIdsOf,
  reconcilePage,
} from '../core';
import { setLang } from '../i18n';

test('relay address is read from the AGENTS.md line as http', () => {
  const md = '## Workspace\n- Relay: ws://relay.example\n<!-- END -->';
  assert.equal(relayFromAgentsMd(md), 'http://relay.example');
  assert.equal(relayFromAgentsMd('something else'), undefined);
  assert.equal(normalizeRelay('wss://x.example/'), 'https://x.example');
});

test('Nostr key format and nsec decoding (NIP-19 test vector)', () => {
  const nsec = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
  assert.equal(privateKeyHex(nsec), '67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa');
  assert.ok(isValidKey(nsec));
  assert.ok(isValidKey('ab'.repeat(32)));
  assert.ok(!isValidKey(nsec.slice(0, -1) + 'q')); // broken checksum
  assert.ok(!isValidKey('nsec1short'));
  assert.ok(!isValidKey('npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'));
  assert.ok(!isValidKey('00'.repeat(32))); // the zero key is invalid
  assert.ok(!isValidKey(''));
});

test('pure JS derivation matches Node secp256k1; core does not use crypto (VS Code/Electron compatibility)', () => {
  for (let i = 0; i < 20; i++) {
    const hex = randomBytes(32).toString('hex');
    const e = createECDH('secp256k1');
    e.setPrivateKey(Buffer.from(hex, 'hex'));
    assert.equal(pubkeyFromPrivate(hex), e.getPublicKey('hex', 'compressed').slice(2));
  }
  const src = readFileSync(join(__dirname, '..', 'core.js'), 'utf8');
  assert.ok(!/require\(["'](node:)?crypto["']\)/.test(src));
});

test('whitespace, invisible characters and quotes are removed from a pasted key', () => {
  const nsec = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
  assert.equal(sanitizeKey(` "${nsec}"${'\u200B'}\n`), nsec);
  assert.ok(isValidKey(` ${nsec}${'\u200B'}\r\n`));
});

test('public key is derived from the private key (BIP-340 test vectors)', () => {
  assert.equal(pubkeyFromPrivate('0'.repeat(63) + '3'), 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');
  assert.equal(
    pubkeyFromPrivate('B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF'),
    'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659',
  );
});

test('CLI failure output is parsed; non-JSON text is handled too', () => {
  const e = parseCliFailure(3, '', '{"error":"auth_error","message":"auth error: BUZZ_PRIVATE_KEY is required","retryable":false}\n');
  assert.equal(e.code, 3);
  assert.equal(e.category, 'auth_error');
  assert.match(friendlyError(e), /check your Nostr key/);
  const n = parseCliFailure(2, '', 'connection refused\n');
  assert.equal(n.category, 'unknown');
  assert.match(friendlyError(n), /Can't reach the relay/);
  assert.match(friendlyError(new BuzzError(1, 'user_error', 'missing')), /Request rejected: missing/);
  setLang('tr');
  try {
    assert.match(friendlyError(e), /Nostr anahtarını kontrol et/);
  } finally {
    setLang('en');
  }
});

test('the code fence is longer than any backtick run in the code', () => {
  assert.equal(fenceFor('a = 1'), '```');
  assert.equal(fenceFor('x ``` y'), '````');
  const m = composeCodeMessage(['review_agent_claude'], 'can you check?', {
    relPath: 'pipeline/steps/rollup.py',
    startLine: 10,
    endLine: 12,
    languageId: 'python',
    code: 'print("```")\n',
  });
  assert.equal(m, '@review_agent_claude can you check?\n\n`pipeline/steps/rollup.py:L10-L12`\n````python\nprint("```")\n````');
  const single = composeCodeMessage([], '', { relPath: 'a.ts', startLine: 5, endLine: 5, languageId: 'typescriptreact', code: 'x' });
  assert.equal(single, '`a.ts:L5`\n```tsx\nx\n```');
});

test('file reference: path and line; a bare file name or a version number is not a reference', () => {
  assert.deepEqual(parseFileRef('pipeline/steps/rollup.py:142'), { path: 'pipeline/steps/rollup.py', line: 142, end: undefined });
  assert.deepEqual(parseFileRef('a.sql:L10-L20'), { path: 'a.sql', line: 10, end: 20 });
  assert.deepEqual(parseFileRef('sql\\order_status.sql'), { path: 'sql/order_status.sql', line: undefined, end: undefined });
  assert.equal(parseFileRef('order_status.sql'), undefined);
  assert.equal(parseFileRef('order_id'), undefined);
  assert.equal(parseFileRef('1.2.3'), undefined);
  assert.equal(parseFileRef('pytest etl/tests -q'), undefined);
});

test('messages are grouped into threads: root + replies, nested reply, thread with an older root, latest activity first', () => {
  const ev = (id: string, t: number, tags: string[][] = []) => ({ id, pubkey: 'p', kind: 9, content: id, created_at: t, tags: [['h', 'k'], ...tags] });
  const evs = [
    ev('A', 100),
    ev('B', 110),
    ev('a1', 120, [['e', 'A', '', 'root']]),
    ev('a2', 130, [['e', 'a1', '', 'reply']]), // only a 'reply' marker; the parent is itself a reply
    ev('x1', 140, [['e', 'OLD', '', 'root']]), // thread whose root isn't loaded
    ev('b1', 105, [
      ['e', 'B', '', 'root'],
      ['e', 'B', '', 'reply'],
    ]),
  ];
  const g = groupThreads(evs);
  assert.deepEqual(
    g.map((x) => x.id),
    ['OLD', 'A', 'B'],
  );
  assert.equal(g[0].root, undefined);
  assert.deepEqual(
    g[1].replies.map((x) => x.id),
    ['a1', 'a2'],
  );
  assert.equal(g[1].last, 130);
  assert.deepEqual(
    g[2].replies.map((x) => x.id),
    ['b1'],
  );
  assert.equal(g[2].last, 110);
});

test('summary text has no markdown; channel color is stable', () => {
  assert.equal(plainSnippet('**Plan**: `order_status.sql` [link](http://x) see\n```py\nprint(1)\n```\n> note'), 'Plan: order_status.sql link see [code] note');
  assert.equal(plainSnippet('a'.repeat(300), 10), 'aaaaaaaaaa');
  assert.equal(chipColor('channel-1'), chipColor('channel-1'));
  assert.ok(chipColor('x') >= 0 && chipColor('x') < 6);
});

test('tags: channel, thread root, agent, initials', () => {
  const ev = {
    tags: [
      ['h', 'channel-1'],
      ['e', 'root', '', 'root'],
      ['e', 'parent', '', 'reply'],
      ['p', 'x'],
    ],
  };
  assert.equal(channelOf(ev), 'channel-1');
  assert.equal(replyRootOf(ev), 'root');
  assert.equal(replyRootOf({ tags: [['e', 'parent', '', 'reply']] }), 'parent');
  assert.equal(replyRootOf({ tags: [] }), undefined);
  assert.ok(looksLikeAgent({}, 'review_agent_claude'));
  assert.ok(looksLikeAgent({ bot: true }, 'Fizz'));
  assert.ok(!looksLikeAgent({}, 'Ada Lovelace'));
  assert.equal(initials('ada lovelace'), 'AL');
  assert.equal(initials('review_agent_claude'), 'RA');
});

test('presence output is read in several shapes; unknown shapes give nothing', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const C = 'c'.repeat(64);
  assert.deepEqual(
    parsePresence([
      { pubkey: A, status: 'online' },
      { pubkey: B, status: 'away' },
      { pubkey: C, status: 'offline' },
    ]),
    { [A]: 'online', [B]: 'away', [C]: 'offline' },
  );
  assert.deepEqual(parsePresence({ [A]: 'online', [B]: { status: 'idle' } }), { [A]: 'online', [B]: 'away' });
  assert.deepEqual(parsePresence({ presence: [{ pubkey: A, online: true }] }), { [A]: 'online' });
  assert.deepEqual(parsePresence(null), {});
  assert.deepEqual(parsePresence('online'), {});
  assert.deepEqual(parsePresence([{ pubkey: 'short', status: 'online' }]), {});
});

test('typing signals: channel, thread and stop', () => {
  const base = {
    id: 'x',
    pubkey: 'p'.repeat(64),
    kind: 20002,
    created_at: 1,
    content: '',
    tags: [
      ['h', 'ch'],
      ['e', 'root', '', 'root'],
    ],
  };
  assert.deepEqual(parseTyping(base), { pubkey: 'p'.repeat(64), channel: 'ch', thread: 'root', active: true });
  assert.equal(parseTyping({ ...base, content: 'stop' })?.active, false);
  assert.equal(parseTyping({ ...base, content: '{"typing":false}' })?.active, false);
  assert.equal(parseTyping({ ...base, content: '{"status":"thinking"}' })?.active, true);
  assert.equal(parseTyping({ ...base, tags: [['h', 'ch']] })?.thread, undefined);
  assert.equal(parseTyping({ ...base, kind: 9 }), undefined);
});

test('errors and terminal output are formatted for the agent; chip labels', () => {
  const err = codeBlock({
    kind: 'error',
    relPath: 'etl/a.py',
    startLine: 9,
    endLine: 15,
    languageId: 'python',
    code: 'x = y\n',
    message: 'line 12: "y" is not defined (Pylance reportUndefinedVariable)',
  });
  assert.equal(err, '**Error**\n> line 12: "y" is not defined (Pylance reportUndefinedVariable)\n\n`etl/a.py:L9-L15`\n```python\nx = y\n```');
  const term = codeBlock({ kind: 'terminal', relPath: '', startLine: 0, endLine: 0, languageId: 'text', code: 'Traceback\n  KeyError\n', message: 'pwsh' });
  assert.equal(term, '**Terminal output** (pwsh)\n```text\nTraceback\n  KeyError\n```');
  assert.equal(contextLabel({ kind: 'error', relPath: 'etl/a.py', startLine: 9, endLine: 15, languageId: 'python', code: '' }), 'Error · a.py:9-15');
  assert.equal(contextLabel({ relPath: 'etl/a.py', startLine: 3, endLine: 3, languageId: 'python', code: '' }), 'a.py:3');
  assert.equal(
    contextLabel({ kind: 'terminal', relPath: '', startLine: 0, endLine: 0, languageId: 'text', code: '', message: 'bash' }),
    'Terminal output · bash',
  );
});

test('hours follow the UI language', () => {
  assert.equal(formatHours(9000), '2.5 h');
  setLang('tr');
  try {
    assert.equal(formatHours(9000), '2,5 sa');
  } finally {
    setLang('en');
  }
});

test('thread order: a reply sits under the message it answers, like Buzz Desktop', () => {
  const ev = (id: string, ts: number, tags: string[][] = []) => ({ id, pubkey: 'p', kind: 9, content: id, created_at: ts, tags: [['h', 'k'], ...tags] });
  const root = ev('R', 100);
  const lead = ev('L', 110, [['e', 'R', '', 'root']]); // lead answers the thread
  const human = ev('S', 120, [['e', 'R', '', 'root']]); // a person answers the thread, 2 minutes before Jira
  const jira = ev('J', 130, [
    ['e', 'R', '', 'root'],
    ['e', 'L', '', 'reply'],
  ]); // Jira answers the lead
  const lead2 = ev('L2', 140, [
    ['e', 'R', '', 'root'],
    ['e', 'J', '', 'reply'],
  ]); // the lead answers Jira
  const orphan = ev('O', 125, [
    ['e', 'R', '', 'root'],
    ['e', 'MISSING', '', 'reply'],
  ]);
  const order = threadOrder(root, [lead2, jira, human, lead, orphan]);
  assert.deepEqual(
    order.map((x) => [x.ev.id, x.depth, x.parent]),
    [
      ['R', 0, undefined],
      ['L', 0, undefined],
      ['J', 1, 'L'],
      ['L2', 2, 'J'],
      ['S', 0, undefined],
      ['O', 0, undefined],
    ],
  );
  assert.equal(replyParentOf(jira), 'L');
  assert.equal(replyParentOf(human), 'R');
  // without the root loaded, top-level replies still come first in time order
  assert.deepEqual(
    threadOrder(undefined, [human, jira, lead]).map((x) => x.ev.id),
    ['L', 'J', 'S'],
  );
});

test('deletion events name the removed messages; other events are not deletions', () => {
  const id = 'ab'.repeat(32);
  assert.deepEqual(
    deletedIdsOf({
      kind: 5,
      tags: [
        ['e', id],
        ['k', '9'],
      ],
    }),
    [id],
  );
  assert.deepEqual(
    deletedIdsOf({
      kind: 9005,
      tags: [
        ['h', 'ch'],
        ['e', id.toUpperCase()],
      ],
    }),
    [id],
  );
  assert.equal(deletedIdsOf({ kind: 9, tags: [['e', id]] }), undefined);
});

test('a fresh page drops messages deleted elsewhere and picks up edits, without touching what it does not cover', () => {
  const ev = (id: string, ts: number, content = id) => ({ id, pubkey: 'p', kind: 9, content, created_at: ts, tags: [['h', 'k']] });
  const known = new Map([ev('old', 10), ev('a', 100), ev('b', 110), ev('fromThread', 120), ev('c', 130)].map((e) => [e.id, e] as const));
  const seen = new Set(['old', 'a', 'b', 'c']); // 'fromThread' came from a thread fetch, never from a page
  // full page (size 3) covering 100..130: 'b' was deleted, 'c' was edited
  const r = reconcilePage(known, [ev('a', 100), ev('c', 130, 'c edited'), ev('d', 140)], seen);
  assert.deepEqual(r.removed, ['b']); // 'old' is outside the window, 'fromThread' was never on a page
  assert.deepEqual(
    r.edited.map((e) => [e.id, e.content]),
    [['c', 'c edited']],
  );
  // a short page may be the relay's cap: what is newer than its oldest message is judged, nothing older ('old' stays)
  assert.deepEqual(reconcilePage(known, [ev('a', 100)], seen).removed, ['b', 'c']);
  assert.deepEqual(reconcilePage(known, [ev('a', 100), ev('c', 130)], seen).removed, ['b']);
  // an empty page (e.g. a failed read) removes nothing
  assert.deepEqual(reconcilePage(known, [], seen).removed, []);
});

test('snippets stay fast on adversarial messages', () => {
  const t0 = Date.now();
  plainSnippet('!['.repeat(32500));
  plainSnippet('['.repeat(65000));
  plainSnippet('[a]('.repeat(16250));
  assert.ok(Date.now() - t0 < 300, `took ${Date.now() - t0} ms`);
  assert.equal(plainSnippet('see [the doc](https://x.y) and ![pic](a.png)'), `see the doc and [${'image'}]`.replace('[image]', plainSnippet('![p](a.png)')));
});

test('the repository address sent with a diff never carries credentials; ssh remotes become https', () => {
  assert.equal(publicRepoUrl('https://oauth2:glpat-SECRET@gitlab.example.com/org/repo.git'), 'https://gitlab.example.com/org/repo.git');
  assert.equal(publicRepoUrl('https://user@github.com/org/repo.git?x=1#y'), 'https://github.com/org/repo.git');
  assert.equal(publicRepoUrl('git@github.com:org/repo.git'), 'https://github.com/org/repo.git');
  assert.equal(publicRepoUrl('ssh://git@bitbucket.example:7999/proj/repo.git'), 'https://bitbucket.example/proj/repo.git');
  assert.equal(publicRepoUrl(''), undefined);
  assert.equal(publicRepoUrl('C:/work/repo'), undefined);
  assert.equal(publicRepoUrl('C:\\work\\repo'), undefined);
  assert.equal(publicRepoUrl('/srv/git/repo.git'), undefined);
  assert.equal(publicRepoUrl('file:///C:/repo'), undefined);
});

test('text is cut to a UTF-8 size without splitting characters', () => {
  assert.equal(truncateBytes('abc', 10), 'abc');
  assert.equal(truncateBytes('şşş', 4), 'şş');
  assert.equal(truncateBytes('a😀b', 3), 'a');
  assert.equal(truncateBytes('a😀b', 5), 'a😀');
});

test('branches and commits an agent reports are found; a base mentioned in passing and code blocks are not', () => {
  assert.deepEqual(gitRefsIn("Dev düzeltme commit'i 9c4e2b7 (3d81a5e üstüne, aynı dal feature/abc-1201-rank-ties): yalnız docs"), {
    branches: ['feature/abc-1201-rank-ties'],
    commits: ['9c4e2b7'],
  });
  assert.deepEqual(gitRefsIn('Branch: feature/abc-1202-monthly-report (taban buzz 6b0f19d)'), { branches: ['feature/abc-1202-monthly-report'], commits: [] });
  assert.deepEqual(gitRefsIn('ABC-1203, merge e27c4a8 ile kaldırıldı'), { branches: [], commits: ['e27c4a8'] });
  assert.deepEqual(gitRefsIn('sonuç `a1b2c3d` commitinde'), { branches: [], commits: ['a1b2c3d'] });
  assert.deepEqual(gitRefsIn("Merge sonrası merge commit hash'ini yaz. Ölçümleri 3d81a5e ile sürdür."), { branches: [], commits: [] });
  assert.deepEqual(gitRefsIn(['```', 'git checkout feature/x', 'commit abc1234', '```', 'başka bir şey yok'].join('\n')), { branches: [], commits: [] });
  assert.deepEqual(gitRefsIn('commit edilmedi, 2026 dönemi'), { branches: [], commits: [] });
});

test('the Buzz CLI is looked for where Buzz Desktop installs it, then on PATH', () => {
  const c = cliCandidates(
    { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files', PATH: 'C:\\tools;C:\\bin\\' },
    'win32',
    'C:\\Users\\u',
  );
  assert.deepEqual(c, [
    'C:\\Users\\u\\AppData\\Local\\Buzz\\buzz.exe',
    'C:\\Users\\u\\AppData\\Local\\Programs\\Buzz\\buzz.exe',
    'C:\\Program Files\\Buzz\\buzz.exe',
    'C:\\tools\\buzz.exe',
    'C:\\bin\\buzz.exe',
  ]);
});

test('on a Mac the CLI is looked for in ~/.local/bin first, then the Buzz app, the usual folders and PATH', () => {
  const c = cliCandidates({ PATH: '/usr/bin:/opt/tools/' }, 'darwin', '/Users/u', ['/Applications/Buzz Desktop.app']);
  assert.equal(c[0], '/Users/u/.local/bin/buzz');
  assert.equal(c[1], '/Applications/Buzz Desktop.app/Contents/MacOS/buzz');
  assert.ok(c.includes('/Applications/Buzz.app/Contents/MacOS/buzz'));
  assert.ok(c.includes('/Users/u/Applications/Buzz.app/Contents/MacOS/buzz'));
  assert.ok(c.includes('/opt/homebrew/bin/buzz'));
  assert.deepEqual(c.slice(-2), ['/usr/bin/buzz', '/opt/tools/buzz']);
  assert.equal(cliName('darwin'), 'buzz');
  assert.equal(cliName('win32'), 'buzz.exe');
  assert.ok(cliCandidates({}, 'linux', '/home/u').includes('/usr/bin/buzz'));
});

test('the mention cursor moves to the latest second and remembers the ids seen in it', () => {
  const ev = (id: string, ts: number) => ({ id, pubkey: 'p', kind: 9, content: '', created_at: ts, tags: [] });
  const first = advanceCursor({ since: 100, ids: [] }, [ev('a', 100), ev('b', 105), ev('c', 105), ev('old', 99)]);
  assert.deepEqual(
    first.fresh.map((e) => e.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(first.next, { since: 105, ids: ['b', 'c'] });
  // the same second again: only what was not seen
  const second = advanceCursor(first.next, [ev('b', 105), ev('c', 105), ev('d', 105)]);
  assert.deepEqual(
    second.fresh.map((e) => e.id),
    ['d'],
  );
  assert.deepEqual(second.next, { since: 105, ids: ['d', 'b', 'c'] });
  assert.deepEqual(advanceCursor(second.next, [ev('d', 105)]), { fresh: [], next: second.next });
});

test('Buzz Desktop is looked for next to the CLI on Windows, as an app bundle on a Mac, on PATH on Linux', () => {
  const w = desktopCandidates({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }, 'win32', 'C:\\Users\\u');
  assert.equal(w[0], 'C:\\Users\\u\\AppData\\Local\\Buzz\\buzz-desktop.exe');
  assert.ok(w.includes('C:\\Program Files\\Buzz\\buzz-desktop.exe'));
  const m = desktopCandidates({}, 'darwin', '/Users/u', ['/Applications/Buzz Desktop.app']);
  assert.deepEqual(m.slice(0, 2), ['/Applications/Buzz Desktop.app', '/Applications/Buzz.app']);
  const l = desktopCandidates({ PATH: '/usr/bin:/opt/tools/' }, 'linux', '/home/u');
  assert.ok(l.includes('/home/u/.local/bin/buzz-desktop') && l.includes('/opt/tools/buzz-desktop'));
});

test('DM conversations with the same people become one group, newest first; repeated rows count once', () => {
  const g = groupDmRows([
    { id: 'd1', peers: ['A'], created: 100 },
    { id: 'd2', peers: ['A'], created: 300 },
    { id: 'd2', peers: ['A'], created: 300 }, // the list repeated it
    { id: 'd3', peers: ['B', 'A'], created: 200 },
    { id: 'd4', peers: ['A', 'B'], created: 250, name: 'trio' },
    { id: 'd5', peers: [], created: 50 },
    { id: 'd6', peers: [], created: 60 },
  ]);
  assert.deepEqual(
    g.map((x) => ({ ids: x.ids, peers: x.peers, name: x.name })),
    [
      { ids: ['d2', 'd1'], peers: ['A'], name: undefined },
      { ids: ['d4', 'd3'], peers: ['A', 'B'], name: 'trio' },
      { ids: ['d5'], peers: [], name: undefined },
      { ids: ['d6'], peers: [], name: undefined },
    ],
  );
});

test('looksLikeEvent keeps CLI rows shaped like messages and drops the rest', () => {
  const ok = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), kind: 9, created_at: 1700000000, content: 'hi', tags: [['h', 'c1']] };
  assert.ok(looksLikeEvent(ok));
  assert.ok(!looksLikeEvent(null));
  assert.ok(!looksLikeEvent(undefined));
  assert.ok(!looksLikeEvent('x'));
  assert.ok(!looksLikeEvent({ ...ok, content: 42 }));
  assert.ok(!looksLikeEvent({ ...ok, pubkey: undefined }));
  assert.ok(!looksLikeEvent({ ...ok, created_at: undefined }));
  assert.ok(!looksLikeEvent({ ...ok, created_at: NaN }));
  assert.ok(!looksLikeEvent({ ...ok, tags: 'x' }));
  assert.ok(!looksLikeEvent({ ...ok, id: '' }));
  assert.ok(!looksLikeEvent({ ...ok, kind: '9' }));
});

test('eventPage keeps the count of dropped rows across layers; rowsSent judges a full page by it', () => {
  const ok = (n: number) => ({ id: String(n).padStart(64, 'a'), pubkey: 'b'.repeat(64), kind: 9, created_at: 1700000000 + n, content: 'm' + n, tags: [] });
  const raw = [ok(1), null, ok(2), { ...ok(3), content: 42 }, ok(4)];
  const page = eventPage(raw);
  assert.equal(page.length, 3);
  assert.equal(page.dropped, 2);
  assert.equal(rowsSent(page), 5);
  // a second layer that filters again adds its own drops to the first one's
  const again = eventPage([...page, null]);
  assert.equal(again.length, 3);
  assert.equal(again.dropped, 1);
  const carried = eventPage(page);
  assert.equal(carried.dropped, 2);
  assert.equal(rowsSent(carried), 5);
  assert.equal(eventPage([ok(1)]).dropped, undefined);
  assert.deepEqual(eventPage('not a list'), []);
  assert.equal(rowsSent([]), 0);
});

test('ReportedRows reports each malformed row once, whichever read brings it back; eventPage hands them over', () => {
  const r = new ReportedRows(3);
  const bad: unknown[] = [];
  const good = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), kind: 9, created_at: 1, content: 'x', tags: [] };
  eventPage([good, null, { ...good, content: 42 }], bad);
  assert.equal(bad.length, 2);
  assert.equal(r.fresh(bad), 2);
  assert.equal(r.fresh(bad), 0, 'the same rows again: nothing new');
  assert.equal(
    r.fresh([
      { ...good, content: 42 },
      { ...good, created_at: 'x' },
    ]),
    1,
    'one known, one new',
  );
  assert.equal(r.fresh([{ ...good, id: 'c'.repeat(64), content: 43 }]), 1); // a fourth row: the oldest is forgotten
  assert.equal(r.fresh([null]), 1, 'forgotten past the limit, reported again');
  assert.equal(r.fresh([]), 0);
});

test('a malformed row too deeply nested to write out is still counted once, without failing the read', () => {
  let deep: unknown = 'x';
  for (let i = 0; i < 20000; i++) deep = [deep];
  const r = new ReportedRows();
  assert.equal(r.fresh([{ id: 'bad', deep }]), 1);
  assert.equal(r.fresh([{ id: 'bad', deep }]), 0);
});

test('cleanDrafts keeps the newest drafts, checked: text, mentions, reply target; empty and malformed ones dropped', () => {
  const ok = cleanDrafts({
    'c:t1': { text: 'half a reply', mentions: [['Ada', 'pk'], ['bad'], [1, 2]], replyTo: { id: 'm1', author: 'Ada', snippet: 'hi' }, at: 3 },
    'c:new': { text: 'a new thread', at: 2, replyTo: { id: 5 } },
    'c:empty': { text: '  \n ', at: 9 },
    'c:number': { text: 42, at: 9 },
    'c:null': null,
    ['k'.repeat(301)]: { text: 'key too long', at: 9 },
  });
  assert.deepEqual(Object.keys(ok), ['c:t1', 'c:new'], 'newest first; the rest dropped');
  assert.deepEqual(ok['c:t1'].mentions, [['Ada', 'pk']]);
  assert.deepEqual(ok['c:t1'].replyTo, { id: 'm1', author: 'Ada', snippet: 'hi' });
  assert.equal(ok['c:new'].replyTo, undefined, 'a reply target without its fields is dropped');
  const many: Record<string, unknown> = {};
  for (let i = 0; i < 40; i++) many['k' + i] = { text: 't' + i, at: i };
  const kept = cleanDrafts(many);
  assert.equal(Object.keys(kept).length, 30);
  assert.ok(kept.k39 && kept.k10 && !kept.k9);
  assert.equal(cleanDrafts({ a: { text: 'x'.repeat(70000) } }).a.text.length, 65536);
  for (const junk of [undefined, null, 'x', 7, [], [{ text: 'a' }]]) assert.deepEqual(cleanDrafts(junk), {});
});

test('isCertificateError tells an untrusted certificate from other connection failures', () => {
  for (const code of [
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ]) {
    assert.ok(isCertificateError({ code, message: 'x' }), code);
  }
  assert.ok(isCertificateError(new Error('self-signed certificate in certificate chain')));
  for (const e of [
    { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:443' },
    { code: 'ETIMEDOUT' },
    new Error('socket hang up'),
    null,
    'certificate',
    7,
  ]) {
    assert.equal(isCertificateError(e), false, JSON.stringify(e));
  }
});
