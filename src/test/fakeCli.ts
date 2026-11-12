// Fake buzz CLI for tests: echoes the arguments, stdin and the relay address back.
const args = process.argv.slice(2);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const names: Record<string, string> = { [A]: 'Ada', [B]: 'review_agent_claude' };

function out(v: unknown): void {
  process.stdout.write(JSON.stringify(v));
}

if (!process.env.BUZZ_PRIVATE_KEY) {
  process.stderr.write(JSON.stringify({ error: 'auth_error', message: 'BUZZ_PRIVATE_KEY is required' }) + '\n');
  process.exit(3);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const cmd = args.slice(0, 2).join(' ');
  switch (cmd) {
    case 'users get': {
      const keys = args.flatMap((a, i) => (a === '--pubkey' ? [args[i + 1]] : []));
      out((keys.length ? keys : [A]).map((k) => ({ pubkey: k, display_name: names[k] ?? 'unknown' })));
      break;
    }
    case 'messages get':
    case 'messages thread':
    case 'feed get':
      if (cmd === 'messages get' && args.includes('wrapped')) {
        out({ messages: [] }); // a CLI version that wrapped its list
        break;
      }
      // one message among rows a broken CLI could print: a null, a number for content, a row without a key
      out([
        null,
        { id: 'e'.repeat(64), pubkey: A, kind: 9, created_at: 1700000000, content: 'hello', tags: [['h', 'c1']] },
        { id: 'f'.repeat(64), pubkey: A, kind: 9, created_at: 1700000001, content: 42, tags: [] },
        { id: 'g'.repeat(64), kind: 9, created_at: 1700000002, content: 'no key', tags: [] },
      ]);
      break;
    case 'channels list':
      out([
        null, // a row that is not an object is dropped, not dereferenced
        { channel_id: 'c2', name: 'zeta' },
        { channel_id: 'c1', name: 'alfa' },
        { channel_id: 'd1', name: '' },
        { channel_id: 'd2', name: 'dm' }, // an older direct message, listed only as a channel
      ]);
      break;
    case 'dms list':
      out([{ dm_id: 'd1', participants: [A, B] }]);
      break;
    case 'channels members':
      out([
        { pubkey: A, role: 'owner' },
        { pubkey: B, role: 'member' },
      ]);
      break;
    case 'messages send':
      out({ event_id: 'e'.repeat(64), accepted: true, message: JSON.stringify({ args, input, relay: process.env.BUZZ_RELAY_URL }) });
      break;
    case 'users presence': {
      // as the real CLI: only the people with a live presence entry are listed (B), the others are left out
      const keys = String(args[args.indexOf('--pubkeys') + 1] ?? '').split(',');
      out(keys.filter((k) => k === B).map((k) => ({ pubkey: k, status: 'online', updated_at: 1700000000 })));
      break;
    }
    case 'channels create':
      out({ channel_id: JSON.stringify(args) }); // the arguments it got, to check how they were split
      break;
    case 'messages search':
      out({ echo: args });
      break;
    case 'slow wait':
      setTimeout(() => out([]), 20_000); // a CLI that hangs (a relay that never answers)
      break;
    case 'fail net':
      process.stderr.write('connection refused\n');
      process.exit(2);
      break;
    default:
      process.stderr.write(JSON.stringify({ error: 'user_error', message: `unknown command: ${cmd}` }) + '\n');
      process.exit(1);
  }
});
