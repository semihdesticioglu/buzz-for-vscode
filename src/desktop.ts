// Starts Buzz Desktop when the agents are offline: they run inside it, so without it nobody answers.
// Nothing else is touched; the app's own data stays its own.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as nodePath from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import * as cfg from './config';
import { desktopCandidates } from './core';
import { t } from './i18n';

const START_GRACE_MS = 2_000; // a process still running after this long has started

/** Where Buzz Desktop is: the setting, else the first place it is usually installed. */
export function findDesktop(): string | undefined {
  const set = cfg.desktopPath();
  const all = set ? [set] : desktopCandidates(process.env, process.platform, os.homedir(), cfg.macApps());
  return all.find((p) => fs.existsSync(p) && looksLikeDesktop(p));
}

/** The CLI (buzz.exe) sits next to the app on Windows: only the app itself is accepted. */
function looksLikeDesktop(p: string): boolean {
  const base = nodePath.basename(p).toLowerCase();
  if (process.platform === 'win32') {
    if (base === 'buzz-desktop.exe') return true;
    // buzz.exe is the CLI wherever buzz-desktop.exe sits next to it; elsewhere it may be the app itself
    return base === 'buzz.exe' && !fs.existsSync(nodePath.join(nodePath.dirname(p), 'buzz-desktop.exe'));
  }
  if (process.platform === 'darwin') return base.endsWith('.app') || !base.includes('.');
  return true;
}

/**
 * Launches the app detached from VS Code and waits long enough to know it ran: an error (not found, not allowed),
 * an early non-zero exit or, on a Mac, what `open` complains about, comes back as a message.
 */
function launch(app: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const mac = process.platform === 'darwin';
    let child;
    try {
      child = mac ? spawn('open', [app], { stdio: ['ignore', 'ignore', 'pipe'] }) : spawn(app, [], { detached: true, stdio: 'ignore' });
    } catch (e) {
      resolve((e as Error).message);
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (d: Buffer | string) => (stderr += String(d)));
    let settled = false;
    const settle = (msg?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(msg);
    };
    const timer = setTimeout(() => settle(undefined), START_GRACE_MS);
    child.once('error', (e) => settle(e.message));
    // 'close', not 'exit': what `open` printed is all in by then
    child.once('close', (code) => settle(code === 0 || code === null ? undefined : stderr.trim() || t('desktop.exited', String(code))));
    if (!mac) child.unref();
  });
}

/** Starts Buzz Desktop; asks where it is when it cannot be found or did not start. True when it is running. */
export async function openBuzzDesktop(): Promise<boolean> {
  let app = findDesktop();
  let chosen = false;
  if (!app) {
    app = await askForApp();
    if (!app) return false;
    chosen = true;
  }
  const err = await launch(app);
  if (err) {
    void vscode.window.showErrorMessage(t('desktop.failed', err));
    return false;
  }
  if (chosen) await cfg.updateGlobal('desktopPath', app); // remembered only once it has actually started
  return true;
}

async function askForApp(): Promise<string | undefined> {
  const choose = t('desktop.select');
  const act = await vscode.window.showWarningMessage(t('desktop.notFound'), choose);
  if (act !== choose) return undefined;
  const mac = process.platform === 'darwin';
  const pick = await vscode.window.showOpenDialog({
    title: t('desktop.select'),
    canSelectMany: false,
    canSelectFiles: true,
    canSelectFolders: mac, // an app bundle is a folder
    filters: process.platform === 'win32' ? { 'buzz-desktop.exe': ['exe'] } : undefined,
  });
  const p = pick?.[0]?.fsPath;
  if (!p) return undefined;
  if (!looksLikeDesktop(p)) {
    void vscode.window.showErrorMessage(t('desktop.notApp', nodePath.basename(p)));
    return undefined;
  }
  return p;
}
