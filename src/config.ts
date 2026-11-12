// Settings (`buzz.*` in package.json) and the auto-discovery of the Buzz CLI and the relay address.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { cliCandidates, JIRA_PROJECT_KEY, normalizeRelay, relayFromAgentsMd } from './core';
import { Lang, resolveLang } from './i18n';

const buzzHome = (): string => path.join(os.homedir(), '.buzz');
const cfg = () => vscode.workspace.getConfiguration('buzz');

/** Buzz app bundles on a Mac (the name may be "Buzz.app", "Buzz Desktop.app", ...). */
export function macApps(): string[] {
  if (process.platform !== 'darwin') return [];
  const out: string[] = [];
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    try {
      for (const n of fs.readdirSync(dir)) if (/^buzz.*\.app$/i.test(n)) out.push(path.join(dir, n));
    } catch {
      /* no such folder */
    }
  }
  return out;
}

/** The Buzz CLI: the setting, else the first place Buzz Desktop installed it, else the usual location. */
export function cliPath(): string {
  const s = cfg().get<string>('cliPath', '').trim();
  if (s) return s;
  const all = cliCandidates(process.env, process.platform, os.homedir(), macApps());
  return all.find((p) => fs.existsSync(p)) ?? all[0];
}

/** The relay: the setting, else the `Relay:` line of ~/.buzz/AGENTS.md that Buzz Desktop writes. */
export function relayUrl(): string | undefined {
  const s = cfg().get<string>('relayUrl', '').trim();
  if (s) return normalizeRelay(s);
  try {
    return relayFromAgentsMd(fs.readFileSync(path.join(buzzHome(), 'AGENTS.md'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Buzz Desktop itself (the app), to start it when the agents are offline; empty: found automatically. */
export const desktopPath = (): string => cfg().get<string>('desktopPath', '').trim();

export const jiraUrl = (): string => (cfg().get<string>('jira.url', '') || '').trim().replace(/\/+$/, '');
/** Jira Cloud only: the account's e-mail, sent with the API token. */
export const jiraEmail = (): string => (cfg().get<string>('jira.email', '') || '').trim();
export const jiraProjects = (): string[] =>
  (cfg().get<string[]>('jira.projects', []) ?? []).map((p) => String(p).trim().toUpperCase()).filter((p) => JIRA_PROJECT_KEY.test(p));
export const refreshSeconds = (): number => Math.max(2, cfg().get<number>('refreshSeconds', 4));
export const mentionSeconds = (): number => Math.max(0, cfg().get<number>('mentionSeconds', 60));
/** Opt-in: proposals also get "Apply", which writes them into your own workspace. */
export const applyLocally = (): boolean => cfg().get<boolean>('proposals.applyLocally', false);
export const liveEnabled = (): boolean => cfg().get<boolean>('live', true);
export const lensEnabled = (): boolean => cfg().get<boolean>('lens.enabled', true);
export const lensInline = (): boolean => cfg().get<boolean>('lens.inline', false);
/** The agents' branch that file links, Show diff and Lens read. */
export const agentBranch = (): string => cfg().get<string>('agentBranch', 'buzz').trim() || 'buzz';
/** The agents' repositories; empty means every git checkout under ~/.buzz/REPOS. */
export const agentReposSetting = (): string[] => (cfg().get<string[]>('agentRepos', []) ?? []).map((p) => String(p).trim()).filter(Boolean);

export const uiLanguage = (): Lang => resolveLang(cfg().get<string>('language', 'auto'), vscode.env.language);
export const setUiLanguage = (l: Lang): Thenable<void> => updateGlobal('language', l);

/** Writes a setting into the user settings (never into a workspace, see `machine` scopes in package.json). */
export const updateGlobal = (key: string, value: unknown): Thenable<void> => cfg().update(key, value, vscode.ConfigurationTarget.Global);
