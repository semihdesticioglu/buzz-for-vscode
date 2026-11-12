# Testing

How Buzz for VS Code is tested, how to run the tests, what they cover, and what they do not. The architecture they
test is described in [ARCHITECTURE.md](ARCHITECTURE.md).

## In short

| Layer              | Where                      | What runs                                                                                                                                                                   | Size                  |
| ------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Unit tests         | `src/test/*.test.ts`       | Pure modules with `node:test`, no VS Code. Real git, a local relay over `ws://` and `wss://`, a fake CLI process, a local HTTP server, and recorded answers of the real CLI | 151 tests in 13 files |
| Scenario harnesses | `test/harness/*_check.js`  | The compiled extension code (`out/`) with a fake `vscode` module and a fake Buzz; 6 of them also load the real webview in headless Chrome                                   | 22 harnesses          |
| Stress sets        | `test/harness/stress_*.js` | A first run where things are missing, hostile message content, a bad network, an impatient user, 5,000 messages                                                             | 5 harnesses           |
| Performance        | `test/harness/perf_*.js`   | Timings and memory of the controller and the webview, printed for comparison (no pass or fail)                                                                              | 2 harnesses           |

`npm run harness` runs all 29 harnesses; together they make 573 checks. Of the unit tests, 11 are skipped unless
there is a real Buzz CLI to start (one, opt-in) or a recording of one (ten; see _The real Buzz CLI, recorded_).
Every number on this page was measured on 2026-11-12 on Windows 11 with Node 24.5; CI runs the same commands on
Ubuntu and Windows with Node 22.

## Running the tests

```
npm ci
npm run compile                 # the tests run the compiled JavaScript in out/
npm test                        # unit tests (about a minute)
npm run harness                 # all harnesses (about five minutes); Chrome or Edge for the webview ones
node test/harness/run.js stress # only the harnesses whose file name contains "stress"
node test/harness/proposal_apply_check.js   # one harness on its own
npm run coverage                # unit tests with Node's coverage report
npm run check                   # lint, formatting, type check, unit tests and bundle, as CI runs them
node test/cli-contract/capture.js   # record the real Buzz CLI for the contract tests (see below)
```

| Variable             | Effect                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `BUZZ_CHROME`        | The Chrome or Edge executable for the webview harnesses. Without it the usual install locations are tried; nothing is downloaded |
| `BUZZ_TIME_SCALE`    | Multiplies the time budgets of the stress harnesses (`run.js` sets 3 when `CI` is set: shared runners are slower)                |
| `SEED`               | Replays `stress_rapid.js` with the latencies of an earlier run; the seed is printed at the start and with a failure              |
| `BUZZ_CLI_SMOKE=1`   | Runs the one unit test that starts the real Buzz CLI (`%LOCALAPPDATA%\Buzz\buzz.exe`, Windows); it is skipped otherwise          |
| `BUZZ_CLI_RECORDING` | Points the contract tests at another recording than `test/cli-contract/recorded.json` (`cli_capture_check.js` uses it)           |

`run.js` runs every `*_check.js`, `stress_*.js` and `perf_*.js` file and adds up their `PASS` and `FAIL` lines. A
webview harness is skipped when no browser is found, except on CI, where that is an error. A harness that prints a
line starting with `SKIP` and exits 0 counts as skipped.

`test/harness/range_audit.js` and `test/harness/readme_shot.js` are tools, not tests: the first compares Show diff
with git on the agents' real repository (read-only), the second renders `docs/screenshot.png`.

## How the fakes are built

Tests fake the boundaries of the extension, never the code under test, and the fakes answer the way the real
counterparts do.

- **VS Code.** Harnesses load the compiled modules with a fake `vscode` module (a `Module._load` hook) that has only
  the API surface the code under test uses. `proposal_apply_check.js`, for example, keeps the workspace's files and
  open documents in memory and records every edit, question and diff view.
- **Buzz.** The controller harnesses use a fake Buzz client that answers like the CLI, including its gaps: the CLI
  lists only people who are online, so an offline person is missing from the answer, not marked "offline". The unit
  tests of the CLI wrapper start `src/test/fakeCli.ts` as a real child process in place of `buzz`; it echoes the
  arguments, standard input and relay address it got, fails like the CLI (exit code 3 and an `auth_error` without a
  key), and can hang.
