# Contributing

Thanks for taking a look. Issues and pull requests are welcome. Please read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for how the extension is built and [docs/TESTING.md](docs/TESTING.md) for how it is tested.

## Setup

You need Node.js 22 or newer and git. Chrome or Edge is needed only for the webview harnesses.

```
npm ci
npm run compile      # type check: TypeScript -> out/ (what the tests run)
npm test             # unit tests (node:test, no VS Code needed)
npm run lint         # ESLint
npm run format       # Prettier (format:check only checks)
npm run build        # esbuild bundle -> dist/extension.js (what the package ships)
npm run check        # lint, formatting, type check, unit tests and build, as CI runs them
npm run harness      # scenario, stress and performance harnesses (test/harness/), as CI runs them
npm run package      # builds the .vsix
```

## Running and debugging

- Press **F5** (the **Run Extension** configuration). It builds a readable bundle with source maps
  (`npm run build:dev`) and opens an Extension Development Host. Breakpoints in `src/*.ts` work there.
- `npm run watch` rebuilds the bundle on every change; reload the development window to pick it up.
- **Output → Buzz** is the extension's log: the CLI commands, the live connection's states, search and paging
  decisions. **Buzz: Diagnostics** writes what the extension sees on the machine (CLI, relay, identity, channels,
  agents' repositories, Jira) into it; **Buzz: Show connection log** opens it.
- The chat is a webview: **Developer: Open Webview Developer Tools** inspects `media/chat.js` and the CSS.
- To work on the chat without Buzz, use the harnesses: they drive the real controller and the real webview with a
  fake Buzz (see [TESTING.md](docs/TESTING.md)).

Using the extension for real needs Buzz Desktop installed and a Buzz identity; see the README.

## How the code is organised

| Where                                                                     | What                                                                         |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/extension.ts`                                                        | activation: wires the pieces together, registers commands                    |
| `src/setup.ts`, `src/config.ts`                                           | first-run wizards and SecretStorage; settings and auto-discovery             |
| `src/chat.ts`                                                             | chat controller: channels, threads, loading, sending, live events            |
| `src/chatRender.ts`, `src/presence.ts`                                    | what messages look like on screen (cached); who is online, typing or working |
| `src/protocol.ts`                                                         | the typed messages between the controller and the webview                    |
| `src/chatView.ts`, `src/chatHtml.ts`                                      | the side bar and editor-tab hosts, and the webview document (with its CSP)   |
| `media/chat.js`, `media/chat.css`                                         | the webview: script and styles                                               |
| `src/api.ts`, `src/buzzCli.ts`                                            | the Buzz CLI wrapper                                                         |
| `src/live.ts`, `src/liveRelay.ts`, `src/nostr.ts`                         | the live relay connection (WebSocket, NIP-42, signing)                       |
| `src/patch.ts`, `src/proposals.ts`, `src/refs.ts`                         | agent proposals as diffs, file references                                    |
| `src/lens.ts`, `src/lensCore.ts`                                          | Buzz Lens                                                                    |
| `src/agentRepo.ts`, `src/agentGit.ts`, `src/gitChanges.ts`                | read-only access to the agents' repositories; branch and commit ranges       |
| `src/mentions.ts`, `src/jira.ts`, `src/channelAdmin.ts`, `src/desktop.ts` | mention notifications, Jira cards, channel management, starting Buzz Desktop |
| `src/markdown.ts`                                                         | message rendering (markdown-it, highlight.js)                                |
| `src/core.ts`                                                             | pure helpers; most unit tests target these                                   |
| `src/i18n.ts`                                                             | every user-facing string, in English and Turkish                             |

Pure logic (no `vscode` import) lives in `core.ts`, `patch.ts`, `lensCore.ts`, `markdown.ts`, `nostr.ts`,
`agentGit.ts`, `presence.ts` and `jira.ts`, and is unit tested from `src/test/`. Code that needs the VS Code API stays
thin and delegates to those modules. Objects that others depend on (the Buzz client, the live connection, the
agents' repositories) are created once in `extension.ts` and passed in; there are no module-level singletons apart
from the log and the language.

## Rules of thumb

- Every user-facing string goes through `t('key')` (extension) or `T('key')` (webview) and exists in both languages
  in `src/i18n.ts`; the tests check this. Setting and command titles live in `package.nls.json` and
  `package.nls.tr.json`.
- Nothing from Buzz is written into the user's files without an explicit action; the agents' repositories are
  read-only.
- Secrets (the Nostr key, the Jira token) live only in VS Code's SecretStorage and never reach a log or a file.
- Processes start with argument arrays, never through a shell; user text that could look like an option goes in as
  one `--name=value` argument.
- A bug fix comes with the test that would have caught it. A test fakes Buzz the way Buzz really answers (for
  example, the CLI lists only people who are online: an offline person is missing, not "offline").
- Run `npm run check` and `npm run harness` before opening a pull request; CI runs the same on Ubuntu and Windows.

## Pull requests

- Keep a pull request to one change, and describe what the user sees before and after.
- Add an entry to `CHANGELOG.md` under the next version.
- Screenshots help for changes to the webview; `test/harness/readme_shot.js` renders the chat with sample data.

## Releases

1. Update `version` in `package.json` and the `CHANGELOG.md` entry.
2. `npm run check` and `npm run harness` pass. If Buzz released a new CLI since the last recording, record it again
   (`node test/cli-contract/capture.js`, see [TESTING.md](docs/TESTING.md)) and read the file before committing it.
3. `npm run package` builds `buzz-for-vscode-<version>.vsix`; CI uploads the same file as an artifact.
4. Tag the commit `v<version>` and attach the `.vsix` to a GitHub release. Publishing to the Marketplace is done by
   the maintainer with `npx vsce publish`.
