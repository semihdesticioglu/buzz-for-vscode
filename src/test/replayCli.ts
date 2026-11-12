// Replays the Buzz CLI from a recording (test/cli-contract/recorded.json, written by test/cli-contract/capture.js):
// prints what the real CLI printed for the same arguments, with its exit code. `users get --pubkey …` is answered from
// every profile in the recording, as the CLI answers for any set of keys. Arguments that were not recorded are an
// error, so a test notices when the extension asks the CLI something new.
//   node replayCli.js <recording.json> ...arguments
import { readFileSync } from 'node:fs';

interface Call {
  args: string[];
  code: number | null;
  stdout?: unknown;
  stdoutFormat?: string;
  stderr?: unknown;
  stderrFormat?: string;
}

const [file, ...args] = process.argv.slice(2);
const rec = JSON.parse(readFileSync(file, 'utf8')) as { calls: Call[] };
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const print = (v: unknown, format: string | undefined, to: NodeJS.WriteStream) => {
  if (format === 'json') to.write(JSON.stringify(v));
  else if (typeof v === 'string' && v) to.write(v);
};

const call = rec.calls.find((c) => same(c.args, args));
if (call) {
  print(call.stdout, call.stdoutFormat, process.stdout);
  print(call.stderr, call.stderrFormat, process.stderr);
  process.exitCode = call.code ?? 4;
} else if (args[0] === 'users' && args[1] === 'get' && args.includes('--pubkey')) {
  const want = new Set(args.flatMap((a, i) => (a === '--pubkey' ? [args[i + 1]] : [])));
  const found = new Map<string, unknown>();
  for (const c of rec.calls) {
    if (c.args[0] !== 'users' || c.args[1] !== 'get' || c.stdoutFormat !== 'json' || !Array.isArray(c.stdout)) continue;
    for (const p of c.stdout) {
      const k = p && typeof p === 'object' ? (p as Record<string, unknown>).pubkey : undefined;
      if (typeof k === 'string' && want.has(k) && !found.has(k)) found.set(k, p);
    }
  }
  process.stdout.write(JSON.stringify([...found.values()]));
} else {
  process.stderr.write(JSON.stringify({ error: 'not_recorded', message: `not in the recording: ${args.join(' ')}` }) + '\n');
  process.exitCode = 1;
}