- **The relay.** `live.test.ts` runs a local WebSocket relay that speaks NIP-01 and NIP-42 like Buzz's: it sends a
  challenge, checks the signature, kind, challenge and relay tags of the `AUTH` event, answers subscriptions with
  `EVENT`, `EOSE` or `CLOSED`, and can drop the connection, stop answering or refuse. `src/test/tlsRelay.ts` is the
  same relay over `wss://` with a certificate made by `openssl` for the test, run once with that certificate trusted
  and once without. `stress_network.js` runs the real live connection against a relay that drops it three times.
- **Git.** `agentGit.test.ts` builds a temporary repository with branches, a merge, a rename and a linked worktree;
  `test/harness/demo_repo.js` builds an agents' repository in a temporary home folder. Nothing of the user's is read.
- **Jira.** `jira.test.ts` answers from a local HTTP server: an issue, a rejected token, a missing issue, a login page.
- **The real CLI, recorded.** The contract tests replay anonymised answers of the real Buzz CLI (see _The real Buzz
  CLI, recorded_), so the fakes' picture of the CLI can be checked against the real thing.
- **The webview.** Browser harnesses load the real page (the document from `src/chatHtml.ts`, `media/chat.css`,
  `media/chat.js`) with `puppeteer-core` and talk to it through the same messages the extension sends.
  `csp_check.js` serves it with the production Content Security Policy, and every violation fails the check.

## What is covered

By area. Each line names the file and what it checks; the files' own test names say more.

### Nostr events and authentication

- `nostr.test.ts`: all 19 official BIP-340 test vectors: signatures byte for byte and public keys for the eight with
  a secret key (messages of 0, 1, 17, 32 and 100 bytes), and the expected verification result for every one,
  including the ten that must fail (a public key off the curve or beyond the field size, `R` with an odd `y`, a
  negated message or `s`, a result at infinity, `r` not on the curve or at the field size, `s` at the curve order); a
  signature with one bit changed fails; the event id follows NIP-01; a signed event fails verification once modified;
  the NIP-42 `AUTH` event (kind 22242, relay and challenge tags).
- `core.test.ts`: `nsec` decoding (NIP-19 vector), public key derivation equal to Node's own secp256k1, a pasted key
  cleaned of spaces, invisible characters and quotes.
- `live.test.ts`: authenticates with the relay's challenge, subscribes and receives; a rejected `AUTH` ends in an
  error state that says why; a relay that asks for no authentication; events are published only once live.

### Reconnection, fallback and recovery

- `live.test.ts`: after a drop it reconnects, authenticates with the new challenge and renews its subscriptions; a
  connection that stops answering pings is closed and reopened (sleep, VPN switch); nothing is sent after
  unsubscribing or stopping; a one-shot read is complete only when the relay sends `EOSE`, and a read that never
  ends, is refused (`CLOSED`) or is cut off is reported incomplete with what did arrive; over `wss://`, an untrusted
  certificate is refused and named.
- `presence.test.ts`: a failed presence read is tried again after five minutes; answers go stale.
- `stress_network.js` (77 checks): CLI reads of 2–5 s during ten channel switches; the first reads failing and the
  list recovering by polling alone; live state churn; the real live connection against a relay that drops three
  times; every live read incomplete, so the CLI answers and nothing is cached as final; malformed CLI rows; 500 live
  events in one tick.
- `stress_first_run.js` (83 checks): no setup, a wrong key, no network, recovery after setup, broken member and
  presence reads, no channels, no agents' repositories, no git, Buzz Desktop's location on each platform: one clear
  message each time, no error storm, no polling loop, no unhandled rejection.
- `search_check.js`, `lens_search_check.js`: search and Lens use the CLI when the live connection is off or fails.

### Pagination, ordering and deduplication

- `core.test.ts`: messages grouped into threads (nested replies, a root older than the page, latest activity first);
  replies under the message they answer; deletions; a fresh page drops messages deleted elsewhere and picks up edits
  without touching what it does not cover; DM conversations with the same people merged and repeated rows counted
  once; rows that are not messages dropped at the boundary and counted, so a short page is not taken for the end; the
  mention cursor.
- `chat_scenarios_check.js`: a stale "Load older" does not leak into another channel; late answers from a channel the
  user left are ignored; a thread root that arrives live before the CLI returns; deletions count only from the author.
- `thread_long_check.js`: a thread longer than the CLI's 500 messages gets its older pages from the relay and shows
  every message once, in order.
