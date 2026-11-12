import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLang } from '../i18n';
import {
  LensMessage,
  anchorLine,
  codeIdentifiers,
  describeShape,
  fileQuery,
  searchTexts,
  groupLens,
  hasResults,
  mentionsFile,
  parseSearch,
  pathWords,
  relTime,
  wordIndex,
} from '../lensCore';

const CH = 'chan-backend';
const ROOT = 'r'.repeat(64);
const LEAD = 'b'.repeat(64);
const JIRA = 'c'.repeat(64);
const ev = (id: string, pubkey: string, ts: number, content: string, root = ROOT) => ({
  id,
  pubkey,
  kind: 9,
  created_at: ts,
  content,
  tags: [['h', CH], ...(id === root ? [] : [['e', root, '', 'root']])],
});

const SQL = [
  'WITH ORDER_REFUNDS AS (',
  '    SELECT',
  '        R.ORDER_ID,',
  '        CASE',
  "            WHEN R.DAYS_AFTER_DELIVERY <= 30 THEN 'In window'",
  "            WHEN R.DAYS_AFTER_DELIVERY > 30 THEN 'Late'",
  '        END AS REFUND_STATUS',
  '    FROM SHOP.REFUNDS R',
  ')',
  'SELECT REFUND_STATUS, COUNT(*) FROM ORDER_REFUNDS GROUP BY REFUND_STATUS',
];

test('search output is read in several shapes', () => {
  const e = ev('a'.repeat(64), LEAD, 100, 'see sql/monthly_sales.sql');
  assert.equal(parseSearch([e])[0].channel, CH);
  assert.equal(parseSearch({ results: [{ event: e }] })[0].root, ROOT);
  assert.equal(parseSearch({ messages: [{ id: 'x', content: 'y', channel_id: 'c1', created_at: 5 }] })[0].channel, 'c1');
  assert.deepEqual(parseSearch(null), []);
  assert.deepEqual(parseSearch([{ id: 'no-content', tags: [['h', 'c']], created_at: 1 }]), []);
});

test('the search text is the file name without its extension', () => {
  assert.equal(fileQuery('reports/sql/monthly_sales.sql'), 'monthly_sales');
  assert.equal(fileQuery('a/x.py'), 'x.py');
});

test('a message mentions the file by bare name or a fitting path, with line numbers; another folder with the same name does not count', () => {
  const p = ['reports/sql/monthly_sales.sql'];
  assert.deepEqual(mentionsFile('dosya: sql/monthly_sales.sql', p), { lines: [] });
  assert.deepEqual(mentionsFile('bak `sql/monthly_sales.sql:22` ve monthly_sales.sql:L30-L35', p), { lines: [22, 30] });
  assert.deepEqual(mentionsFile('Monthly_Sales.SQL dosyasında', p), { lines: [] });
  assert.equal(mentionsFile('other/monthly_sales.sql:4', p), undefined);
  assert.equal(mentionsFile('monthly_sales.sqlx', p), undefined);
  assert.equal(mentionsFile('monthly_sales tablosu', p), undefined);
  // an earlier name of the file (git rename) also counts
  assert.deepEqual(mentionsFile('old_sales.sql:3', [...p, 'reports/sql/old_sales.sql']), { lines: [3] });
});

test('code names in a message ignore mentions and plain words', () => {
  const ids = codeIdentifiers('@lead_agent kaynaktaki REFUND_STATUS etiketi, ORDER_REFUNDS ve sortValues; SELECT normal kelime');
  assert.deepEqual(ids, ['REFUND_STATUS', 'ORDER_REFUNDS', 'sortValues']);
});

test('a thread is anchored at the most specific name it uses, otherwise at its line number', () => {
  // REFUND_STATUS is on 2 lines, ORDER_ID on 1: the rarer one wins; on a tie the first name wins
  assert.equal(anchorLine(SQL, ['REFUND_STATUS', 'ORDER_ID'], []), 2);
  assert.equal(anchorLine(SQL, ['REFUND_STATUS', 'DAYS_AFTER_DELIVERY'], []), 6);
  assert.equal(anchorLine(SQL, ['REFUND_STATUS'], [9]), 6);
  assert.equal(anchorLine(SQL, ['NOT_IN_FILE'], [6]), 5);
  assert.equal(anchorLine(SQL, [], [99]), undefined);
});

