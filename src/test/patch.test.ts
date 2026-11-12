import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBlocks } from '../markdown';
import { applyPlan, parseUnified, Plan, planFiles, planFor } from '../patch';

const FILE = ['def score(x):', '    if x > 10:', '        return 1', '    return 0', '', 'def other():', '    pass'].join('\n');

const planFromMessage = (msg: string, i = 0): Plan | undefined => planFor(extractBlocks(msg)[i]);

test('unified diff with @@ hunks applies, even when line numbers are off', () => {
  const msg = [
    'Fix for `etl/score.py:2`:',
    '```diff',
    '--- a/etl/score.py',
    '+++ b/etl/score.py',
    '@@ -40,3 +40,3 @@',
    ' def score(x):',
    '-    if x > 10:',
    '+    if x >= 10:',
    '         return 1',
    '```',
  ].join('\n');
  const plan = planFromMessage(msg)!;
  assert.equal(plan.kind, 'unified');
  assert.deepEqual(planFiles(plan), ['etl/score.py']);
  const r = applyPlan(plan, 'etl/score.py', FILE);
  assert.ok(r.ok);
  assert.equal(r.ok && r.text, FILE.replace('if x > 10', 'if x >= 10'));
});

test('unified hunk without file headers takes the file from the reference before it', () => {
  const msg = 'In `etl/score.py:4`:\n```diff\n@@ -4,1 +4,1 @@\n-    return 0\n+    return -1\n```';
  const plan = planFromMessage(msg)!;
  assert.deepEqual(planFiles(plan), ['etl/score.py']);
  const r = applyPlan(plan, 'etl/score.py', FILE);
  assert.ok(r.ok && r.text.includes('    return -1') && !r.text.includes('    return 0'));
});

test('several hunks keep their offsets', () => {
  const diff = [
    '--- a/f.py',
    '+++ b/f.py',
    '@@ -1,1 +1,2 @@',
    ' def score(x):',
    '+    """Score."""',
    '@@ -6,2 +7,2 @@',
    ' def other():',
    '-    pass',
    '+    return None',
  ].join('\n');
  const plan = planFor({ index: 0, lang: 'diff', content: diff })!;
  const r = applyPlan(plan, 'f.py', FILE);
  assert.ok(r.ok);
  assert.equal(r.ok && r.text.split('\n')[1], '    """Score."""');
  assert.ok(r.ok && r.text.endsWith('def other():\n    return None'));
});

test('a new file from /dev/null is created from the added lines', () => {
  const diff = '--- /dev/null\n+++ b/sql/new.sql\n@@ -0,0 +1,2 @@\n+SELECT 1;\n+SELECT 2;';
  const files = parseUnified(diff);
  assert.deepEqual(
    files.map((f) => [f.path, f.isNew]),
    [['sql/new.sql', true]],
  );
  const r = applyPlan(planFor({ index: 0, lang: 'diff', content: diff })!, 'sql/new.sql', '');
  assert.ok(r.ok && r.text === 'SELECT 1;\nSELECT 2;');
});

test('loose "- old / + new" diff matches ignoring indentation and keeps the file indentation', () => {
  const msg = 'Change `etl/score.py:2`:\n```diff\n- if x > 10:\n+ if x >= 10:\n```';
  const plan = planFromMessage(msg)!;
  assert.equal(plan.kind, 'loose');
  const r = applyPlan(plan, 'etl/score.py', FILE);
  assert.ok(r.ok && r.text.includes('\n    if x >= 10:\n'));
});

test('a loose change that matches several places is ambiguous without a line hint', () => {
  const text = 'a = 1\nb = 2\na = 1\n';
  const plan: Plan = { kind: 'loose', path: 'x.py', oldLines: ['a = 1'], newLines: ['a = 3'] };
  assert.deepEqual(applyPlan(plan, 'x.py', text), { ok: false, reason: 'ambiguous' });
  const near: Plan = { ...plan, near: 3 };
  const r = applyPlan(near, 'x.py', text);
  assert.ok(r.ok && r.text === 'a = 1\nb = 2\na = 3\n');
});

test('lines that are not in the file are reported as notFound', () => {
  const plan: Plan = { kind: 'loose', path: 'x.py', oldLines: ['nope = 1'], newLines: ['nope = 2'] };
  assert.deepEqual(applyPlan(plan, 'x.py', FILE), { ok: false, reason: 'notFound' });
});

test('a plain block after path:L2-L3 replaces exactly those lines; CRLF files stay CRLF', () => {
  const msg = 'Replace `etl/score.py:L2-L3` with:\n```python\n    if x >= 10:\n        return 2\n```';
  const plan = planFromMessage(msg)!;
  assert.deepEqual(plan, { kind: 'replace', path: 'etl/score.py', start: 2, end: 3, newLines: ['    if x >= 10:', '        return 2'] });
  const crlf = FILE.replace(/\n/g, '\r\n');
  const r = applyPlan(plan, 'etl/score.py', crlf);
  assert.ok(r.ok);
  assert.equal(r.ok && r.text, crlf.replace('if x > 10:\r\n        return 1', 'if x >= 10:\r\n        return 2'));
});

