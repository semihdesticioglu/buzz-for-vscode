import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { NostrEvent, pubkeyFromPrivate } from '../core';
import { LiveRelay, LiveState } from '../liveRelay';
import { signEvent, verifyEvent } from '../nostr';

const KEY = 'b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef';
const OTHER = '0000000000000000000000000000000000000000000000000000000000000003';
const tag = (ev: NostrEvent, n: string) => ev.tags.find((t) => t[0] === n)?.[1];

/** Fake relay that behaves like Buzz: asks for AUTH, verifies the signature, then accepts subscriptions. */
// `query`: how one-shot reads (subscription ids starting with q-) are answered: completely (EOSE), never finished,
// refused (CLOSED), or cut off by a dropped connection
async function fakeRelay(opts: { requireAuth?: boolean; rejectAuth?: boolean; query?: 'eose' | 'silent' | 'closed' | 'drop' } = {}) {
  const requireAuth = opts.requireAuth ?? true;
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  const st = { conns: 0, auths: [] as NostrEvent[], reqs: [] as unknown[][], events: [] as NostrEvent[], closedBeforeAuth: 0, closes: [] as string[] };
  wss.on('connection', (ws) => {
    const n = ++st.conns;
    let authed = !requireAuth;
    if (requireAuth) ws.send(JSON.stringify(['AUTH', `chal-${n}`]));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m[0] === 'AUTH') {
        const ev = m[1] as NostrEvent;
        st.auths.push(ev);
        const ok = !opts.rejectAuth && verifyEvent(ev) && ev.kind === 22242 && tag(ev, 'challenge') === `chal-${n}` && tag(ev, 'relay') === url;
        authed = ok;
        ws.send(JSON.stringify(['OK', ev.id, ok, ok ? '' : 'auth-required: verification failed']));
      } else if (m[0] === 'EVENT') {
        if (authed && verifyEvent(m[1])) st.events.push(m[1]);
      } else if (m[0] === 'REQ') {
        if (!authed) {
          st.closedBeforeAuth++;
          ws.send(JSON.stringify(['CLOSED', m[1], 'auth-required: please authenticate']));
          return;
        }
        st.reqs.push(m);
        const ev = signEvent({ kind: 9, tags: [['h', 'channel-1']], content: `message ${n}`, created_at: 1762500000 + n }, OTHER);
        const mode = String(m[1]).startsWith('q-') ? (opts.query ?? 'eose') : 'eose';
        if (mode === 'closed') {
          ws.send(JSON.stringify(['CLOSED', m[1], 'error: too many requests']));
          return;
        }
        ws.send(JSON.stringify(['EVENT', m[1], ev]));
        if (mode === 'eose') ws.send(JSON.stringify(['EOSE', m[1]]));
        if (mode === 'drop') setTimeout(() => ws.terminate(), 50); // after the event went out
      } else if (m[0] === 'CLOSE') {
        st.closes.push(String(m[1]));
      }
    });
  });
  return {
    url,
    st,
    dropAll: () => wss.clients.forEach((c) => c.terminate()),
    // the server stops reading: like a socket that died during sleep or a VPN switch (no close reaches the client)
    freeze: () => wss.clients.forEach((c) => (c as unknown as { _socket: { pause(): void } })._socket.pause()),
    close: () => new Promise((r) => wss.close(r)),
  };
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('live: authenticates, subscribes, messages arrive instantly', async () => {
  const relay = await fakeRelay();
  const live = new LiveRelay(relay.url, KEY, { backoffMs: [50] });
  const got: [string, NostrEvent][] = [];
  const states: LiveState[] = [];
  live.onEvent((id, ev) => got.push([id, ev]));
  live.onState((s) => states.push(s));
  live.subscribe('chat', [{ kinds: [9], '#h': ['channel-1'] }]); // subscribing before connecting is allowed
  live.start();
  try {
    await waitFor(() => got.length === 1);
    assert.equal(got[0][0], 'chat');
    assert.equal(got[0][1].content, 'message 1');
    assert.equal(relay.st.auths[0].pubkey, pubkeyFromPrivate(KEY));
    assert.equal(relay.st.closedBeforeAuth, 0); // nothing was requested before authenticating
    assert.deepEqual(relay.st.reqs[0], ['REQ', 'chat', { kinds: [9], '#h': ['channel-1'] }]);
    assert.ok(states.some((s) => s.state === 'live'));
  } finally {
    live.stop();
    await relay.close();
  }
});

