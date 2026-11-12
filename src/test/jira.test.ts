import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { isJiraCloud, JiraError, jiraAuthHeader, JiraService } from '../jira';

/** A local Jira that answers with `handler` and records what it was asked. */
async function jiraServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: { url: string; auth?: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, seen, close: () => new Promise((r) => server.close(r)) };
}
const TOKEN = 'tok-secret-123';
const issueBody = {
  key: 'ABC-1',
  fields: {
    summary: 'Fix the ranking tie',
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Task' },
    assignee: { displayName: 'Ada' },
    timeoriginalestimate: 7200,
    timespent: 3600,
  },
};

test('Jira Cloud is recognised by its host; anything self-hosted is Server/Data Center', () => {
  assert.equal(isJiraCloud('https://acme.atlassian.net'), true);
  assert.equal(isJiraCloud('https://ACME.Atlassian.NET/'), true);
  assert.equal(isJiraCloud('https://jira.example.com'), false);
  assert.equal(isJiraCloud('https://atlassian.net.example.com'), false);
  assert.equal(isJiraCloud('not a url'), false);
});

test('the token travels as Bearer for a personal access token and as Basic e-mail:token for Cloud', () => {
  assert.equal(jiraAuthHeader('pat-123', undefined), 'Bearer pat-123');
  assert.equal(jiraAuthHeader('pat-123', ''), 'Bearer pat-123');
  assert.equal(jiraAuthHeader('api-token', 'ada@example.com'), `Basic ${Buffer.from('ada@example.com:api-token').toString('base64')}`);
});

test('an issue is read with the token in the Authorization header only, and kept for a minute', async () => {
  const srv = await jiraServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(issueBody));
  });
  try {
    const jira = new JiraService(
      async () => TOKEN,
      () => srv.url,
    );
    assert.deepEqual(await jira.issue('ABC-1'), {
      key: 'ABC-1',
      url: `${srv.url}/browse/ABC-1`,
      summary: 'Fix the ranking tie',
      status: 'In Progress',
      statusCategory: 'indeterminate',
      type: 'Task',
      assignee: 'Ada',
      estimate: 7200,
      spent: 3600,
    });
    assert.equal(srv.seen[0].auth, `Bearer ${TOKEN}`);
    assert.ok(srv.seen[0].url.startsWith('/rest/api/2/issue/ABC-1?fields=') && !srv.seen[0].url.includes(TOKEN), srv.seen[0].url);
    await jira.issue('ABC-1');
    assert.equal(srv.seen.length, 1, 'answered from memory within a minute');
    const cloud = new JiraService(
      async () => TOKEN,
      () => srv.url,
      () => 'me@example.com',
    );
    await cloud.issue('ABC-2');
    assert.equal(srv.seen[1].auth, 'Basic ' + Buffer.from(`me@example.com:${TOKEN}`).toString('base64'));
  } finally {
    await srv.close();
  }
});

test('a rejected token asks for a new one, a missing issue or a login page is an error, and no error carries the token', async () => {
  let reply = { status: 401, body: '{}', type: 'application/json' };
  const srv = await jiraServer((_req, res) => {
    res.statusCode = reply.status;
    res.setHeader('content-type', reply.type);
    res.end(reply.body);
  });
  const fail = async (jira: JiraService, key: string): Promise<JiraError> => {
    try {
      await jira.issue(key);
    } catch (e) {
      assert.ok(e instanceof JiraError, String(e));
      assert.ok(!e.message.includes(TOKEN), e.message);
      return e;
    }
    throw new Error('expected a failure');
  };
  try {
    const jira = new JiraService(
      async () => TOKEN,
      () => srv.url,
    );
    assert.equal((await fail(jira, 'ABC-1')).needsToken, true, '401: the token is asked for again');
    await fail(jira, 'ABC-1');
    assert.equal(srv.seen.length, 2, 'a token problem is not remembered: a new token works at once');
    reply = { status: 404, body: '{}', type: 'application/json' };
    assert.equal((await fail(jira, 'ABC-9')).needsToken, false);
    await fail(jira, 'ABC-9');
    assert.equal(srv.seen.length, 3, 'a missing issue is remembered for a while');
    reply = { status: 200, body: '<html>Log in</html>', type: 'text/html' };
    assert.equal((await fail(jira, 'ABC-3')).needsToken, false, 'a login page instead of JSON is an error, not an empty card');
  } finally {
    await srv.close();
  }
});

test('without a Jira address or a token nothing is asked over the network', async () => {
  const srv = await jiraServer((_req, res) => res.end('{}'));
  try {
    for (const jira of [
      new JiraService(
        async () => TOKEN,
        () => '',
      ),
      new JiraService(
        async () => undefined,
        () => srv.url,
      ),
    ]) {
      await assert.rejects(jira.issue('ABC-1'), (e: unknown) => e instanceof JiraError && e.needsToken);
    }
    assert.equal(srv.seen.length, 0);
  } finally {
    await srv.close();
  }
});
