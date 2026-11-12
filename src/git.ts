// One way to run git for the whole extension: a text result, a timeout, file names as they are
// (core.quotePath=false keeps Turkish letters readable instead of octal escapes).
import { execFile } from 'child_process';

export interface GitOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

const DEFAULTS: Required<GitOptions> = { timeoutMs: 20_000, maxBuffer: 64 * 1024 * 1024 };
const quiet = ['-c', 'core.quotePath=false'];

/** Runs git and resolves with its output; rejects with git's own message when it fails. */
export function runGit(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const o = { ...DEFAULTS, ...opts };
  return new Promise((resolve, reject) =>
    execFile('git', [...quiet, ...args], { cwd, windowsHide: true, timeout: o.timeoutMs, maxBuffer: o.maxBuffer }, (err, out, errOut) =>
      err ? reject(new Error((errOut || err.message).trim())) : resolve(out),
    ),
  );
}

/** Like runGit, for binary output (file contents). */
export function runGitBytes(cwd: string, args: string[], opts: GitOptions = {}): Promise<Buffer> {
  const o = { ...DEFAULTS, ...opts };
  return new Promise((resolve, reject) =>
    execFile('git', [...quiet, ...args], { cwd, windowsHide: true, timeout: o.timeoutMs, maxBuffer: o.maxBuffer, encoding: 'buffer' }, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  );
}