test('after a drop it reconnects, authenticates with the new challenge and renews subscriptions', async () => {
  const relay = await fakeRelay();
  const live = new LiveRelay(relay.url, KEY, { backoffMs: [50] });
  const got: NostrEvent[] = [];
  live.onEvent((_, ev) => got.push(ev));
  live.subscribe('chat', [{ kinds: [9] }]);
  live.start();
  try {
    await waitFor(() => got.length === 1);
    relay.dropAll();
    await waitFor(() => got.length === 2);
    assert.equal(got[1].content, 'message 2');
    assert.equal(relay.st.auths.length, 2);
    assert.equal(tag(relay.st.auths[1], 'challenge'), 'chal-2');
    assert.equal(live.state.state, 'live');
  } finally {
    live.stop();
    await relay.close();
  }
});

test('nothing is sent after unsubscribing or stopping', async () => {
  const relay = await fakeRelay();
  const live = new LiveRelay(relay.url, KEY, { backoffMs: [50] });
  live.subscribe('a', [{ kinds: [9] }]);
  live.start();
  try {
    await waitFor(() => relay.st.reqs.length === 1);
    live.unsubscribe('a');
    live.subscribe('b', [{ kinds: [7] }]);
    await waitFor(() => relay.st.reqs.length === 2);
    assert.equal(relay.st.reqs[1][1], 'b');
    live.stop();
    assert.equal(live.state.state, 'off');
  } finally {
    live.stop();
    await relay.close();
  }
});

test('if the relay rejects auth the state is error and the reason is visible', async () => {
  const relay = await fakeRelay({ rejectAuth: true });
  const live = new LiveRelay(relay.url, KEY, { backoffMs: [5000] });
  live.subscribe('chat', [{ kinds: [9] }]);
  live.start();
  try {
    await waitFor(() => live.state.state === 'error');
    assert.match(live.state.detail ?? '', /authentication failed: auth-required/);
    assert.equal(relay.st.reqs.length, 0);
  } finally {
    live.stop();
    await relay.close();
  }
});

test('if the relay asks for no auth, subscriptions go out after a short wait', async () => {
  const relay = await fakeRelay({ requireAuth: false });
  const live = new LiveRelay(relay.url, KEY, { authWaitMs: 80, backoffMs: [50] });
  const got: NostrEvent[] = [];
  live.onEvent((_, ev) => got.push(ev));
  live.subscribe('chat', [{ kinds: [9] }]);
  live.start();
  try {
    await waitFor(() => got.length === 1);
    assert.equal(relay.st.auths.length, 0);
    assert.equal(live.state.state, 'live');
  } finally {
    live.stop();
    await relay.close();
  }
});

test('signed events can be published once live; nothing is sent before that', async () => {
  const relay = await fakeRelay();
  const live = new LiveRelay(relay.url, KEY, { backoffMs: [50] });
  const typing = signEvent({ kind: 20002, tags: [['h', 'channel-1']], content: '' }, KEY);
  assert.equal(live.publish(typing), false);
  live.subscribe('chat', [{ kinds: [9] }]);
  live.start();
  try {
    await waitFor(() => live.state.state === 'live' && relay.st.reqs.length === 1);
    assert.equal(live.publish(typing), true);
    await waitFor(() => relay.st.events.length === 1);
    assert.equal(relay.st.events[0].id, typing.id);
    assert.equal(relay.st.events[0].kind, 20002);
  } finally {
    live.stop();
    await relay.close();
  }
});

