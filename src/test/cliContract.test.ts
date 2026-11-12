// The extension's CLI client against what the real Buzz CLI answered: test/cli-contract/recorded.json, recorded and
// anonymised by test/cli-contract/capture.js and replayed by replayCli.ts. Every row the CLI printed must be understood.
// When Buzz changes its output, record again (docs/TESTING.md) and these tests say what the extension no longer reads.
// Without a recording they are skipped. BUZZ_CLI_RECORDING points them at another recording (cli_capture_check.js).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { BuzzClient } from '../api';
import { CHANNEL_MESSAGE_KINDS, isHex64, replyRootOf, rowsSent, TYPING_KIND } from '../core';
import { parseSearch } from '../lensCore';

interface Call {
  args: string[];
  code: number | null;
  stdout?: unknown;
  stdoutFormat?: string;
}
type Row = Record<string, unknown>;

const FILE = process.env.BUZZ_CLI_RECORDING || path.join(__dirname, '..', '..', 'test', 'cli-contract', 'recorded.json');
const rec: { cli?: string; recorded?: string; calls: Call[] } = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { calls: [] };
const skip = existsSync(FILE) ? false : 'no recording yet: run test/cli-contract/capture.js (see docs/TESTING.md)';

const answered = (c: Call) => c.code === 0 && c.stdoutFormat === 'json';
const recorded = (...words: string[]) => rec.calls.filter((c) => answered(c) && words.every((w, i) => c.args[i] === w));
const flag = (c: Call, f: string) => {
  const i = c.args.indexOf(f);
  return i >= 0 ? c.args[i + 1] : undefined;
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rows = (v: unknown): Row[] => list(v).filter((x): x is Row => !!x && typeof x === 'object');
const KNOWN_KINDS = new Set([...CHANNEL_MESSAGE_KINDS, 5, 9005, TYPING_KIND]); // shown, deletions, typing

function client(warnings: string[] = []): BuzzClient {
  // an unusable key: the client then takes my public key from the recorded profile, as it would from Buzz
  const options = {
    cliPath: process.execPath,
    cliArgsPrefix: [path.join(__dirname, 'replayCli.js'), FILE],
    relayUrl: 'http://relay.example.invalid',
    key: 'replay',
  };
  return new BuzzClient(
    async () => options,
    (w) => warnings.push(w),
  );
}

test('the recording is anonymised: no private key, no real address, a CLI version and a date', { skip }, () => {
  const text = readFileSync(FILE, 'utf8');
  assert.ok(!/nsec1[0-9a-z]{20,}/.test(text), 'no private key');
  const urls = text.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"]+/gi) ?? [];
  assert.deepEqual(
    urls.filter((u) => !/^[a-z0-9+.-]+:\/\/host-\d+\.example\.invalid$/i.test(u)),
    [],
    'only stand-in addresses',
  );
  assert.ok(rec.calls.length > 0 && !!rec.cli && !!rec.recorded);
});

test('users get: my profile is read, with my public key and the name Buzz shows', { skip }, async (t) => {
  const c = recorded('users', 'get').find((x) => x.args.length === 2);
  if (!c) return t.skip('not in the recording');
  const p = rows(c.stdout)[0] ?? {};
  const me = await client().me();
  assert.ok(isHex64(me.pubkey), me.pubkey);
  assert.equal(me.pubkey, p.pubkey);
  const shown = [p.display_name, p.displayName, p.name].find((n) => typeof n === 'string' && n.trim());
  if (typeof shown === 'string') assert.equal(me.name, shown.trim(), 'the name is read from the field Buzz fills');
});

test('channels list --member: every row is a channel, with its id and name', { skip }, async (t) => {
  const c = recorded('channels', 'list', '--member')[0];
  if (!c) return t.skip('not in the recording');
  assert.ok(Array.isArray(c.stdout), 'a list, as the extension reads it');
  const warnings: string[] = [];
  const got = await client(warnings).channels();
  const want = rows(c.stdout);
  assert.equal(got.length, want.length, 'every row has an id the extension finds');
  for (const r of want) {
    const ch = got.find((x) => x.id === (r.channel_id ?? r.id));
    assert.ok(ch, `channel ${String(r.channel_id ?? r.id)}`);
    assert.equal(ch.name, typeof r.name === 'string' ? r.name : '');
  }
  assert.deepEqual(warnings, []);
});

test("dms list: every conversation is read, with the other people's keys and never mine", { skip }, async (t) => {
  const c = recorded('dms', 'list')[0];
  if (!c) return t.skip('not in the recording');
  const cl = client();
  const me = recorded('users', 'get').some((x) => x.args.length === 2) ? (await cl.me()).pubkey : undefined;
  const dms = await cl.dms();
  const ids = new Set(dms.flatMap((d) => d.ids ?? [d.id]));
  for (const r of rows(c.stdout)) {
    const id = r.dm_id ?? r.channel_id ?? r.id;
    assert.ok(ids.has(String(id)), `conversation ${String(id)}`);
  }
  for (const d of dms) {
    for (const p of d.peers ?? []) {
      assert.ok(isHex64(p), p);
      if (me) assert.notEqual(p, me);
    }
  }
});

test('messages get: every row of every page is a message the chat can use, and the chat shows them', { skip }, async (t) => {
  const pages = recorded('messages', 'get');
  if (!pages.length) return t.skip('not in the recording');
  for (const c of pages) {
    const num = (f: string) => (flag(c, f) === undefined ? undefined : Number(flag(c, f)));
    const warnings: string[] = [];
    const page = await client(warnings).messages(String(flag(c, '--channel')), { limit: num('--limit'), since: num('--since'), before: num('--before') });
    const n = list(c.stdout).length;
    assert.equal(rowsSent(page), n, 'the page counts every row the CLI sent');
    assert.equal(page.length, n, `${n - page.length} row(s) dropped as malformed`);
    assert.deepEqual(warnings, []);
    if (n)
      assert.ok(
        page.some((e) => CHANNEL_MESSAGE_KINDS.includes(e.kind)),
        'at least one row is a message the chat shows',
      );
    const unknown = [...new Set(page.map((e) => e.kind).filter((k) => !KNOWN_KINDS.has(k)))];
    if (unknown.length) t.diagnostic(`kinds the chat does not show (it re-reads the channel on them): ${unknown.join(', ')}`);
  }
});

test('messages thread: the thread is read whole, and every message belongs to it', { skip }, async (t) => {
  const threads = recorded('messages', 'thread');
  if (!threads.length) return t.skip('not in the recording');
  for (const c of threads) {
    const root = String(flag(c, '--event'));
    const page = await client().thread(String(flag(c, '--channel')), root);
    assert.equal(page.length, list(c.stdout).length, 'no row dropped');
    for (const e of page) assert.ok(e.id === root || replyRootOf(e) === root, `${e.id} is not in thread ${root}`);
  }
});

test('channels members: every member has a key and a name, and agents are told apart as their profiles say', { skip }, async (t) => {
  const lists = recorded('channels', 'members');
  if (!lists.length) return t.skip('not in the recording');
  const bots = new Set(
    recorded('users', 'get')
      .flatMap((c) => rows(c.stdout))
      .filter((p) => p.bot === true || p.agent === true)
      .map((p) => String(p.pubkey)),
  );
  for (const c of lists) {
    const got = await client().members(String(flag(c, '--channel')));
    assert.equal(got.length, rows(c.stdout).filter((r) => typeof r.pubkey === 'string' && r.pubkey).length);
    for (const m of got) {
      assert.ok(isHex64(m.pubkey), m.pubkey);
      assert.ok(m.name.trim(), `a name for ${m.pubkey}`);
      if (bots.has(m.pubkey)) assert.ok(m.isAgent, `${m.name} is an agent in its profile`);
    }
  }
});

test('users presence: everyone Buzz lists gets a status the extension knows', { skip }, async (t) => {
  const answers = recorded('users', 'presence');
  if (!answers.length) return t.skip('not in the recording');
  for (const c of answers) {
    const asked = String(flag(c, '--pubkeys') ?? '')
      .split(',')
      .filter(Boolean);
    // whoever the output names, whatever the field that holds the status is called: a renamed field must fail here
    const listed = new Set<string>();
    const walk = (v: unknown, depth: number): void => {
      if (depth > 3 || !v || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        for (const x of rows(v)) {
          const k = String(x.pubkey ?? x.user ?? x.id);
          if (isHex64(k)) listed.add(k);
        }
        return;
      }
      for (const [k, x] of Object.entries(v)) {
        if (isHex64(k)) listed.add(k);
        else walk(x, depth + 1);
      }
    };
    walk(c.stdout, 0);
    const got = await client().presence(asked);
    assert.deepEqual(Object.keys(got).sort(), [...listed].map((k) => k.toLowerCase()).sort(), 'every listed person has a status');
    for (const s of Object.values(got)) assert.ok(['online', 'away', 'offline'].includes(s), s);
  }
});

test('feed get: every mention is a message the notifications can use', { skip }, async (t) => {
  const feeds = recorded('feed', 'get');
  if (!feeds.length) return t.skip('not in the recording');
  for (const c of feeds) {
    const warnings: string[] = [];
    const got = await client(warnings).feed(Number(flag(c, '--since')), flag(c, '--types'));
    assert.equal(got.length, list(c.stdout).length, 'no row dropped');
    assert.deepEqual(warnings, []);
  }
});

test('messages search: Buzz Lens reads every result (id, text, channel and time)', { skip }, async (t) => {
  const searches = recorded('messages', 'search');
  if (!searches.length) return t.skip('not in the recording');
  for (const c of searches) {
    const query = (c.args.find((a) => a.startsWith('--query=')) ?? '').slice('--query='.length);
    const raw = await client().search(query, Number(flag(c, '--limit')));
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Row) : undefined;
    const items = rows(r ? (r.messages ?? r.results ?? r.events ?? r.data) : raw);
    assert.equal(parseSearch(raw).length, items.length, 'every result is read');
  }
});