test('messages are grouped by thread with Jira key and title; unrelated messages are dropped', () => {
  const msgs: LensMessage[] = parseSearch([
    ev(ROOT, LEAD, 100, '[ABC-157] @lead_agent 14 günlük pencere yalnız docs/FINDINGS.md içinde; sql/monthly_sales.sql hâlâ 30 gün kullanıyor.'),
    ev('j'.repeat(64), JIRA, 160, '[ABC-157] JIRA: OKU TAMAM. Kaynaktaki REFUND_STATUS etiketi 14 gün diyor; dosya: sql/monthly_sales.sql'),
    ev('u'.repeat(64), JIRA, 170, 'monthly_sales tablosu hakkında genel not'),
    ev('o'.repeat(64), LEAD, 200, 'other/monthly_sales.sql:3 başka dosya', 'o'.repeat(64)),
  ]);
  const th = groupLens(msgs, ['reports/sql/monthly_sales.sql'], ['ABC']);
  assert.equal(th.length, 1);
  assert.equal(th[0].jira, 'ABC-157');
  assert.equal(th[0].messages.length, 2);
  assert.equal(th[0].last, 160);
  assert.ok(th[0].title.startsWith('14 günlük'), th[0].title);
  const at = anchorLine(SQL, codeIdentifiers(th[0].messages.map((m) => m.content).join('\n')), th[0].lines);
  assert.equal(at, 6); // "END AS REFUND_STATUS"
});

test('relative times follow the UI language', () => {
  const now = 1_800_000_000;
  assert.equal(relTime(now - 30, now), 'just now');
  assert.equal(relTime(now - 2 * 86400, now), '2 days ago');
  setLang('tr');
  try {
    assert.equal(relTime(now - 86400, now), 'dün');
    assert.equal(relTime(now - 3 * 3600, now), '3 sa önce');
  } finally {
    setLang('en');
  }
});

test('an output we cannot read is described by its field names only', () => {
  assert.equal(describeShape([{ uuid: 'x', text: 'secret content', group: 'g' }]), 'list of 1; first item: uuid, text, group');
  assert.equal(describeShape({ hits: [{ doc: 1 }], total: 1 }), 'object: hits, total; hits[0]: doc');
  assert.equal(describeShape([]), 'empty list');
  assert.ok(!describeShape([{ text: 'secret content' }]).includes('secret'));
  assert.ok(hasResults({ hits: [1] }) && !hasResults([]) && !hasResults(null));
});

test('the file name and its folders never anchor a thread (every message mentions them)', () => {
  const file = ['// UserCard component', 'export function UserCard(p) {', '  return p.name;', '}'];
  const skip = pathWords(['src/ui/UserCard.tsx']);
  const ids = codeIdentifiers('`src/ui/UserCard.tsx:3` has a bug').filter((w) => !skip.has(w.toLowerCase()));
  assert.equal(anchorLine(file, ids, [3]), 2);
  assert.ok(pathWords(['reports/sql/musteri_ozet.sql']).has('musteri_ozet'));
  assert.ok(pathWords(['reports/sql/musteri_ozet.sql']).has('reports'));
});

test('one word index answers every name: first line and the rarest name win', () => {
  const lines = ['SELECT A, B', 'CASE WHEN X_Y THEN 1', 'END AS ORDER_STATUS', 'SELECT ORDER_STATUS, X_Y'];
  const index = wordIndex(lines);
  assert.deepEqual(index.words.get('ORDER_STATUS'), { first: 2, count: 2 });
  assert.equal(anchorLine(index, ['X_Y', 'ORDER_STATUS'], []), 1);
  assert.equal(anchorLine(index, ['NOT_THERE'], [4]), 3);
  assert.equal(anchorLine(index, ['NOT_THERE'], [99]), undefined);
  assert.equal(anchorLine(['a9X_Y'], ['X_Y'], []), undefined); // part of a longer word is not a match
});

test('the search text names the file every way a message may write it, once per distinct name', () => {
  assert.deepEqual(searchTexts(['Reports/SQL/Monthly_Sales.sql']), ['Monthly_Sales OR Monthly_Sales.sql OR Reports/SQL/Monthly_Sales.sql']);
  assert.deepEqual(searchTexts(['db.py']), ['db.py']); // a short stem alone would match too much
  assert.deepEqual(searchTexts(['a/x.py', 'B/X.py']), ['x.py OR a/x.py']); // an earlier name with the same file name adds nothing new
  assert.deepEqual(searchTexts(['etl/new.py', 'etl/old.py']).length, 2);
});

test('Turkish İ and ı in a file name match in either case, and folders with other letters count as paths', () => {
  const p = ['sql/MÜŞTERİ_OZET.sql'];
  assert.deepEqual(mentionsFile('bak: MÜŞTERİ_OZET.sql:12', p), { lines: [12] });
  assert.deepEqual(mentionsFile('bak: müşteri_ozet.sql', p), { lines: [] });
  assert.deepEqual(mentionsFile('bak: sql/müşteri_ozet.sql', p), { lines: [] });
  assert.equal(mentionsFile('bak: raporlar/müşteri_ozet.sql', p), undefined); // another folder
  assert.deepEqual(mentionsFile('dosya ürünler/ÜRÜN_LİSTESİ.sql:3', ['ürünler/ürün_listesi.sql']), { lines: [3] });
});
