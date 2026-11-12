import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BuzzError, CliExit, NostrEvent, Presence } from '../core';
import { PresenceTracker } from '../presence';

const A = 'a'.repeat(64); // a person
const B = 'b'.repeat(64); // a person
const AG = 'c'.repeat(64); // an agent
const ME = 'f'.repeat(64);

function world(answers: (Record<string, Presence> | Error)[]) {
  let t = 1_000_000_000_000;
  const asked: string[][] = [];
  const client = {
    myPubkey: ME,
    nameOf: (p: string) => p.slice(0, 4),
    isAgent: (p: string) => p === AG,
    presence: async (keys: string[]) => {
      asked.push(keys);
      const a = answers.shift() ?? {};
      if (a instanceof Error) throw a;
      return a;
    },
  };
  const tracker = new PresenceTracker(client as never, () => t);
  return { tracker, asked, tick: (ms: number) => (t += ms), now: () => t };
}
const msg = (pubkey: string, createdAt: number): NostrEvent => ({ id: '1'.repeat(64), pubkey, kind: 9, created_at: createdAt, content: 'x', tags: [] });

test('someone Buzz no longer lists is offline, not left at the last "online" (Buzz Desktop closed, the entry lapsed)', async () => {
  const w = world([{ [A]: 'online', [B]: 'away' }, { [B]: 'away' }]);
  await w.tracker.refresh([A, B]);
  assert.deepEqual(w.tracker.effective(), { [A]: 'online', [B]: 'away' });
  w.tick(60_000);
  await w.tracker.refresh([A, B]); // A's entry lapsed: the CLI leaves A out
  assert.deepEqual(w.tracker.effective(), { [A]: 'offline', [B]: 'away' });
});

test('agents never listed are offline once asked about (the agents-offline bar can show), unknown before', async () => {
  const w = world([{}]);
  assert.deepEqual(w.tracker.effective(), {}, 'nothing asked yet: nothing known');
  await w.tracker.refresh([AG]);
  assert.equal(w.tracker.effective()[AG], 'offline');
});

test('an answer goes stale: after five minutes without asking again it says nothing', async () => {
  const w = world([{ [A]: 'online' }]);
  await w.tracker.refresh([A]);
  w.tick(4 * 60_000);
  assert.equal(w.tracker.effective()[A], 'online');
  w.tick(61_000);
  assert.equal(w.tracker.effective()[A], undefined);
});

test('with Buzz answering presence, a recent message does not make its author online; typing does', async () => {
  const w = world([{}]);
  await w.tracker.refresh([A, B]);
  w.tracker.saw(msg(A, Math.floor(w.now() / 1000) - 30)); // wrote 30 s ago (by the sender's clock)
  w.tracker.saw(msg(A, Math.floor(w.now() / 1000) + 3600)); // a clock an hour ahead
  assert.equal(w.tracker.effective()[A], 'offline', 'Buzz says offline: offline, as in Buzz Desktop');
  assert.ok(w.tracker.typingSignal({ pubkey: B, active: true, thread: undefined } as never));
  assert.equal(w.tracker.effective()[B], 'online', 'typing is a live signal from their client');
  w.tick(9_000);
  assert.equal(w.tracker.effective()[B], 'offline', 'the typing signal expired');
});

test('an older CLI without presence: who wrote in the last two minutes is the best guess', async () => {
  const w = world([new BuzzError(CliExit.Rejected, 'user_error', 'unknown command: users presence')]);
  assert.equal(await w.tracker.refresh([A]), false);
  w.tracker.saw(msg(A, Math.floor(w.now() / 1000) - 30));
  assert.equal(w.tracker.effective()[A], 'online');
  w.tick(120_000);
  assert.equal(w.tracker.effective()[A], undefined);
  assert.equal(await w.tracker.refresh([A]), false, 'not asked again');
  assert.equal(w.asked.length, 1);
});

test('a failed read (network) is tried again after five minutes; the last answers stay until they go stale', async () => {
  const w = world([{ [A]: 'online' }, new BuzzError(CliExit.Network, 'network', 'relay unreachable'), { [A]: 'online' }]);
  await w.tracker.refresh([A]);
  assert.equal(await w.tracker.refresh([A]), false);
  assert.equal(w.tracker.effective()[A], 'online');
  w.tick(60_000);
  assert.equal(await w.tracker.refresh([A]), false, 'backing off');
  assert.equal(w.asked.length, 2);
  w.tick(5 * 60_000);
  assert.equal(await w.tracker.refresh([A]), true);
});

test('the "working" guess: for an agent asked in the thread on screen, never for one Buzz reports offline, gone after three minutes or an answer', async () => {
  const w = world([{ [AG]: 'online' }, {}]);
  await w.tracker.refresh([AG]);
  const now = Math.floor(w.now() / 1000);
  w.tracker.expect([AG, A], 'T1', now); // only agents are expected to answer
  const s = w.tracker.state('T1');
  assert.deepEqual(s.items, [{ name: AG.slice(0, 4), isAgent: true, real: false }]);
  assert.deepEqual(s.busy, ['T1']);
  assert.equal(w.tracker.expecting, true);
  assert.deepEqual(w.tracker.state('T2').items, [], 'another thread on screen: the list still shows T1 as busy');
  assert.deepEqual(w.tracker.state('T2').busy, ['T1']);
  w.tracker.saw(msg(AG, now + 5)); // it answered
  assert.deepEqual(w.tracker.state('T1').items, []);
  w.tracker.expect([AG], 'T1', now + 10);
  w.tick(3 * 60_000 + 11_000);
  assert.deepEqual(w.tracker.state('T1').busy, [], 'three minutes without an answer: the guess goes away');
  await w.tracker.refresh([AG]); // Buzz no longer lists it: offline
  w.tracker.expect([AG], 'T1', Math.floor(w.now() / 1000));
  assert.deepEqual(w.tracker.state('T1').items, [], 'an offline agent is not shown as working');
});

test('typing shows in its thread, in the channel when outside any thread, and goes away after a few seconds', () => {
  const w = world([]);
  assert.equal(w.tracker.typingSignal({ pubkey: ME, active: true, thread: 'T1' }), false, 'my own typing changes nothing');
  w.tracker.typingSignal({ pubkey: A, active: true, thread: 'T1' });
  w.tracker.typingSignal({ pubkey: B, active: true });
  const s = w.tracker.state('T1');
  assert.deepEqual(s.items, [{ name: A.slice(0, 4), isAgent: false, real: true }]);
  assert.deepEqual(s.channel, [{ name: B.slice(0, 4), isAgent: false, real: true }]);
  assert.ok(s.nextExpiry && s.nextExpiry > w.now(), 'the webview is told when to look again');
  w.tracker.typingSignal({ pubkey: A, active: false, thread: 'T1' });
  assert.deepEqual(w.tracker.state('T1').items, [], 'stopped typing');
  w.tick(9_000);
  assert.deepEqual(w.tracker.state('T1').channel, [], 'a signal not renewed expires');
});