- `dm_group_check.js`, `send_route_check.js`, `thread_sync_check.js`: which conversation a message is read from and
  sent to, also when Enter and a channel switch cross.
- `stress_scale.js` (35 checks): 50 channels, 5,000 messages in 400 threads, one thread of 1,500 replies; the reads
  and rows are checked exactly, the times against budgets a few times what a laptop needs.
- `stress_rapid.js` (63 checks): bursts of clicks with random latencies; twenty "Load older" clicks read one page;
  `dispose()` in the middle of a burst leaves no subscription and no timer.

### CLI command handling and failures

- `cli.test.ts`: JSON output read; the message goes through standard input (Turkish letters, several lines, code
  fences); no key gives an authentication error and the key never appears in an error; output that is not JSON is a
  network error; a missing CLI is named; a CLI that hangs is stopped after the time limit; names and searches that
  look like options stay one argument; malformed rows are dropped.
- `core.test.ts`: the CLI's error output is parsed; the CLI and Buzz Desktop are looked for where they install on
  each platform.

### Git branches, commits and Show diff

- `agentGit.test.ts`: only git-safe names reach git; renames in `--name-status`; an open branch measured from where
  it left the agents' branch, a merged branch by its merge, a fast-forwarded one by its last commit, a commit against
  its first parent (the first commit against the empty tree); a branch without commits of its own shows the
  uncommitted work of the folder or linked worktree it is checked out in; `git status --porcelain=v2` parsed; reading
  does not rewrite `.git/index`, even after a file's timestamp changed (which makes a plain `git status` refresh it).
- `git_range_check.js` (10 checks): every range compared with git itself on the demo repository; what Show diff
  opens: one row per changed file, each side reading exactly what git has at the base and the tip (a renamed file
  under its old name, no side for an added or a deleted file), and the fallback without VS Code's changes editor.
- `agent_repo_check.js` (14 checks): the agents' repositories are found, paths resolve to them, the `buzz-agent:`
  file system reads the agents' branch and refuses every change (write, new folder, delete, rename), and the folder
  stays on its branch with no changes.
- `core.test.ts`: the branches and commits an agent reports are found, a base mentioned in passing is not; the
  repository address sent with a diff never carries a user name or token.

### Applying proposed changes safely

- `patch.test.ts` (18 tests): unified diffs with drifted line numbers, several hunks and files, new files; loose
  `- / +` diffs; line-range replacements; an ambiguous or missing change is refused, an applied one is not applied
  twice, CRLF files stay CRLF.
- `proposal_apply_check.js` (21 checks): a proposal goes into the open document unsaved; Save and Undo; Undo leaves
  a file edited since; paths outside the workspace (`..`, drives, network shares, URIs) are refused before any file
  is read; nothing is written inside `.git`; a new file is created exactly where the diff says and an existing file is
  not overwritten by a "new file"; a line-number proposal for a file changed since the message (or with unsaved
  edits) asks first; a file that changes while the question is open is not overwritten; a diff over several files is
  all or nothing; Show diff never writes; the chat applies nothing unless `buzz.proposals.applyLocally` is on.

The eight safety rules behind these checks were each removed in turn from a copy of `out/`, and every removal made
its check fail. The same was done for five rules of Show diff (`gitChanges.ts`) against `git_range_check.js`.

### Buzz Lens matching and search

- `lens.test.ts` (12 tests): a message counts when it names the file or a path that fits it, not the same name in
  another folder; code names, not plain words or mentions; a conversation anchored at the most specific name, else
  at a line number; the file's own name never anchors; Turkish `İ` and `ı` match either way.
- `lens_search_check.js` (10 checks): a live NIP-50 page, time windows when the page is full, the CLI when the live
  connection is off or fails, the timing line in the log.

### Security-sensitive behaviour

- **Untrusted content.** `markdown.test.ts`: raw HTML escaped, `javascript:` links not linked, images only from the
  relay's host, nesting bounded. `stress_hostile.js` (56 checks): attack-shaped messages rendered in Chrome _without_
  the CSP, so any script or handler that survived the renderer would run. `csp_check.js`: the production CSP is
  enforced and not violated.
- **Secrets.** The key never appears in CLI errors (`cli.test.ts`); the Jira token travels only in the
  `Authorization` header and never in an error (`jira.test.ts`); repository addresses lose their credentials
  (`core.test.ts`).
