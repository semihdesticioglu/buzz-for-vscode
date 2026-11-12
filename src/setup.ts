// First-run setup and secrets: the Buzz CLI, the relay address, the Nostr key and the Jira connection.
// The key and the Jira token live in VS Code's encrypted SecretStorage and never reach a file, a setting or a log.
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { BuzzClient } from './api';
import type { CliOptions } from './buzzCli';
import * as cfg from './config';
import { cliName, friendlyError, isValidKey, normalizeRelay, sanitizeKey, SetupError } from './core';
import { t } from './i18n';
import { isJiraCloud } from './jira';

const KEY = 'buzz.nostrKey';
const JIRA = 'buzz.jiraToken';

export class Secrets {
  constructor(private readonly s: vscode.SecretStorage) {}
  key = (): Thenable<string | undefined> => this.s.get(KEY);
  setKey = (v: string): Thenable<void> => this.s.store(KEY, sanitizeKey(v));
  jira = (): Thenable<string | undefined> => this.s.get(JIRA);
  setJira = (v: string): Thenable<void> => this.s.store(JIRA, v.trim());
  async forget(): Promise<void> {
    await this.s.delete(KEY);
    await this.s.delete(JIRA);
  }
}

/** What the CLI wrapper needs; a SetupError names the missing piece (the chat shows a Setup button for it). */
export async function cliOptions(secrets: Secrets): Promise<CliOptions> {
  const p = cfg.cliPath();
  if (!fs.existsSync(p)) throw new SetupError(t('setup.noCli', p));
  const relay = cfg.relayUrl();
  if (!relay) throw new SetupError(t('setup.noRelay'));
  const key = await secrets.key();
  if (!key) throw new SetupError(t('setup.noKey'));
  return { cliPath: p, relayUrl: relay, key };
}

export async function promptKey(secrets: Secrets): Promise<boolean> {
  const v = await vscode.window.showInputBox({
    title: t('key.title'),
    prompt: t('key.prompt'),
    placeHolder: 'nsec1…',
    password: true,
    ignoreFocusOut: true,
    validateInput: (s) => (isValidKey(s) ? undefined : t('key.invalid')),
  });
  if (!v) return false;
  await secrets.setKey(v);
  return true;
}

/**
 * Connect Jira: its address, the project keys whose issue keys (ABC-123) become links, and a read-only token.
 * Each step shows what is saved already; Escape at any step leaves the rest as it was.
 */
export async function connectJira(secrets: Secrets): Promise<boolean> {
  const wasCloud = isJiraCloud(cfg.jiraUrl());
  const url = await vscode.window.showInputBox({
    title: t('jiraConnect.urlTitle'),
    prompt: t('jiraConnect.urlPrompt'),
    placeHolder: 'https://jira.example.com',
    value: cfg.jiraUrl(),
    ignoreFocusOut: true,
    validateInput: (v) => (/^https?:\/\/[^\s/]+/i.test(v.trim()) ? undefined : t('jiraConnect.urlInvalid')),
  });
  if (url === undefined) return false;
  // Jira Cloud takes the account's e-mail with an API token; Server / Data Center a personal access token
  const cloud = isJiraCloud(url.trim());
  let email = '';
  if (cloud) {
    const v = await vscode.window.showInputBox({
      title: t('jiraConnect.emailTitle'),
      prompt: t('jiraConnect.emailPrompt'),
      placeHolder: 'name@example.com',
      value: cfg.jiraEmail(),
      ignoreFocusOut: true,
      validateInput: (x) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.trim()) ? undefined : t('jiraConnect.emailInvalid')),
    });
    if (v === undefined) return false;
    email = v.trim();
  }
  const keys = await vscode.window.showInputBox({
    title: t('jiraConnect.projectsTitle'),
    prompt: t('jiraConnect.projectsPrompt'),
    placeHolder: 'ABC, XYZ',
    value: cfg.jiraProjects().join(', '),
    ignoreFocusOut: true,
    validateInput: (v) => {
      const list = v.split(/[\s,;]+/).filter(Boolean);
      if (!list.length) return t('jiraConnect.projectsEmpty');
      const bad = list.find((k) => !/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(k));
      return bad ? t('jiraConnect.projectsInvalid', bad) : undefined;
    },
  });
  if (keys === undefined) return false;
  await cfg.updateGlobal('jira.url', url.trim().replace(/\/+$/, ''));
  await cfg.updateGlobal('jira.email', email);
  await cfg.updateGlobal(
    'jira.projects',
    keys
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((k) => k.toUpperCase()),
  );
  // a saved token can stay only when it is of the same kind (Cloud API token vs personal access token)
  if ((await secrets.jira()) && wasCloud === cloud) {
    const keep = t('jiraConnect.keepToken');
    const change = t('jiraConnect.newToken');
    const choice = await vscode.window.showQuickPick([keep, change], { title: t('jiraKey.title') });
    if (choice !== change) return true;
  }
  await promptJiraToken(secrets, cloud);
  return true;
}

