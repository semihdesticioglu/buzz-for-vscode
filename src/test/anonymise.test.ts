// The anonymiser behind test/cli-contract/recorded.json: what it replaces, what it keeps, and the leak check that
// stops a capture from being saved with anything original left in it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksLikeAgent } from '../core';
import { anonymiser, leaks, originalsOf, originalsOfArgs } from './anonymise';

const SALT = Buffer.alloc(32, 7);
const NOW = 1_762_900_000;
const ADA = 'ad'.repeat(32);
const AGENT = 'b0'.repeat(32);
const EV = 'e1'.repeat(32);
const ROOT = 'e0'.repeat(32);
const SIG = 'f5'.repeat(64);
const CH = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
const HEX64 = /^[0-9a-f]{64}$/;
type Row = Record<string, unknown>;

test('ids, keys and signatures become other hex of the same length, the same value always the same', () => {
  const a = anonymiser({ salt: SALT, now: NOW });
  const out = a.value({
    id: EV,
    pubkey: ADA,
    sig: SIG,
    tags: [
      ['e', ROOT, '', 'root'],
      ['p', ADA],
    ],
  }) as Row;
  const tags = out.tags as string[][];
  assert.match(String(out.id), HEX64);
  assert.notEqual(out.id, EV);
  assert.match(String(out.sig), /^[0-9a-f]{128}$/);
  assert.notEqual(out.sig, SIG);
  assert.equal(tags[1][1], out.pubkey, 'the same key in a tag and in a field gets the same stand-in');
  assert.deepEqual([tags[0][0], tags[0][2], tags[0][3], tags[1][0]], ['e', '', 'root', 'p']);
  assert.notEqual(tags[0][1], ROOT);
});

test("names, texts, addresses and e-mails are replaced; an agent's name still looks like an agent's", () => {
  const a = anonymiser({ salt: SALT, now: NOW });
  const original = {
    name: 'data-dev',
    display_name: 'Ayşe Yılmaz',
    about: 'Works on the ETL at ACME',
    picture: 'https://cdn.acme.example/a.png',
    nip05: 'ayse@acme.example',
    content: 'Merhaba @review_agent, the 10.1.2.3 relay is down',
  };
  const out = a.value(original) as Row;
  const text = JSON.stringify(out);
  for (const v of Object.values(original)) assert.ok(!text.includes(v), `"${v}" is gone`);
  assert.match(String(out.display_name), /^name \d+$/);
  assert.match(String(out.content), /^text \d+$/);
  assert.match(String(out.picture), /^https:\/\/host-\d+\.example\.invalid$/);
  assert.match(String(out.nip05), /^user-\d+@example\.invalid$/);
  const agent = (a.value({ display_name: 'review_agent_claude' }) as Row).display_name as string;
  assert.notEqual(agent, 'review_agent_claude');
  assert.ok(looksLikeAgent(undefined, agent), agent);
  assert.ok(!looksLikeAgent(undefined, String(out.display_name)));
});

