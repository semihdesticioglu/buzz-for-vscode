// Wrapper around the Buzz CLI (buzz.exe). The key is only passed in the child process environment; never written anywhere.
import { spawn } from 'child_process';
import { BuzzError, CliExit, parseCliFailure } from './core';
import { t } from './i18n';

export interface CliOptions {
  cliPath: string;
  relayUrl: string;
  key: string;
  /** In tests: cliPath=node, cliArgsPrefix=[fake-cli.js] */
  cliArgsPrefix?: string[];
  timeoutMs?: number;
}

export function runCli(o: CliOptions, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, BUZZ_PRIVATE_KEY: o.key, BUZZ_RELAY_URL: o.relayUrl };
    let child;
    try {
      child = spawn(o.cliPath, [...(o.cliArgsPrefix ?? []), ...args], { env, windowsHide: true });
    } catch (e) {
      reject(new BuzzError(CliExit.Other, 'spawn', t('err.cliStart', (e as Error).message)));
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        fn();
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new BuzzError(CliExit.Network, 'timeout', t('err.cliTimeout'))));
    }, o.timeoutMs ?? 30000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.stderr.on('data', (d: string) => (err += d));
    child.on('error', (e) => finish(() => reject(new BuzzError(CliExit.Other, 'spawn', t('err.cliStart', e.message)))));
    child.on('close', (code) => finish(() => (code === 0 ? resolve(out) : reject(parseCliFailure(code ?? 4, out, err)))));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin ?? '', 'utf8');
  });
}

export async function runJson<T>(o: CliOptions, args: string[], stdin?: string): Promise<T> {
  const out = (await runCli(o, args, stdin)).trim();
  if (!out) return null as T;
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new BuzzError(CliExit.Other, 'parse', t('err.cliParse', out.slice(0, 200)));
  }
}
