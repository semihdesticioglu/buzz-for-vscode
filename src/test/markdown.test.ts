import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeLang, extractBlocks, renderMarkdown } from '../markdown';

const ENV = { jiraUrl: 'https://jira.example', jiraKeys: ['ABC'] };

test('raw HTML is escaped (scripts do not run)', () => {
  const h = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(1)>', ENV);
  assert.ok(!h.includes('<script'));
  assert.ok(!h.includes('<img'));
  assert.ok(h.includes('&lt;script&gt;'));
});

test('a javascript: link is not linked', () => {
  const h = renderMarkdown('[click](javascript:alert(1))', ENV);
  assert.ok(!/href="javascript:/i.test(h));
});

test('@mentions are highlighted, but not inside code', () => {
  const h = renderMarkdown('@review_agent_claude can you check? `@in_code`', ENV);
  assert.ok(h.includes('<span class="mention">@review_agent_claude</span>'));
  assert.ok(h.includes('<code>@in_code</code>'));
});

test('code blocks are highlighted and numbered; language label and copy button are added', () => {
  const h = renderMarkdown('```python\ndef f(x):\n    return "a"  # note\n```', ENV);
  assert.ok(h.includes('<div class="code" data-block="0" data-lang="python">'));
  assert.ok(h.includes('<span class="hljs-keyword">def</span>'));
  assert.ok(h.includes('<span class="hljs-string">&quot;a&quot;</span>'));
  assert.ok(h.includes('<span class="hljs-comment"># note</span>'));
  assert.ok(h.includes('<span class="lang" lang="en">python</span>'));
  assert.ok(h.includes('class="copy"'));
  const sql = renderMarkdown("```sql\nSELECT 1 FROM t WHERE a = 'x'\n```", ENV);
  assert.ok(sql.includes('<span class="hljs-keyword">SELECT</span>'));
  const two = renderMarkdown('```js\na\n```\n\ntext\n\n```sql\nb\n```', ENV);
  assert.ok(two.includes('data-block="0"') && two.includes('data-block="1"'));
  // numbering restarts for every message
  assert.ok(renderMarkdown('```js\nc\n```', ENV).includes('data-block="0"'));
});

test('an untagged diff is recognised; an unknown language stays plain text and is escaped', () => {
  assert.equal(codeLang('', '- a = 1\n+ a = 2\n'), 'diff');
  assert.equal(codeLang('', 'print(1)'), undefined);
  assert.equal(codeLang('PY', 'x'), 'py');
  const d = renderMarkdown('```\n- old\n+ new\n```', ENV);
  assert.ok(d.includes('hljs-deletion') && d.includes('hljs-addition'));
  const u = renderMarkdown('```cobolx\n<b>x</b>\n```', ENV);
  assert.ok(u.includes('&lt;b&gt;x&lt;/b&gt;') && !u.includes('<b>'));
});

test('file:line references (in code and in text) become clickable links', () => {
  const a = renderMarkdown('`pipeline/steps/rollup.py:142` order changes on ties', ENV);
  assert.ok(a.includes('<a class="ref" href="#" data-path="pipeline/steps/rollup.py" data-line="142"'));
  const b = renderMarkdown('See: sql/order_status.sql:18-22 and a.ts:5', ENV);
  assert.ok(b.includes('data-path="sql/order_status.sql" data-line="18" data-end="22"'));
  assert.ok(b.includes('data-path="a.ts" data-line="5"'));
  // a bare file name or a variable name is not linked
  const c = renderMarkdown('`order_id` and order_status.sql', ENV);
  assert.ok(!c.includes('class="ref"'));
});

test('extensions like .py are not taken for web links; real URLs are linked without nested links', () => {
  const h = renderMarkdown('rollup.py:142 and https://jira.example/browse/ABC-1/a.py:3', ENV);
  assert.ok(!h.includes('href="http://rollup.py'));
  assert.ok(h.includes('<a href="https://jira.example/browse/ABC-1/a.py:3">'));
  assert.equal((h.match(/<a /g) ?? []).length, 2); // the ref + one URL link (no jira/ref inside the URL)
});

test('Jira keys are linked; not inside code blocks or for other projects', () => {
  const h = renderMarkdown('Plan for ABC-4321, `ABC-12` and XYZ-1', ENV);
  assert.ok(h.includes('<a class="jira" href="https://jira.example/browse/ABC-4321" data-key="ABC-4321">ABC-4321</a>'));
  assert.ok(h.includes('data-key="ABC-12"'));
  assert.ok(!h.includes('data-key="XYZ-1"'));
  const k = renderMarkdown('```\nABC-4321\n```', ENV);
  assert.ok(!k.includes('class="jira"'));
  const none = renderMarkdown('ABC-4321', {});
  assert.ok(!none.includes('class="jira"'));
});

test('images load inline only from the relay host or as data URIs; others become links', () => {
  const other = renderMarkdown('![x](https://evil.example/p.png?u=me)', { imageHost: 'relay.example' });
  assert.ok(!other.includes('<img'), other);
  assert.ok(other.includes('href="https://evil.example/p.png?u=me"'), other);
  assert.ok(renderMarkdown('![x](https://relay.example/a.png)', { imageHost: 'relay.example' }).includes('<img'));
  assert.ok(!/(src|href)="javascript/i.test(renderMarkdown('![x](javascript:alert(1))', {})));
});

test('text nested deeper than markdown draws (quotes, lists, both) is still shown, at a bounded depth', () => {
  const count = (h: string, re: RegExp) => (h.match(re) ?? []).length;
  const deep = renderMarkdown('> '.repeat(200) + 'DEEPEST', ENV);
  assert.ok(deep.includes('DEEPEST'), deep.slice(-300));
  assert.equal(count(deep, /<blockquote>/g), 20, deep.slice(0, 300));
  const growing = Array.from({ length: 150 }, (_, i) => '> '.repeat(i + 1) + 'bq' + i).join('\n');
  const h = renderMarkdown(growing, ENV);
  assert.ok(h.includes('bq0') && h.includes('bq99') && h.includes('bq149'), h.slice(-300));
  assert.ok(renderMarkdown('>>>>>'.repeat(50) + 'x', ENV).includes('x'));
  // lists cost two levels each: 60 markers on one line, ordered ones, quotes and lists mixed
  for (const [src, needle] of [
    ['- '.repeat(60) + 'LISTDEEP', 'LISTDEEP'],
    ['1. '.repeat(60) + 'ORDDEEP', 'ORDDEEP'],
    ['> '.repeat(24) + '- '.repeat(40) + 'MIXDEEP', 'MIXDEEP'],
    ['> - '.repeat(60) + 'QLDEEP', 'QLDEEP'],
  ]) {
    const out = renderMarkdown(src, ENV);
    assert.ok(out.includes(needle), needle + ': ' + out.slice(-200));
    // a list opens two levels at once (list, item), so the deepest one may end a level past the limit
    assert.ok(count(out, /<blockquote>/g) + 2 * count(out, /<ul>|<ol[ >]/g) <= 21, needle + ': ' + out.slice(0, 200));
  }
  // a list nested by indentation, 60 levels: every item is there, and what follows a blank line stays outside it
  const indented = Array.from({ length: 60 }, (_, i) => '  '.repeat(i) + '- item' + i).join('\n') + '\n\nAFTER';
  const li = renderMarkdown(indented, ENV);
  assert.ok(li.includes('item0') && li.includes('item30') && li.includes('item59'), li.slice(-300));
  assert.ok(/<\/ul>\n<p>AFTER<\/p>\n$/.test(li), li.slice(-120));
  assert.ok(/<\/ul>\n<p>PARA<\/p>\n$/.test(renderMarkdown('- '.repeat(60) + 'LISTDEEP\n\nPARA', ENV)));
  // ordinary nesting is drawn as before
  assert.equal(renderMarkdown('> quoted\n\nplain', ENV), '<blockquote>\n<p>quoted</p>\n</blockquote>\n<p>plain</p>\n');
  const five = renderMarkdown(Array.from({ length: 5 }, (_, i) => '  '.repeat(i) + '- level' + i).join('\n'), ENV);
  assert.equal(count(five, /<ul>/g), 5, five);
  assert.equal(count(renderMarkdown('> > > three', ENV), /<blockquote>/g), 3);
});

test('a code block nested too deep to draw is text on screen and for the proposal bars alike (same numbering)', () => {
  const deep = '> '.repeat(120);
  const src = [deep + '```python', deep + 'print(1)', deep + '```', '', 'See `etl/x.py`:', '', '```python', 'print(2)', '```'].join('\n');
  const html = renderMarkdown(src, ENV);
  assert.deepEqual(html.match(/data-block="\d+"/g), ['data-block="0"']);
  assert.ok(/data-block="0"[\s\S]*print[\s\S]*2/.test(html), html.slice(-400));
  assert.ok(html.includes('print(1)'), 'the deep block is kept as text');
  const blocks = extractBlocks(src);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].index, 0);
  assert.equal(blocks[0].content, 'print(2)\n');
  assert.equal(blocks[0].ref?.path, 'etl/x.py');
});

