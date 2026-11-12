// Jira issue details (read-only) for the card shown when hovering an issue key such as ABC-1234.
// Jira Server / Data Center takes a personal access token (Bearer); Jira Cloud (*.atlassian.net) takes the
// account's e-mail with an API token (Basic). The token only goes into the request header; it is never written anywhere.
import * as http from 'http';
import * as https from 'https';
import { t } from './i18n';

export interface JiraIssue {
  key: string;
  url: string;
  summary: string;
  status: string;
  statusCategory: string; // new | indeterminate | done
  type: string;
  assignee?: string;
  estimate?: number; // seconds (Original Estimate)
  spent?: number; // seconds (Time Spent)
}

export class JiraError extends Error {
  constructor(
    message: string,
    public readonly needsToken = false,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Atlassian-hosted Jira: API tokens there only work with the account's e-mail (Basic), not as Bearer. */
export function isJiraCloud(baseUrl: string): boolean {
  try {
    return /\.atlassian\.net$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** The Authorization header: Basic with the e-mail when one is set (Cloud), otherwise Bearer (a personal access token). */
export function jiraAuthHeader(token: string, email: string | undefined): string {
  return email ? `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}` : `Bearer ${token}`;
}

function getJson(url: string, authorization: string, timeoutMs = 15000): Promise<{ status: number; body: Raw }> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { headers: { Authorization: authorization, Accept: 'application/json' }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (data += d));
      res.on('end', () => {
        let body: Raw = {};
        try {
          body = data ? JSON.parse(data) : {};
        } catch {
          /* not JSON (e.g. a login page) */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on('error', reject);
      res.on('close', () => {
        if (!res.complete) reject(new Error('aborted')); // the connection dropped after the headers
      });
    });
    // the socket's inactivity timeout plus a hard deadline for the whole exchange
    const deadline = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs * 2);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

export class JiraService {
  private readonly cache = new Map<string, { at: number; v?: JiraIssue; e?: JiraError }>();

  constructor(
    private readonly token: () => Thenable<string | undefined> | Promise<string | undefined>,
    private readonly baseUrl: () => string,
    private readonly email: () => string = () => '',
  ) {}

  clear(): void {
    this.cache.clear();
  }

  async issue(key: string): Promise<JiraIssue> {
    const hit = this.cache.get(key);
    // a status changes during the day (ETL -> Done): an issue is read again after a minute
    if (hit && Date.now() - hit.at < (hit.v ? 60_000 : 30_000)) {
      if (hit.v) return hit.v;
      if (hit.e) throw hit.e;
    }
    const base = this.baseUrl();
    if (!base) throw new JiraError(t('jira.noUrl'), true);
    const tok = await this.token();
    if (!tok) throw new JiraError(t('jira.noToken'), true);
    try {
      const fields = 'summary,status,issuetype,assignee,timeoriginalestimate,timespent';
      const auth = jiraAuthHeader(tok, this.email().trim() || undefined);
      const { status, body } = await getJson(`${base}/rest/api/2/issue/${encodeURIComponent(key)}?fields=${fields}`, auth);
      if (status === 401 || status === 403) throw new JiraError(t(isJiraCloud(base) && !this.email().trim() ? 'jira.cloudNeedsEmail' : 'jira.badToken'), true);
      if (status === 404) throw new JiraError(t('jira.notFound'));
      if (status < 200 || status >= 300 || !body.fields) throw new JiraError(t('jira.http', status));
      const f = body.fields;
      const v: JiraIssue = {
        key: String(body.key ?? key),
        url: `${base}/browse/${body.key ?? key}`,
        summary: String(f.summary ?? ''),
        status: String(f.status?.name ?? ''),
        statusCategory: String(f.status?.statusCategory?.key ?? ''),
        type: String(f.issuetype?.name ?? ''),
        assignee: f.assignee?.displayName ? String(f.assignee.displayName) : undefined,
        estimate: typeof f.timeoriginalestimate === 'number' ? f.timeoriginalestimate : undefined,
        spent: typeof f.timespent === 'number' ? f.timespent : undefined,
      };
      this.remember(key, { at: Date.now(), v });
      return v;
    } catch (e) {
      const je = e instanceof JiraError ? e : new JiraError(t('jira.unreachable', (e as Error).message));
      if (!je.needsToken) this.remember(key, { at: Date.now(), e: je });
      throw je;
    }
  }

  /** The cache holds the issues seen lately, not every key of the session. */
  private remember(key: string, entry: { at: number; v?: JiraIssue; e?: JiraError }): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value as string);
  }
}