test('a connection that stops answering pings is dropped and reconnected (sleep, VPN switch)', async () => {
  const relay = await fakeRelay();
  // a ping every 250 ms: short enough for a test, long enough that a busy machine's pause is not taken for a dead socket
  const live = new LiveRelay(relay.url, KEY, { backoffMs: [50], pingMs: 250 });
  live.subscribe('s1', [{ kinds: [9] }]);
  live.start();
  try {
    await waitFor(() => live.state.state === 'live', 8000);
    relay.freeze();
    await waitFor(() => relay.st.conns >= 2, 8000);
    await waitFor(() => live.state.state === 'live' && relay.st.reqs.length >= 2, 8000);
  } finally {
    // also when it fails: a relay left running keeps the test process alive (it reconnects for ever)
    live.stop();
    relay.dropAll();
    await relay.close();
  }
});

test('the live connection works over wss:// (TLS); a certificate this computer does not trust is refused and named', (t) => {
  // a certificate for localhost, made here (openssl ships with Git for Windows, macOS and Linux)
  const dir = mkdtempSync(join(tmpdir(), 'buzz-tls-'));
  try {
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-days',
          '2',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1',
        ],
        { stdio: 'ignore' },
      );
    } catch {
      t.skip('openssl is not available to make a test certificate');
      return;
    }
    const run = (trusted: boolean) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.NODE_EXTRA_CA_CERTS;
      if (trusted) env.NODE_EXTRA_CA_CERTS = cert; // as a company certificate installed on the computer
      // a generous limit: a loaded machine or CI runner starts Node slowly
      const out = execFileSync(process.execPath, [join(__dirname, 'tlsRelay.js'), cert, key], { env, encoding: 'utf8', timeout: 90_000 });
      return JSON.parse(out.trim().split('\n').pop() ?? '{}');
    };
    const ok = run(true);
    assert.deepEqual(ok.events, ['over TLS'], JSON.stringify(ok));
    assert.ok(ok.authOk, 'authenticated, the AUTH event naming the wss:// address: ' + ok.relayTag);
    assert.ok(ok.states.some((s: { state: string }) => s.state === 'live'));
    const refused = run(false);
    assert.deepEqual(refused.events, [], 'nothing is read over a connection whose certificate is not trusted');
    const err = refused.states.find((s: { state: string }) => s.state === 'error');
    assert.ok(err && err.reason === 'certificate' && /certificate/i.test(err.detail), JSON.stringify(refused.states));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a one-shot read is complete only when the relay says so (EOSE), and its subscription is closed afterwards', async () => {
  const relay = await fakeRelay();
  const live = new LiveRelay(relay.url, KEY, { backoffMs: [50] });
  assert.equal(await live.query([{ kinds: [9] }]), undefined, 'not connected: no answer, so the caller reads over the CLI');
  live.start();
  try {
    await waitFor(() => live.state.state === 'live');
    const r = await live.query([{ kinds: [9], limit: 10 }], 3000);
    assert.ok(r && r.complete && r.reason === 'eose' && r.events.length === 1, JSON.stringify(r));
    await waitFor(() => relay.st.closes.length === 1);
    assert.ok(relay.st.closes[0].startsWith('q-'), 'the read closes its own subscription');
  } finally {
    live.stop();
    await relay.close();
  }
});

test('a read the relay never finishes, refuses, or cuts off is incomplete, and keeps what did arrive', async () => {
  for (const [mode, reason, kept] of [
    ['silent', 'timeout', 1],
    ['closed', 'closed', 0],
    ['drop', 'disconnected', 1],
  ] as const) {
    const relay = await fakeRelay({ query: mode });
    const live = new LiveRelay(relay.url, KEY, { backoffMs: [5000] });
    live.start();
    try {
      await waitFor(() => live.state.state === 'live');
      const r = await live.query([{ kinds: [9] }], 700);
      assert.ok(r && !r.complete && r.reason === reason, `${mode}: ${JSON.stringify(r)}`);
      assert.equal(r.events.length, kept, `${mode}: what arrived is kept`);
    } finally {
      live.stop();
      relay.dropAll();
      await relay.close();
    }
  }
});