async function promptJiraToken(secrets: Secrets, cloud: boolean): Promise<boolean> {
  const v = await vscode.window.showInputBox({
    title: t('jiraKey.title'),
    prompt: t(cloud ? 'jiraKey.promptCloud' : 'jiraKey.prompt'),
    password: true,
    ignoreFocusOut: true,
    validateInput: (s) => (s.trim().length >= 10 ? undefined : t('jiraKey.invalid')),
  });
  if (!v) return false;
  await secrets.setJira(v);
  return true;
}

/** First-time setup: CLI path -> relay address -> Nostr key -> connection test; `after` runs when it all works. */
export async function runSetup(secrets: Secrets, client: BuzzClient, after: () => Promise<void>): Promise<void> {
  if (!fs.existsSync(cfg.cliPath())) {
    // Buzz Desktop is missing or installed somewhere unusual: say so before any file dialog
    const exe = cliName(process.platform);
    const choose = t('setup.cliChoose', exe);
    const detail = t('setup.cliMissingDetail', exe) + (process.platform === 'darwin' ? '\n\n' + t('setup.cliMacHint') : '');
    const act = await vscode.window.showWarningMessage(t('setup.cliMissing'), { modal: true, detail }, choose);
    if (act !== choose) return;
    const pick = await vscode.window.showOpenDialog({
      title: t('setup.cliPick', exe),
      openLabel: t('setup.cliOpenLabel'),
      canSelectMany: false,
      canSelectFolders: false,
      filters: process.platform === 'win32' ? { 'buzz.exe': ['exe'] } : undefined,
    });
    if (!pick?.[0]) return;
    await cfg.updateGlobal('cliPath', pick[0].fsPath);
  }

  const auto = cfg.relayUrl();
  const relay = await vscode.window.showInputBox({
    title: t('setup.relayTitle'),
    value: auto ?? '',
    prompt: auto ? t('setup.relayFound') : t('setup.relayEnter'),
    ignoreFocusOut: true,
    validateInput: (v) => (/^(https?|wss?):\/\/\S+$/i.test(v.trim()) ? undefined : t('setup.relayInvalid')),
  });
  if (!relay) return;
  if (normalizeRelay(relay) !== auto) await cfg.updateGlobal('relayUrl', normalizeRelay(relay));

  if (await secrets.key()) {
    const useSaved = t('setup.keyUseSaved');
    const enterNew = t('setup.keyNew');
    const choice = await vscode.window.showQuickPick([useSaved, enterNew], { title: t('key.title') });
    if (!choice) return;
    if (choice === enterNew && !(await promptKey(secrets))) return;
  } else if (!(await promptKey(secrets))) {
    return;
  }
  await verifyConnection(client, after);
}

/** Reads the identity with the saved key and says how it went; `after` runs when it works. */
export async function verifyConnection(client: BuzzClient, after: () => Promise<void>): Promise<void> {
  client.reset();
  try {
    const me = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('setup.connecting') }, () => client.me());
    await vscode.commands.executeCommand('setContext', 'buzz.ready', true);
    void vscode.window.showInformationMessage(t('setup.connected', me.name));
    await after();
  } catch (e) {
    void vscode.window.showErrorMessage(`Buzz: ${friendlyError(e)}`);
  }
}