- **Processes and files.** Option-like text stays one argument (`cli.test.ts`); refs are validated before git
  (`agentGit.test.ts`); workspace paths are checked (`proposal_apply_check.js`, `stress_hostile.js`); the agents'
  folder stays untouched (`agent_repo_check.js`, `git_range_check.js`).
- **TLS.** `live.test.ts` connects over `wss://` and refuses a certificate the machine does not trust.
- **Loading.** `bundle_check.js`: the shipped bundle loads without touching the network or the file system.

### Mention notifications

- `mentions_check.js` (21 checks): history is not announced on the first run; a new mention is announced once, with
  who, where and what, and counted on the status bar; the same mention read again, delivered twice by the relay, or
  brought by both polling and the live connection is announced once; a second mention in the same second is not lost;
  my own messages are not announced; several new mentions make one notification; a window in the background counts at
  once, shows the notification when it gets focus, and drops one that another window already showed; Open goes to
  the message; `buzz.mentionSeconds` 0 turns it all off; a failed read is tried again quietly; dispose stops
  everything. Eight rules of `mentions.ts` were each removed in turn from a copy of `out/`, and every removal made its
  check fail.

### The chat webview

`webview_check.js` (scroll position, unread marks, a double Enter sends once), `draft_webview_check.js` and
`draft_store_check.js` (a draft per thread, kept across views and reloads), `search_webview_check.js`,
`offline_webview_check.js` and `offline_channels_check.js` (the agents-offline bar, the live dot),
`jira_card_check.js`, and `i18n.test.ts` (every string in English and Turkish, every key the webview uses exists).

## The real Buzz CLI, recorded

The fakes answer the way the CLI answered when they were written. To notice when Buzz changes its output, the real
CLI's answers are recorded and replayed by contract tests:

1. `node test/cli-contract/capture.js`, run after `npm run compile` on a machine where Buzz works, calls the read-only
   commands the extension uses, through the extension's own client: profiles, channels, direct messages, pages of
   messages, a thread, members, presence, mentions and search. Nothing is sent to Buzz or changed there. The key comes
   from `BUZZ_PRIVATE_KEY` or is asked for without being shown, and goes only to the CLI's environment.
2. The answers are anonymised (`src/test/anonymise.ts`): every id, key, name, text and address becomes a stand-in,
   the same value always the same one, and every time moves by one constant. The structure stays, and so do the
   words the extension reads as values (presence, roles, channel types).
3. Saving is refused when anything original would remain. The check collects the originals from the raw answers on
   its own, so a mistake in the anonymiser is caught as well, and it also looks for the key, the relay's address and
   the computer's user and host names. The capture lists the field names it kept, for review before committing.
4. `src/test/cliContract.test.ts` replays `test/cli-contract/recorded.json` through `src/test/replayCli.ts` and checks
   that every row is understood: channels with their ids and names, conversations with their people, every message
   row usable by the chat (none dropped), whole threads, members with names and agent flags, a status for everyone
   Buzz lists as present, mentions, and every search result for Lens.

Without a recording these tests are skipped; record again when Buzz releases a new CLI. `cli_capture_check.js` runs
the whole chain on every harness run against a small sample CLI (`src/test/sampleCli.ts`): the capture records every
read command and nothing else, keeps nothing original and leaves no temporary folder behind, and the contract tests
pass on the recording but fail when a field is renamed, a list is wrapped in an object or the presence field changes
its name. The anonymiser's own rules are unit tested (`anonymise.test.ts`); when it was made to keep names, texts, ids
or unknown values in a copy of `out/`, the capture refused to save every time.

## Coverage

