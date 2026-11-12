import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { BuzzClient } from '../api';
import { CliOptions, runCli, runJson } from '../buzzCli';
import { BuzzError, CliExit, friendlyError } from '../core';

const fake = path.join(__dirname, 'fakeCli.js');
const KEY = 'k'.repeat(64);
const base: CliOptions = { cliPath: process.execPath, cliArgsPrefix: [fake], relayUrl: 'http://relay.test', key: KEY };
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

test('runJson reads the output', async () => {
  const r = await runJson<{ display_name: string }[]>(base, ['users', 'get']);
  assert.equal(r[0].display_name, 'Ada');
});

test('message goes through stdin: Turkish characters, multiple lines and code fences survive; mention and reply arguments', async () => {
  const c = new BuzzClient(async () => base);
  const text = 'Hello @review_agent_claude ğüşİıöç "quote" $variable\n```py\nprint(1)\n```';
  const r = await c.send('c1', text, { mentions: [B, B], replyTo: 'r'.repeat(64) });
  const echo = JSON.parse(r.message!);
  assert.equal(echo.input, text);
  assert.deepEqual(echo.args, ['messages', 'send', '--channel', 'c1', '--content', '-', '--mention', B, '--reply-to', 'r'.repeat(64)]);
  assert.equal(echo.relay, 'http://relay.test');
});

test('no key gives an auth error (code 3); the key never appears in error text', async () => {
  await assert.rejects(runCli({ ...base, key: '' }, ['users', 'get']), (e: unknown) => {
    assert.ok(e instanceof BuzzError);
    assert.equal(e.code, 3);
    assert.equal(e.category, 'auth_error');
    return true;
  });
  await assert.rejects(runCli(base, ['unknown', 'command']), (e: unknown) => {
    assert.ok(e instanceof BuzzError && e.code === 1 && !e.message.includes(KEY));
    return true;
  });
});

test('a non-JSON failure is reported as a network error', async () => {
  await assert.rejects(runCli(base, ['fail', 'net']), (e: unknown) => e instanceof BuzzError && e.code === 2 && /connection refused/.test(e.message));
});

test('a missing CLI path gives a clear error', async () => {
  await assert.rejects(
    runCli({ ...base, cliPath: path.join(os.tmpdir(), 'missing', 'buzz.exe'), cliArgsPrefix: [] }, ['users', 'get']),
    (e: unknown) => e instanceof BuzzError && e.code === 4,
  );
});

test('channels sorted by name; DM participants by name, excluding me', async () => {
  const c = new BuzzClient(async () => base);
  const me = await c.me();
  assert.equal(me.pubkey, A);
  assert.deepEqual(
    (await c.channels()).map((x) => x.name),
    ['', 'alfa', 'dm', 'zeta'],
  );
  const dms = await c.dms();
  assert.equal(dms[0].id, 'd1');
  assert.equal(dms[0].name, 'review_agent_claude');
  assert.deepEqual(dms[0].peers, [B]);
  const ms = await c.members('c1');
  assert.equal(ms[0].name, 'review_agent_claude');
  assert.ok(ms[0].isAgent);
  assert.equal(ms[1].name, 'Ada');
});

test('rows of a CLI page that are not messages are dropped at the boundary, not trusted (a null, a number for content, no key)', async () => {
  const warned: string[] = [];
  const c = new BuzzClient(
    async () => base,
    (l) => warned.push(l),
  );
  for (const rows of [await c.messages('c1'), await c.thread('c1', 'e'.repeat(64)), await c.feed(0)]) {
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, 'hello');
    assert.equal(rows[0].pubkey, A);
  }
  // the three reads bring the same malformed rows: they are logged once, by the read that met them first
  assert.deepEqual(warned, ['[cli] 3 malformed row(s) dropped from `messages get`']);
  // the page keeps the count (a full page stays full), and reading the same rows again logs nothing
  const again = await c.messages('c1');
  assert.equal(again.dropped, 3);
  assert.equal(warned.length, 1, warned.join('\n'));
  // output that is not a list reads as nothing, and the log says so
  assert.deepEqual([...(await c.messages('wrapped'))], []);
  assert.ok(
    warned.some((l) => /`messages get` is not a list/.test(l)),
    warned.join('\n'),
  );
});

test('presence is asked for in one comma-separated call', async () => {
  const c = new BuzzClient(async () => base);
  // the CLI lists only who has a live presence entry: A is left out (the tracker counts that as offline)
  assert.deepEqual(await c.presence([A, B, B, 'not-a-key']), { [B]: 'online' });
  assert.deepEqual(await c.presence([]), {});
});

const realCli = path.join(process.env.LOCALAPPDATA ?? '', 'Buzz', 'buzz.exe');
test(
  'real buzz.exe: an invalid key is rejected before any network call (opt-in: BUZZ_CLI_SMOKE=1)',
  { skip: !process.env.BUZZ_CLI_SMOKE || !fs.existsSync(realCli) },
  async () => {
    await assert.rejects(runCli({ cliPath: realCli, relayUrl: 'http://127.0.0.1:9', key: 'zz' }, ['--format', 'compact', 'channels', 'list']), (e: unknown) => {
      assert.ok(e instanceof BuzzError);
      assert.equal(e.code, 3);
      assert.equal(e.category, 'key_error');
      assert.match(friendlyError(e), /Invalid Nostr key/);
      return true;
    });
  },
);

test('a conversation listed only as a channel named "dm" is a direct message and joins the note of the same people', async () => {
  const c = new BuzzClient(async () => base);
  await c.me();
  const all = await c.allChannels();
  assert.deepEqual(
    all.filter((x) => !x.isDm).map((x) => x.name),
    ['alfa', 'zeta'],
  );
  const dm = all.filter((x) => x.isDm);
  assert.equal(dm.length, 1);
  assert.deepEqual(dm[0].ids, ['d1', 'd2']);
  assert.equal(dm[0].name, 'review_agent_claude');
  assert.deepEqual(dm[0].peers, [B]);
});

test('a CLI that hangs is stopped after the time limit and reported as a network problem, not waited on for ever', async () => {
  const t0 = Date.now();
  await assert.rejects(runCli({ ...base, timeoutMs: 400 }, ['slow', 'wait']), (e: unknown) => {
    assert.ok(e instanceof BuzzError, String(e));
    assert.equal(e.code, CliExit.Network);
    assert.equal(e.category, 'timeout');
    return true;
  });
  assert.ok(Date.now() - t0 < 10_000, 'it did not wait for the CLI');
});

test('names and queries that look like options stay one argument each (nothing can be injected as a CLI flag)', async () => {
  const c = new BuzzClient(async () => base);
  const created = await c.createChannel({ name: '--visibility=open -x', visibility: 'private', description: '--admin' });
  assert.deepEqual(JSON.parse(created ?? '[]'), [
    'channels',
    'create',
    '--name=--visibility=open -x',
    '--type',
    'stream',
    '--visibility',
    'private',
    '--description=--admin',
  ]);
  const found = (await c.search('--limit 999 "x"', 5)) as { echo: string[] };
  assert.deepEqual(found.echo, ['messages', 'search', '--query=--limit 999 "x"', '--limit', '5']);
});