test('no proposal for code without a file, for a multi-line block after a single line ref, or for plain diffs without a file', () => {
  assert.equal(planFromMessage('```python\nprint(1)\n```'), undefined);
  assert.equal(planFromMessage('See `a/b.py:10`\n```python\nx = 1\ny = 2\n```'), undefined);
  assert.equal(planFromMessage('```diff\n- a\n+ b\n```'), undefined);
  // quoted errors, terminal output and code in another language are not proposals
  assert.equal(planFromMessage("Fails at `a/b.py:12`:\n```text\nKeyError: 'x'\n```"), undefined);
  assert.equal(planFromMessage("Fails at `a/b.py:12`:\n```\nKeyError: 'x'\n```"), undefined);
  assert.equal(planFromMessage('Query in `a/b.py:L3-L4`:\n```sql\nSELECT 1\nFROM t\n```'), undefined);
  // a single line after a single line ref is a replacement of that line
  assert.equal(planFromMessage('See `a/b.py:10`\n```python\nx = 1\n```')?.kind, 'replace');
});

test('the file can be named in the fence info', () => {
  const blocks = extractBlocks('```python:etl/score.py:L4\n    return -1\n```');
  assert.deepEqual(blocks[0].ref, { path: 'etl/score.py', line: 4, end: undefined });
  const r = applyPlan(planFor(blocks[0])!, 'etl/score.py', FILE);
  assert.ok(r.ok && r.text.includes('    return -1'));
});

// ------------------------------------------------------------------ regressions from the code review

test('a removed SQL comment ("--- x" inside a hunk) is a changed line, not a file header', () => {
  const sql = ['SELECT a,', '  b', '-- legacy note', 'FROM t'].join('\n');
  const diff = ['--- a/sql/x.sql', '+++ b/sql/x.sql', '@@ -1,4 +1,4 @@', ' SELECT a,', '-  b', '--- legacy note', '+  c', '+-- new note', ' FROM t'].join('\n');
  const p = planFor({ index: 0, lang: 'diff', content: diff })!;
  assert.deepEqual(planFiles(p), ['sql/x.sql']);
  const r = applyPlan(p, 'sql/x.sql', sql);
  assert.ok(r.ok);
  assert.equal(r.ok && r.text, ['SELECT a,', '  c', '-- new note', 'FROM t'].join('\n'));
});

test('a loose diff keeps a dedented line dedented (no line moves into the block above)', () => {
  const p = planFromMessage('Fix `etl/score.py:3`:\n```diff\n-         return 1\n-     return 0\n+         return 2\n+     return -1\n```')!;
  const r = applyPlan(p, 'etl/score.py', FILE);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.text.split('\n').slice(1, 4), ['    if x > 10:', '        return 2', '    return -1']);
});

test('applying the same change twice is reported, not repeated', () => {
  const p = planFromMessage('Add logging in `etl/score.py:2`:\n```diff\n def score(x):\n+    log.info("start")\n```')!;
  const once = applyPlan(p, 'etl/score.py', FILE);
  assert.ok(once.ok);
  const twice = applyPlan(p, 'etl/score.py', once.ok ? once.text : '');
  assert.deepEqual(twice, { ok: false, reason: 'applied' });
  const u = planFor({ index: 0, lang: 'diff', content: '--- a/x.py\n+++ b/x.py\n@@ -3,1 +3,1 @@\n-        return 1\n+        return 2' })!;
  const u1 = applyPlan(u, 'x.py', FILE);
  assert.deepEqual(applyPlan(u, 'x.py', u1.ok ? u1.text : ''), { ok: false, reason: 'applied' });
});

test('a "new file" diff never prepends into an existing file', () => {
  const p = planFor({ index: 0, lang: 'diff', content: '--- /dev/null\n+++ b/sql/new.sql\n@@ -0,0 +1,2 @@\n+SELECT 1;\n+SELECT 2;' })!;
  assert.deepEqual(applyPlan(p, 'sql/new.sql', 'old\ncontent\n'), { ok: false, reason: 'exists' });
  assert.deepEqual(applyPlan(p, 'sql/new.sql', 'SELECT 1;\nSELECT 2;'), { ok: false, reason: 'applied' });
  assert.deepEqual(applyPlan(p, 'sql/new.sql', ''), { ok: true, text: 'SELECT 1;\nSELECT 2;' });
});

test('a trailing blank context line does not add a blank line', () => {
  const p = planFor({ index: 0, lang: 'diff', content: '--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,2 @@\n-a = 1\n+a = 2\n ' })!;
  const r = applyPlan(p, 'x.py', 'a = 1\n\nb = 2\n');
  assert.deepEqual(r, { ok: true, text: 'a = 2\n\nb = 2\n' });
});

test('a file reference only belongs to the code block right after it', () => {
  const msg = 'Change `etl/x.py:L10-L12` to:\n```python\na = 1\nb = 2\nc = 3\n```\nThen run it:\n```python\nmain()\n```';
  assert.equal(planFromMessage(msg, 0)?.kind, 'replace');
  assert.equal(planFromMessage(msg, 1), undefined);
});

test('commands after a reference to an unknown file type are not proposals', () => {
  assert.equal(planFromMessage('Pin it in `requirements.txt:L5`, then run:\n```bash\npip install -r requirements.txt\n```'), undefined);
  assert.equal(planFromMessage('In `cmd/main.go:12`:\n```bash\ngo vet ./...\n```'), undefined);
  assert.equal(planFromMessage('In `cmd/main.go:12`:\n```go\nfmt.Println(1)\n```')?.kind, 'replace');
});

test('a diff naming the same file twice keeps both parts', () => {
  const files = parseUnified('--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-l1\n+L1\n--- a/x.py\n+++ b/x.py\n@@ -8 +8 @@\n-l8\n+L8');
  assert.equal(files.length, 1);
  assert.equal(files[0].hunks.length, 2);
  const text = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'].join('\n');
  const r = applyPlan({ kind: 'unified', files }, 'x.py', text);
  assert.ok(r.ok && r.text.startsWith('L1\n') && r.text.endsWith('\nL8'));
});
