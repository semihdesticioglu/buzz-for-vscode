// Run by live.test.ts in a process of its own (the trust of a certificate is decided when Node starts):
// a relay over wss:// (TLS) that behaves like Buzz, and the extension's live connection against it.
//   node tlsRelay.js <cert.pem> <key.pem>   -> prints one JSON line with what happened
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { NostrEvent } from '../core';
import { LiveRelay } from '../liveRelay';
import { signEvent, verifyEvent } from '../nostr';

const KEY = 'b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef';
const OTHER = '0000000000000000000000000000000000000000000000000000000000000003';
const tag = (ev: NostrEvent, n: string) => ev.tags.find((t) => t[0] === n)?.[1];

async function main(): Promise<void> {
  const [cert, key] = process.argv.slice(2);
  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) });
  const wss = new WebSocketServer({ server });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `wss://localhost:${(server.address() as { port: number }).port}`;
  const seen = { authOk: false, relayTag: '' };
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify(['AUTH', 'chal-1']));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m[0] === 'AUTH') {
        const ev = m[1] as NostrEvent;
        seen.relayTag = tag(ev, 'relay') ?? '';
        seen.authOk = verifyEvent(ev) && tag(ev, 'challenge') === 'chal-1' && seen.relayTag === url;
        ws.send(JSON.stringify(['OK', ev.id, seen.authOk, '']));
      } else if (m[0] === 'REQ') {
        ws.send(JSON.stringify(['EVENT', m[1], signEvent({ kind: 9, tags: [['h', 'c1']], content: 'over TLS', created_at: 1762500000 }, OTHER)]));
        ws.send(JSON.stringify(['EOSE', m[1]]));
      }
    });
  });
  const live = new LiveRelay(url, KEY, { backoffMs: [60_000] });
  const events: string[] = [];
  const states: { state: string; reason?: string; detail?: string }[] = [];
  live.onEvent((_sub, ev) => events.push(ev.content));
  live.onState((s) => states.push({ state: s.state, reason: s.reason, detail: s.detail }));
  live.subscribe('s1', [{ kinds: [9] }]);
  live.start();
  const end = Date.now() + 8000;
  while (Date.now() < end && !events.length && !states.some((s) => s.state === 'error')) await new Promise((r) => setTimeout(r, 50));
  live.stop();
  wss.clients.forEach((c) => c.terminate());
  await new Promise((r) => wss.close(r));
  await new Promise((r) => server.close(r));
  process.stdout.write(JSON.stringify({ url, ...seen, events, states }) + '\n');
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ crash: String((e as Error)?.stack ?? e) }) + '\n');
  process.exitCode = 1;
});