test('the structure stays: keys, numbers, booleans, null, list lengths, tag names, and the words the extension reads', () => {
  const a = anonymiser({ salt: SALT, now: NOW });
  const row = {
    pubkey: ADA,
    status: 'online',
    bot: true,
    role: 'owner',
    type: 'stream',
    visibility: 'private',
    kind: 9,
    count: 3,
    extra: null,
    tags: [
      ['h', CH],
      ['t', 'release'],
    ],
  };
  const out = a.value([row, row]) as Row[];
  assert.equal(out.length, 2);
  assert.deepEqual(Object.keys(out[0]), Object.keys(row));
  const o = out[0];
  assert.deepEqual([o.status, o.bot, o.role, o.type, o.visibility, o.kind, o.count, o.extra], ['online', true, 'owner', 'stream', 'private', 9, 3, null]);
  const tags = o.tags as string[][];
  assert.deepEqual([tags[0][0], tags[1][0]], ['h', 't']);
  assert.match(tags[0][1], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(tags[0][1], CH);
  assert.notEqual(tags[1][1], 'release');
  const err = a.value({ error: 'not_found', message: 'channel gizli-proje not found' }) as Row;
  assert.equal(err.error, 'not_found', 'an error code stays');
  assert.ok(!String(err.message).includes('gizli'));
});

test('times move by one constant, in the output and in the arguments alike; other numbers stay', () => {
  const a = anonymiser({ salt: SALT, now: NOW, shiftTo: 1_700_000_000 });
  const out = a.value({ created_at: 1_762_800_000, updated_at: 1_762_800_500, at_ms: 1_762_800_000_123, limit: 50 }) as Record<string, number>;
  const delta = out.created_at - 1_762_800_000;
  assert.notEqual(delta, 0);
  assert.ok(delta % 86_400 === 0, 'whole days'); // === : a negative shift leaves -0
  assert.equal(out.updated_at - out.created_at, 500, 'differences stay');
  assert.equal(out.at_ms, 1_762_800_000_123 + delta * 1000);
  assert.equal(out.limit, 50);
  assert.deepEqual(a.args(['feed', 'get', '--since', '1762800000', '--limit', '30']), ['feed', 'get', '--since', String(out.created_at), '--limit', '30']);
});

test('command lines: command words and flags stay, values are replaced as they are in the output', () => {
  const a = anonymiser({ salt: SALT, now: NOW });
  const out = a.value([{ channel_id: CH, name: 'data-dev' }]) as Row[];
  const args = a.args(['messages', 'get', '--channel', CH, '--limit', '20']);
  assert.deepEqual(args.slice(0, 3), ['messages', 'get', '--channel']);
  assert.equal(args[3], out[0].channel_id, 'the channel in the command is the channel of the output');
  assert.deepEqual(args.slice(4), ['--limit', '20']);
  const [q] = a.args(['--query=gizli proje']);
  assert.match(q, /^--query=value-\d+$/);
  const [, keys] = a.args(['--pubkeys', `${ADA},${AGENT}`]);
  const pk = (a.value({ pubkey: ADA }) as Row).pubkey;
  assert.equal(keys.split(',')[0], pk);
  assert.equal(keys.split(',').length, 2);
  assert.deepEqual(a.args(['--types', 'mentions,needs_action']), ['--types', 'mentions,needs_action']);
});

test('a hex key of an object (presence by public key) is replaced like the same key elsewhere', () => {
  const a = anonymiser({ salt: SALT, now: NOW });
  const out = a.value({ [ADA]: 'online', users: [{ pubkey: ADA }] }) as Row;
  const [k] = Object.keys(out);
  assert.match(k, HEX64);
  assert.notEqual(k, ADA);
  assert.equal(out[k], 'online');
  assert.equal(((out.users as Row[])[0] as Row).pubkey, k);
});

test('output that is not JSON keeps only its length', () => {
  const a = anonymiser({ salt: SALT, now: NOW });
  const s = 'Error: relay at ws://10.1.2.3:8080 refused';
  assert.equal(a.text(s), `(${s.length} characters of text, replaced)`);
  assert.equal(a.text(''), '');
});

test('the leak check catches anything original left, even what an anonymiser kept by mistake', () => {
  const a = anonymiser({ salt: SALT, now: NOW });
  const raw = { name: 'Gizli Proje', content: 'secret text here', pubkey: ADA, status: 'online', tags: [['h', CH]], 'Ayşe Y': 1 };
  const originals = originalsOf(raw);
  assert.deepEqual(
    [...originals].sort(),
    [ADA, CH, 'Ayşe Y', 'Gizli Proje', 'secret text here'].sort(),
    'everything but the field names, the kept words and the tag name',
  );
  assert.deepEqual(leaks(a.value(raw), originals, ['ws://10.1.2.3', 'winuser']), []);
  assert.deepEqual(leaks(raw, originals).sort(), [...originals].sort(), 'an anonymiser that let everything through is caught');
  assert.deepEqual(leaks({ note: 'signed in as WINUSER' }, [], ['winuser']), ['winuser'], 'a secret, in any letter case');
});

test('a short original counts as a whole value, a long one anywhere', () => {
  const originals = originalsOf({ name: 'lin', display_name: 'Ada Lovelace' });
  assert.deepEqual(leaks({ status: 'online', cli: '0.0.0-sample' }, originals), [], '"lin" inside "online" is chance');
  assert.deepEqual(leaks({ name: 'lin' }, originals), ['lin']);
  assert.deepEqual(leaks({ content: 'thanks, Ada Lovelace!' }, originals), ['Ada Lovelace']);
  assert.deepEqual(leaks({ args: ['messages', 'search', '--query=lin'] }, originals), ['lin'], 'a value inside an argument is whole too');
  assert.deepEqual(leaks({ args: ['--pubkeys', 'x1,lin'] }, originals), ['lin']);
});

test('in a command line, only the values are originals', () => {
  const args = ['messages', 'get', '--channel', CH, '--limit', '20', '--query=gizli', '--pubkeys', `${ADA},${AGENT}`, '--types', 'mentions,needs_action'];
  assert.deepEqual([...originalsOfArgs(args)].sort(), [ADA, AGENT, CH, 'gizli'].sort());
});

test('one capture gives the same stand-ins throughout; another capture gives other ones', () => {
  const a = anonymiser({ salt: SALT, now: NOW });
  const b = anonymiser({ salt: Buffer.alloc(32, 8), now: NOW });
  assert.equal((a.value({ id: EV }) as Row).id, (a.value({ id: EV }) as Row).id);
  assert.notEqual((a.value({ id: EV }) as Row).id, (b.value({ id: EV }) as Row).id);
});
