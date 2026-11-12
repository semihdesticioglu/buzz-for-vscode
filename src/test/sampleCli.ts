// A small, well-formed Buzz workspace behind the CLI's read commands: two channels (and an open one to join), two
// conversations with the same person, threads with replies, members with an agent, presence, mentions and search.
// test/harness/cli_capture_check.js records it with test/cli-contract/capture.js to check the capture, the anonymiser
// and the contract tests end to end without a real Buzz. (fakeCli.ts, by contrast, prints broken rows on purpose.)
//   node sampleCli.js ...arguments      (needs BUZZ_PRIVATE_KEY, as the CLI does)

export const ME = 'a1'.repeat(32);
export const ADA = 'ad'.repeat(32);
export const AGENT = 'b0'.repeat(32);
export const LIN = 'c3'.repeat(32);
export const DATA = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
export const NOTES = '0e984725-c51c-4bf4-9960-e1c80e27aba0';
export const OPEN = '9b2d6f1e-3c4a-4d5e-8f70-112233445566';
export const DM_NEW = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
export const DM_OLD = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';

const T = Math.floor(Date.now() / 1000); // the sample's times are relative to now, so "the last two weeks" finds them
const DAY = 86_400;
const id = (n: number) => n.toString(16).padStart(4, '0').repeat(16);

interface Ev {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}
const ev = (n: number, ch: string, at: number, pubkey: string, content: string, root?: string, mention?: string): Ev => ({
  id: id(n),
  pubkey,
  kind: 9,
  created_at: T + at,
  content,
  tags: [['h', ch], ...(root ? [['e', root, '', 'root']] : []), ...(mention ? [['p', mention]] : [])],
  sig: 'ab'.repeat(64),
});

export const MESSAGES: Ev[] = [
  ev(1, DATA, -5000, ADA, 'Can someone check the ranking query in sql/rank.sql:42? Ranking ties look wrong.', undefined, ME),
  ev(2, DATA, -4900, AGENT, 'Looking at the ranking query now.', id(1)),
  ev(3, DATA, -4800, AGENT, 'The ranking ties come from a missing ORDER BY; proposed fix on feature/abc-1201-rank-ties.', id(1), ME),
  ev(4, DATA, -4700, ME, 'Thanks, merging after review.', id(1)),
  ev(5, DATA, -3000, LIN, 'Release notes for the sprint review are in the doc.'),
  ev(6, DATA, -2900, ADA, 'Added the ranking fix to the notes.', id(5)),
  ev(7, DATA, -100, ADA, 'Monthly report numbers are ready for a second look.', undefined, ME),
  ev(8, DM_NEW, -50, ADA, 'Do you have a minute for the ranking change?', undefined, ME),
  ev(9, DM_OLD, -20 * DAY, ADA, 'Welcome to the team!'),
];

export const PROFILES = [
  { pubkey: ME, name: 'sam', display_name: 'Sam Reader', about: 'Data engineer on the reporting team' },
  { pubkey: ADA, name: 'ada', display_name: 'Ada Lovelace', picture: 'https://cdn.sample.example/ada.png', nip05: 'ada@sample.example' },
  { pubkey: AGENT, name: 'review_agent_claude', display_name: 'review_agent_claude', bot: true },
  { pubkey: LIN, name: 'lin' },
];

export const CHANNELS = [
  { channel_id: DATA, name: 'data-dev', description: 'Data team channel', created_at: T - 90 * DAY, type: 'stream', visibility: 'open' },
  { channel_id: NOTES, name: 'release-notes', description: 'Sprint release notes', created_at: T - 60 * DAY, type: 'stream', visibility: 'private' },
  { channel_id: DM_NEW, name: '' }, // a direct message is also listed as a channel, without a name
];
const OPEN_CHANNEL = { channel_id: OPEN, name: 'general', description: 'Everyone', created_at: T - 200 * DAY, type: 'stream', visibility: 'open' };

function run(args: string[]): void {
  const out = (v: unknown) => void process.stdout.write(JSON.stringify(v));
  const flag = (f: string) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args[0] === '--version') {
    process.stdout.write('buzz 0.0.0-sample\n');
    return;
  }
  if (!process.env.BUZZ_PRIVATE_KEY) {
    process.stderr.write(JSON.stringify({ error: 'auth_error', message: 'BUZZ_PRIVATE_KEY is required' }) + '\n');
    process.exitCode = 3;
    return;
  }
  const limit = Number(flag('--limit') ?? 50);
  const newestFirst = (list: Ev[]) => [...list].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  const mentionsMe = (e: Ev) => e.tags.some((t) => t[0] === 'p' && t[1] === ME);
  switch (args.slice(0, 2).join(' ')) {
    case 'users get': {
      const keys = args.flatMap((a, i) => (a === '--pubkey' ? [args[i + 1]] : []));
      return out(keys.length ? PROFILES.filter((p) => keys.includes(p.pubkey)) : [PROFILES[0]]);
    }
    case 'channels list':
      return out(args.includes('--member') ? CHANNELS : [...CHANNELS.filter((c) => c.name), OPEN_CHANNEL]);
    case 'dms list':
      return out([
        { dm_id: DM_NEW, participants: [ME, ADA], created_at: T - 2 * DAY },
        { dm_id: DM_OLD, participants: [ME, ADA], created_at: T - 30 * DAY },
      ]);
    case 'messages get': {
      const [ch, since, before] = [flag('--channel'), flag('--since'), flag('--before')];
      const inPage = (e: Ev) =>
        e.tags[0][1] === ch && (since === undefined || e.created_at >= Number(since)) && (before === undefined || e.created_at < Number(before));
      return out(newestFirst(MESSAGES.filter(inPage)));
    }
    case 'messages thread': {
      const root = flag('--event');
      return out(newestFirst(MESSAGES.filter((e) => e.id === root || e.tags.some((t) => t[0] === 'e' && t[1] === root))));
    }
    case 'channels members':
      return out([
        { pubkey: ME, role: 'owner' },
        { pubkey: ADA, role: 'member' },
        { pubkey: AGENT, role: 'member' },
        { pubkey: LIN, role: 'member' },
      ]);
    case 'users presence': {
      // as the real CLI: only the people with a live presence entry are listed
      const live: Record<string, string> = { [AGENT]: 'online', [ADA]: 'away' };
      return out(
        String(flag('--pubkeys') ?? '')
          .split(',')
          .filter((k) => live[k])
          .map((k) => ({ pubkey: k, status: live[k], updated_at: T })),
      );
    }
    case 'feed get':
      return out(newestFirst(MESSAGES.filter((e) => e.created_at >= Number(flag('--since') ?? 0) && mentionsMe(e))));
    case 'messages search': {
      const q = (args.find((a) => a.startsWith('--query=')) ?? '').slice('--query='.length).toLowerCase();
      return out(newestFirst(MESSAGES.filter((e) => q && e.content.toLowerCase().includes(q))));
    }
    default:
      process.stderr.write(JSON.stringify({ error: 'user_error', message: `the sample does not know: ${args.slice(0, 2).join(' ')}` }) + '\n');
      process.exitCode = 1;
  }
}

if (require.main === module) run(process.argv.slice(2));
