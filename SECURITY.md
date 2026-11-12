# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's **Report a vulnerability** button on this repository
(Security → Advisories), or by e-mail to the maintainer listed on the GitHub profile, not as a public issue. You will
get an answer within a few days. Please include the version (`Buzz: Diagnostics` prints it), what you did, and what
you saw.

Only the latest release is supported with fixes.

## Scope of this document

This is the maintainer's own review of how the extension handles secrets, processes, content and files, with the
tests that check each point. It is **not a formal security audit**, and the extension has not been audited by a third
party. The architecture is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What the extension handles

| Asset                                      | Stored                                                          | Used                                                                                                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Your Nostr private key                     | VS Code SecretStorage (the operating system's credential store) | In the extension host's memory to sign the relay authentication (NIP-42) and typing signals; passed to each Buzz CLI process as `BUZZ_PRIVATE_KEY` in its environment, never on its command line |
| Your Jira token                            | SecretStorage                                                   | Only in the `Authorization` header of read-only requests to the Jira address you configured                                                                                                      |
| Chat content                               | Not stored on disk; read when a channel opens                   | Rendered in the webview                                                                                                                                                                          |
| Unsent drafts                              | VS Code's workspace state (local, not encrypted)                | Restored in the composer                                                                                                                                                                         |
| Your workspace files                       | Not touched unless you act                                      | Read for Lens and sending code; written only when you apply a proposal                                                                                                                           |
| The agents' repositories (`~/.buzz/REPOS`) | Not touched                                                     | Read-only through git                                                                                                                                                                            |

## Controls, and the tests that check them

- **Secrets stay out of files and logs.** Error texts from the CLI are checked not to contain the key
  (`src/test/cli.test.ts`); `Buzz: Diagnostics` prints only whether a key is saved; the Jira token is never part of
  a URL or an error text (`src/test/jira.test.ts`).
- **A repository cannot redirect the extension.** `buzz.cliPath`, `buzz.desktopPath` and `buzz.agentRepos` are
  `machine` scoped and `buzz.relayUrl` and `buzz.jira.url` `application` scoped, so a workspace's
  `.vscode/settings.json` cannot point the extension at another program, relay or Jira.
- **No shell.** Processes (the CLI, git, Buzz Desktop) start with `spawn`/`execFile` and argument arrays. Text a user
  types that could look like an option (a channel name, a search) is passed as a single `--name=value` argument
  (`src/test/cli.test.ts`). A CLI that hangs is stopped after 30 seconds.
- **Untrusted message content is rendered safely.** Messages are turned into HTML by markdown-it with `html: false`;
  `javascript:`, `vbscript:` and `data:` links are refused; images load only from the relay's host. The webview has a
  Content Security Policy with `default-src 'none'` and nonce-locked scripts, and is tested in Chrome with the
  production policy (`test/harness/csp_check.js`) and with over 50 hostile inputs, from script injection to 200-level
  nesting and 64 KB messages (`test/harness/stress_hostile.js`).
- **Actions from the webview carry ids, not content.** Applying a proposal, opening a file reference or showing a diff
  names a message; the extension looks the content up itself, accepts only paths inside the workspace
  (`isSafeRel`: no `..`, drive letters, UNC paths or URIs) and opens only `http(s)` links.
- **Proposals change files only on request.** Applying is off by default (`buzz.proposals.applyLocally`), refuses
  paths outside the workspace and inside `.git`, asks when the file changed after the message, does not overwrite a
  file that changed while the question was open, applies a diff over several files all or nothing, and leaves an
  unsaved, undoable edit (`test/harness/proposal_apply_check.js`).
- **The agents' repositories are read-only.** Every git command runs with `--no-optional-locks`, paths are
  `:(literal)` pathspecs, refs are validated before they reach git, and the `buzz-agent:` file system refuses
  writes, new folders, deletes and renames. The tests check that the agents' folder and its `.git/index` are
  unchanged after reading (`src/test/agentGit.test.ts`, `test/harness/agent_repo_check.js`).
- **TLS is verified.** Over `wss://` the live connection refuses a certificate the machine does not trust and says so
  (`src/test/live.test.ts`); VS Code and the Buzz CLI both use the operating system's trusted certificates.

## Known risks

Ordered by severity, as the maintainer assesses them.

1. **The BIP-340 signing code is the project's own and not constant-time** (medium). `src/nostr.ts` signs with plain
   BigInt arithmetic, because the `crypto` module of VS Code's Electron runtime has no secp256k1. It passes all 19
   official BIP-340 test vectors (`src/test/nostr.test.ts`), and a one-off comparison outside the test suite (last
   run 2026-11-12) gave byte-identical signatures to `@noble/curves` 1.9.7 for 300 random keys and messages. Its
   running time, however, grows with the secret scalar's bit length: one scalar multiplication took 2.5 ms for a
   65-bit scalar and 10.2 ms for a 256-bit one on the test machine. A malicious relay that forces many
   re-authentications could, in principle, time the signatures. Recommended mitigation: sign with `@noble/curves`,
   which is pure JavaScript and also runs in Electron.
2. **Relays without TLS** (medium, depends on the deployment). Over `ws://`/`http://` the chat content and the CLI's
   signed request headers cross the network unencrypted, and the extension does not verify the signatures of the
   events it receives, so an attacker on the network path could read messages or inject events. The private key
   never crosses the network. Mitigation: run the relay over `wss://` (Buzz's own deployment guide requires it; the
   extension supports it and follows the address Buzz Desktop writes); checking the signatures of incoming events is
   the recommended next step.
3. **The key lives in the extension host while VS Code runs** (medium, inherent). All VS Code extensions share one
   process; a malicious extension could read another extension's memory or the environment of the processes it
   starts. This is VS Code's trust model. The lasting fix is Buzz's planned local credential provider, which keeps
   the key in Buzz Desktop and lets local tools ask it to sign.
4. **Webview messages are not validated at runtime** (low). Their types are checked at compile time
   (`src/protocol.ts`), and the strict CSP and sanitised HTML make script injection into the webview hard, but the
   extension trusts the shape of what the webview posts.
5. **CLI output is shown in error messages as it is** (low). If a CLI version ever printed a secret in an error, it
   would reach the status line. Masking known secrets in CLI output is a cheap defence in depth.

## Dependencies

The extension ships one bundle (`dist/extension.js`) with three runtime dependencies: `markdown-it`, `highlight.js`
and `ws`. `npm audit --omit=dev` reports no known vulnerabilities in them (checked 2026-11-12). The development
tools have 20 advisories of their own (9 high, 11 moderate, same date): in `puppeteer-core`'s dependencies
(`extract-zip` and `basic-ftp`, used to download browsers, which the harnesses do not do, and `zod`, used for the
WebDriver BiDi protocol, which they do not use) and in `minimatch` (through ESLint, typescript-eslint and vsce). Newer
versions fix all of them, and none of these packages is part of the extension package. Dependabot proposes updates weekly
([.github/dependabot.yml](.github/dependabot.yml)) and CI runs `npm audit --omit=dev`.
