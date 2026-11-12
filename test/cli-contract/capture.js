// Records what the real Buzz CLI answers to the read-only commands the extension uses, anonymises it, and writes
// test/cli-contract/recorded.json, which src/test/cliContract.test.ts replays. Run it where Buzz works, after
// `npm run compile`:
//
//   node test/cli-contract/capture.js [--cli <path to buzz>] [--relay <relay address>] [--out <file>]
//
// - It only reads: nothing is sent to Buzz and nothing is changed there.
// - The key comes from BUZZ_PRIVATE_KEY, or is asked for without being shown. It goes to the CLI's environment, as the
//   extension passes it, and nowhere else: it is not written, logged or printed.
// - The CLI's raw answers stay in a temporary folder that is deleted at the end. What is saved has every id, key, name,
//   text and address replaced and every time shifted (src/test/anonymise.ts); saving is refused when any original
//   string, the key, the relay's address, or this computer's user or host name would still be in the file.
// - Read the saved file before you commit it; the field names it kept are listed at the end.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const opt = (name) => {
  const i = process.argv.indexOf(name);
  return i > 1 ? process.argv[i + 1] : undefined;
};
const OUT = path.resolve(opt('--out') || path.join(__dirname, 'recorded.json'));

class Refused extends Error {}
function need(rel) {
  const p = path.join(ROOT, 'out', rel);
  if (!fs.existsSync(p)) throw new Refused(`${p} is missing: run \`npm run compile\` first`);
  return require(p);
}

/** The key without echo; Ctrl+C stops. */
function askHidden(prompt) {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Refused('set BUZZ_PRIVATE_KEY: there is no terminal to ask for the key in');
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let s = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(s);
          return;
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        s = c === '\u007f' || c === '\b' ? s.slice(0, -1) : s + c;
      }
    };
    stdin.on('data', onData);
  });
}

