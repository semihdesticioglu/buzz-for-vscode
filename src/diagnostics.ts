// "Buzz: Diagnostics": what the extension sees on this machine, written to the connection log, so a colleague who
// says "it does not work" can paste one block. Secrets are reported as present or missing, never shown.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { checkedOut } from './agentGit';
import { agentRepoDirs } from './agentRepo';
import type { BuzzClient } from './api';
import * as cfg from './config';
import { friendlyError } from './core';
import { findDesktop } from './desktop';
import { lang } from './i18n';
import { isJiraCloud } from './jira';
import type { LiveManager } from './live';
import { log } from './log';
import type { Secrets } from './setup';

export interface DiagnosticsDeps {
  ctx: vscode.ExtensionContext;
  client: BuzzClient;
  live: LiveManager;
  secrets: Secrets;
}

const version = (exe: string): Promise<string> =>
  new Promise((resolve) =>
    execFile(exe, ['--version'], { timeout: 5000, windowsHide: true }, (err, out, errOut) =>
      resolve(err ? `error: ${(errOut || err.message).trim()}` : out.trim()),
    ),
  );

export async function runDiagnostics(d: DiagnosticsDeps): Promise<void> {
  const lines: string[] = [];
  const add = (k: string, v: unknown) => lines.push(`  ${k}: ${String(v)}`);
  add('extension', `buzz-for-vscode ${String(d.ctx.extension.packageJSON.version)}`);
  add('vscode', `${vscode.version} on ${process.platform} ${process.arch}, node ${process.versions.node}`);
  add('language', lang());
  const cli = cfg.cliPath();
  add('cli', `${cli} (${fs.existsSync(cli) ? await version(cli) : 'MISSING'})`);
  add('relay', cfg.relayUrl() ?? 'MISSING (no setting, no ~/.buzz/AGENTS.md)');
  add('key', (await d.secrets.key()) ? 'saved' : 'MISSING');
  add('live', `${d.live.state.state}${d.live.state.detail ? ` (${d.live.state.detail})` : ''}; setting buzz.live=${cfg.liveEnabled()}`);
  try {
    const me = await d.client.me();
    const chs = await d.client.allChannels();
    add('identity', `${me.name} (${me.pubkey.slice(0, 8)}…)`);
    add('channels', `${chs.filter((c) => !c.isDm).length} channels, ${chs.filter((c) => c.isDm).length} direct messages`);
  } catch (e) {
    add('identity', `ERROR ${friendlyError(e)}`);
  }
  const repos = agentRepoDirs();
  add('agent repos', repos.length ? '' : `none (~/.buzz/REPOS empty or missing; setting buzz.agentRepos=${JSON.stringify(cfg.agentReposSetting())})`);
  for (const dir of repos) add(`  ${dir}`, `on "${(await checkedOut(dir)) || 'detached'}", reading branch "${cfg.agentBranch()}"`);
  const jira = cfg.jiraUrl();
  add(
    'jira',
    jira
      ? `${jira} (${isJiraCloud(jira) ? 'Cloud: e-mail ' + (cfg.jiraEmail() ? 'set' : 'MISSING') : 'Server/DC'}), projects ${JSON.stringify(cfg.jiraProjects())}, token ${(await d.secrets.jira()) ? 'saved' : 'missing'}`
      : 'off',
  );
  add('desktop', findDesktop() ?? `not found (setting buzz.desktopPath=${JSON.stringify(cfg.desktopPath())})`);
  add('lens', `enabled=${cfg.lensEnabled()}, inline=${cfg.lensInline()}`);
  add('home', os.homedir());
  log.info(`[diag] --- Buzz diagnostics ---\n${lines.join('\n')}\n[diag] --- end ---`);
  log.show();
}