test('a list item past the drawn depth ends where markdown-it ends a paragraph; two of its paragraphs stay two', () => {
  const tree = [
    '- src',
    '  - main',
    '    - java',
    '      - com',
    '        - acme',
    '          - billing',
    '            - invoice',
    '              - service',
    '                - impl',
    '                  - InvoiceServiceImpl.java',
    '                  - InvoiceMapper.java',
    '                - InvoiceService.java',
    '- pom.xml',
    '',
    'Changes are in these files.',
  ].join('\n');
  const h = renderMarkdown(tree, ENV);
  for (const name of ['InvoiceServiceImpl.java', 'InvoiceMapper.java', 'InvoiceService.java', 'pom.xml']) assert.ok(h.includes(name), name);
  assert.ok(!/InvoiceServiceImpl\.java[^<]*InvoiceMapper/.test(h), 'a sibling item is not pulled into the deep one: ' + h.slice(-500));
  assert.ok(
    /<li>pom\.xml<\/li>\n<\/ul>\n<p>Changes are in these files\.<\/p>\n$/.test(h),
    'the top-level item and the paragraph stay where they are: ' + h.slice(-200),
  );
  // two paragraphs in the deepest item: not glued together
  const two = renderMarkdown(
    Array.from({ length: 10 }, (_, i) => '  '.repeat(i) + '- level' + i).join('\n') + '\n\n' + ' '.repeat(20) + 'second paragraph',
    ENV,
  );
  assert.ok(/level9<\/p>\n<p>second paragraph<\/p>/.test(two), two.slice(-200));
  // a fence or heading less indented than the deep item belongs to the outer level
  const fence = renderMarkdown('- '.repeat(10) + 'deep\n```java\nclass Foo {}\n```', ENV);
  assert.ok(/data-block="0"/.test(fence) && fence.replace(/<[^>]+>/g, '').includes('class Foo {}'), fence.slice(-300)); // highlighted: tags between the words
  assert.ok(renderMarkdown('- '.repeat(10) + 'deep\n# Heading', ENV).includes('<h1>Heading</h1>'));
  // a less indented plain line is a lazy continuation, as markdown-it reads it
  assert.ok(/deep<br>\s*lazy line/.test(renderMarkdown('- '.repeat(10) + 'deep\nlazy line', ENV)));
});