function cliVersion(cli) {
  try {
    const [exe, pre] = /\.js$/i.test(cli) ? [process.execPath, [cli]] : [cli, []];
    return execFileSync(exe, [...pre, '--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
  } catch {
    return 'unknown';
  }
}

/** The most frequent word of five or more letters in the texts: something the search will find. */
function commonWord(text) {
  const counts = new Map();
  for (const w of text.toLowerCase().match(/\p{L}{5,20}/gu) || []) counts.set(w, (counts.get(w) || 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : undefined;
}

/** The read-only calls, through the extension's own client, so the arguments are exactly the ones it uses. */
async function readAll(client, core) {
  const step = async (label, fn) => {
    try {
      const r = await fn();
      console.log(`  ok     ${label}`);
      return r;
    } catch (e) {
      console.log(
        `  failed ${label}: ${String((e && e.message) || e)
          .split('\n')[0]
          .slice(0, 100)}`,
      );
      return undefined;
    }
  };
  await step('users get (your profile)', () => client.me());
  const channels = (await step('channels list --member', () => client.channels())) || [];
  const dms = (await step('dms list', () => client.dms())) || [];
  await step('channels and direct messages together', () => client.allChannels());
  await step('channels list (the ones you could join)', () => client.joinableChannels());
  let ch;
  let page = [];
  for (const c of channels.filter((x) => x.name).slice(0, 8)) {
    const p = (await step('messages get (the latest page of a channel)', () => client.messages(c.id, { limit: 20 }))) || [];
    if (p.length) {
      ch = c;
      page = p;
      break;
    }
  }
  if (ch) {
    const reply = page.find((e) => core.replyRootOf(e));
    await step('messages thread', () => client.thread(ch.id, reply ? core.replyRootOf(reply) : page[0].id));
    const oldest = Math.min(...page.map((e) => e.created_at));
    await step('messages get --before (an older page)', () => client.messages(ch.id, { limit: 20, before: oldest }));
    await step('messages get --since', () => client.messages(ch.id, { limit: 20, since: oldest }));
    const members = (await step('channels members', () => client.members(ch.id))) || [];
    await step('users presence', () => client.presence(members.map((m) => m.pubkey)));
    const word = commonWord(page.map((e) => e.content).join(' '));
    if (word) await step('messages search', () => client.search(word, 20));
  } else {
    console.log('  (no channel with messages: messages, threads, members, presence and search are not recorded)');
  }
  if (dms.length) await step('messages get (a direct message)', () => client.messages(dms[0].id, { limit: 10 }));
  await step('feed get (mentions of the last two weeks)', () => client.feed(Math.floor(Date.now() / 1000) - 14 * 86_400));
}

/** One output stream, anonymised: JSON as a value, anything else by its length, nothing when empty. */
function stream(name, raw, a) {
  const s = String(raw || '');
  if (!s.trim()) return {};
  try {
    return { [name]: a.value(JSON.parse(s.trim())), [`${name}Format`]: 'json' };
  } catch {
    return { [name]: a.text(s), [`${name}Format`]: 'text' };
  }
}

async function main() {
  const core = need('core.js');
  const { BuzzClient } = need('api.js');
  const { anonymiser, leaks, originalsOf, originalsOfArgs } = need(path.join('test', 'anonymise.js'));

  const cli = opt('--cli') || process.env.BUZZ_CLI || core.cliCandidates(process.env, process.platform, os.homedir()).find((p) => fs.existsSync(p));
  if (!cli || !fs.existsSync(cli)) throw new Refused('the Buzz CLI was not found: pass --cli <path to buzz>');
  let relay = opt('--relay') || process.env.BUZZ_RELAY_URL;
  if (relay) relay = core.normalizeRelay(relay);
  else {
    try {
      relay = core.relayFromAgentsMd(fs.readFileSync(path.join(os.homedir(), '.buzz', 'AGENTS.md'), 'utf8'));
    } catch {
      relay = undefined;
    }
  }
  if (!relay) throw new Refused('no relay address: pass --relay <address>, or open Buzz Desktop once (it writes ~/.buzz/AGENTS.md)');
  const key = core.sanitizeKey(
    process.env.BUZZ_PRIVATE_KEY || (await askHidden('Your Buzz private key (Buzz Desktop: Settings → Identity → Copy private key), not shown: ')),
  );
  if (!core.isValidKey(key)) throw new Refused('that is not a private key (nsec1… or 64 hex characters)');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buzz-capture-'));
  try {
    const warnings = [];
    const client = new BuzzClient(
      async () => ({ cliPath: process.execPath, cliArgsPrefix: [path.join(__dirname, 'recorder.js'), tmp, cli], relayUrl: relay, key }),
      (w) => warnings.push(w),
    );
    console.log('Reading from Buzz (read-only):');
    await readAll(client, core);
    const raw = fs
      .readdirSync(tmp)
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8')));
    if (!raw.length) throw new Refused('the CLI was not called: nothing to save');

    const a = anonymiser();
    const calls = [];
    const seen = new Set();
    for (const c of raw) {
      const args = a.args(c.args);
      const k = JSON.stringify(args);
      if (seen.has(k)) continue; // the extension asks some things more than once; the answer is the same
      seen.add(k);
      calls.push({ args, code: c.code, ...stream('stdout', c.stdout, a), ...stream('stderr', c.stderr, a) });
    }
    const version = cliVersion(cli);
    const recorded = {
      about:
        'What the real Buzz CLI printed for the read-only commands the extension uses, recorded by test/cli-contract/capture.js and anonymised (ids, keys, names, texts and addresses replaced, times shifted). Replayed by src/test/cliContract.test.ts.',
      cli: (/\d+\.\d+\.\d+[\w.+-]*/.exec(version) || ['unknown'])[0],
      recorded: new Date().toISOString().slice(0, 10),
      calls,
    };
    const text = JSON.stringify(recorded, null, 2) + '\n';
    let host;
    try {
      host = new URL(relay).hostname;
    } catch {
      host = undefined;
    }
    const secrets = [key, core.privateKeyHex(key), relay, host, os.userInfo().username, os.hostname()].filter(Boolean);
    // the originals are collected again from the raw answers, without the anonymiser: a mistake in it shows here
    const originals = new Set();
    for (const c of raw) {
      originalsOfArgs(c.args, originals);
      for (const stream of [c.stdout, c.stderr]) {
        const t = String(stream || '').trim();
        if (!t) continue;
        try {
          originalsOf(JSON.parse(t), undefined, originals);
        } catch {
          originals.add(t);
        }
      }
    }
    const left = leaks(recorded, originals, secrets);
    if (left.length) throw new Refused(`not saved: ${left.length} original string(s) would still be in the file, for example "${left[0].slice(0, 40)}"`);
    fs.writeFileSync(OUT, text);

    const commands = [
      ...new Set(
        calls.map((c) =>
          c.args
            .filter((x) => /^[a-z][a-z-]*$/.test(x))
            .slice(0, 2)
            .join(' '),
        ),
      ),
    ];
    console.log(`\nSaved ${path.relative(process.cwd(), OUT)}: ${calls.length} answers of the Buzz CLI ${recorded.cli} (${commands.join(', ')}).`);
    console.log(`Field names kept as they are: ${[...a.keys].sort().join(', ')}.`);
    console.log('Every other value was replaced. Read the file before you commit it, then run `npm test`.');
    if (warnings.length) console.log(`What the extension noticed while reading: ${warnings.join(' | ')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e instanceof Refused ? e.message : e && e.stack ? e.stack : String(e));
  process.exitCode = 1;
});