Measured with V8's own coverage (`NODE_V8_COVERAGE`) over the compiled code in `out/`, mapped back to the TypeScript
sources and reported with [c8](https://github.com/bcoe/c8) 10.1.3, on the runs counted above. Statements and lines
give the same figure here.

| What ran                 | Modules counted                                           | Lines  | Branches | Functions |
| ------------------------ | --------------------------------------------------------- | ------ | -------- | --------- |
| Unit tests               | the modules they load                                     | 96.83% | 84.07%   | 91.63%    |
| Unit tests and harnesses | the 25 modules they load                                  | 93.15% | 84.37%   | 89.61%    |
| Unit tests and harnesses | all 33 modules with code (`protocol.ts` holds only types) | 80.48% | 84.11%   | 88.08%    |

The difference between the last two rows is the eight modules no test loads, 1,101 lines (see _What is not tested_).
Among the modules that are loaded, these reach the fewest lines:

| Module         | Lines  | What no test reaches                                                                                      |
| -------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `lens.ts`      | 63.87% | The editor side of Lens: CodeLens, hover card, gutter marks, status bar (search and matching are covered) |
| `config.ts`    | 71.01% | Finding the CLI, the relay address and the Mac app locations, which the setup wizard uses                 |
| `agentRepo.ts` | 78.13% | The status bar, watching the agents' folder, and the "Open a file from the agents' copy" picker           |
| `refs.ts`      | 79.78% | Multi-root workspaces, choosing between several matching files, opening a reference at its line           |

`media/chat.js` runs in the browser and is not part of these figures.

To measure it yourself (the paths must be absolute, since the harnesses start processes of their own):

```
npm run compile
NODE_V8_COVERAGE="$PWD/coverage/v8" npm test
NODE_V8_COVERAGE="$PWD/coverage/v8" npm run harness
npx c8@10.1.3 report --temp-directory coverage/v8 --all --src out --include "out/*.js" --exclude "out/test/**" --exclude "out/protocol.js" --reporter text
```

`npm run coverage` gives Node's own report for the unit tests alone; it counts slightly differently from c8.

## Writing a test

- A bug fix comes with the test that would have caught it. Check that the test fails without the fix: harnesses take
  the project folder as their argument, so a copy of `out/` with the fix reverted can be tested directly
  (`node test/harness/<name>.js <copy>`).
- Fake the way the real thing answers, including what it leaves out (see _How the fakes are built_).
- Prefer exact checks (which reads happened, which rows were posted) to timings. Where a time budget is needed, make
  it a few times what a laptop takes and multiply it by `BUZZ_TIME_SCALE`.
- A harness prints one `PASS` or `FAIL` line per check, exits non-zero on failure, and prints `SKIP <reason>` and
  exits 0 when something it needs is missing. Name it `*_check.js`, `stress_*.js` or `perf_*.js` and `run.js` picks it
  up.
- A harness must not touch the user's files: work in a temporary folder or in memory.

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push to `main` and every pull request, on
Ubuntu and Windows with Node 22: `npm ci`, `npm audit --omit=dev --audit-level=high` (the runtime dependencies),
`npm run check`, `npm run harness`, and on Ubuntu `npm run coverage` and `npm run package`, whose `.vsix` is kept as an
artifact. The workflow has not run on GitHub yet: the repository is not public yet. Everything it runs has been run
locally on Windows.

## What is not tested

- **No test runs inside VS Code.** The VS Code API is faked, so a change in how VS Code itself behaves would not be
  caught. The modules that are mostly VS Code glue are not loaded by any test: activation and wiring
  (`extension.ts`), the setup wizards (`setup.ts`), the view hosts (`chatView.ts`), channel management
  (`channelAdmin.ts`), starting Buzz Desktop (`desktop.ts`), diagnostics (`diagnostics.ts`), sending problems and code
  (`problems.ts`, `sendCode.ts`). They are tried by hand in a real VS Code before a release. Integration tests with
  `@vscode/test-electron` would close most of this gap.
- **No test talks to a live Buzz.** The relay is a fake that follows Buzz's protocol as it is today, so a change in
  the relay's behaviour would not be caught. The CLI's output is checked against a recording of the real CLI (see
  _The real Buzz CLI, recorded_), which is only as recent as its last capture; until the first one is made, those
  tests are skipped. One opt-in test starts the real CLI (`BUZZ_CLI_SMOKE=1`).
- **The webview script is not measured.** `media/chat.js` runs in Chrome; the browser harnesses check its behaviour,
  but its coverage is not counted.
- **macOS is not in CI.** The platform-specific parts (where the CLI and Buzz Desktop are looked for) are unit
  tested with each platform's paths, but nothing runs on a Mac.
- **The signing code is checked for correctness, not for timing.** The tests prove the BIP-340 implementation gives
  the right answers; they do not prove it runs in constant time, and it does not (see
  [SECURITY.md](../SECURITY.md)).
- **Timing on loaded machines.** Some unit tests start processes (git, the fake CLI, a second Node for the TLS relay)
  and are slower on a busy machine; the time limit per test is two minutes. During development, the two
  uncommitted-work tests of `agentGit.test.ts` (a branch without commits of its own, a linked worktree) failed in
  three runs on a heavily loaded machine, taking 3–13 s, and passed when run again; the ping test of `live.test.ts`
  failed once in 20 repeated runs. The cause is not established.
