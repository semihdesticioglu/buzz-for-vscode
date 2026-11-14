# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.8.8 - 2026-11-14

The first release on the VS Code Marketplace. The extension works as in 0.8.7; the documentation, the tests and the
README around it are new.

### Documentation and tests (no change in behaviour)

- `docs/ARCHITECTURE.md`: the modules, the two ways to Buzz (CLI and relay), authentication and delivery, failure and
  recovery, paging and deduplication, Show diff, proposals, Buzz Lens, the webview and the trust boundaries, with
  diagrams. `docs/TESTING.md`: the test layers, what they cover, measured coverage and the limits.
- `SECURITY.md` lists the controls with the tests that check them, and the known risks in order of severity.
- New unit tests: all 19 official BIP-340 test vectors (five were checked before), one-shot reads over the live
  connection (complete only on EOSE; timeout, CLOSED and a dropped socket keep what arrived), the Jira client against
  a local server (token only in the header, errors without it, caching), a CLI that hangs, user text that looks like
  a CLI option, and the working/typing state.
- New harness `proposal_apply_check.js`: applying a proposal against an in-memory workspace (paths outside the
  workspace and inside `.git` refused, a question when the file changed since the message, nothing overwritten while
  the question is open, all or nothing over several files, unsaved edits, Undo, and the opt-in setting). Show diff's
  changes editor rows are compared with git (added, changed, deleted and renamed files), and every write to the
  agents' file system is checked to be refused.
- New harness `mentions_check.js`: mention notifications (no history on the first run, each mention once whether
  polling or the live connection brings it, nothing lost in the same second, windows in the background, Open, the
  setting that turns them off, a failed read, dispose).
- Contract tests against the real Buzz CLI: `test/cli-contract/capture.js` records the answers to the read-only
  commands the extension uses, anonymised (saving is refused if anything original would remain), and
  `src/test/cliContract.test.ts` replays them; `cli_capture_check.js` runs the chain against a sample CLI. The tests
  are skipped until a recording is committed.
- The repository harnesses run against a demo repository made at test time instead of a real agents' checkout, so
  they run in CI; example branch names and issue keys in the tests are neutral. On CI a missing browser fails the
  harness run instead of skipping the webview harnesses, and a failing randomised harness prints its seed.
- Contributing guide with debugging and release steps, issue and pull request templates, Dependabot, and CI with
  least-privilege permissions, a runtime dependency audit and a coverage report. The README screenshot shows the
  current chat.
- Example data is made up throughout: the README screenshot, the README's examples, the test data and code comments
  use an imaginary online marketplace (`shop-analytics`, `SHOP-142`, `pipeline/steps/seller_score.py`).

## 0.8.7 - 2026-11-11

### Changed

- A relay whose TLS certificate this computer does not trust (often a company's own) is named as such: the live dot
  says the certificate is not trusted and what to do, instead of "connection closed (1006)". VS Code and the Buzz CLI
  both trust the certificates installed in the system, so installing the company's root certificate is the fix.
- The live connection over `wss://` is tested: with a trusted certificate it authenticates and reads, with an
  untrusted one it refuses the connection.

## 0.8.6 - 2026-11-11

### Changed

- Drafts belong to the thread they are typed in. The composer used to hold one text for every thread and channel, so
  a half-written reply to one thread went to another with a single Enter. Each thread, and each channel's **New
  thread**, now keeps its own draft: its text, the people picked with `@`, and the message it answers. Coming back
  brings it back, threads with a draft carry a pencil in the list, and a sent message leaves the draft it was typed
  in even if another thread is on screen by then. Code and terminal chips stay with the composer: you add them first
  and pick the thread after.
- Drafts are kept by the extension, so the side bar and the editor tab share them and they outlive a reload (at most
  30, the newest). The single draft an older version kept goes to the first thread opened.

## 0.8.5 - 2026-11-11

### Fixed (stress campaign: first run, hostile input, an impatient user, a bad network, scale; then two reviews of those fixes)

- Someone who closed Buzz Desktop kept a green dot until VS Code restarted. Buzz lists only the people whose presence
  is live (Buzz Desktop and each agent renew it every minute; it lapses after three), and each answer was merged into
  the last one. Whoever is not listed is now offline, as Buzz Desktop shows them. The same merge kept agents
  "unknown", so the "agents are offline" bar did not show; it does now. Someone who just wrote no longer counts as
  online when Buzz answers presence.
- A message sent in the moment between a click on another channel and the view switching went to the newly clicked
  channel, as a reply to a thread of the previous one. The composer now sends the channel it shows with the message,
  and the message goes there: for a DM note that stands for several conversations, into the one its thread lives in,
  also when the new channel is opened a second time while it loads. If that channel is gone from the list, the text
  stays in the composer with a notice.
- A message sent just before such a switch left the new channel showing "waiting for @agent" and polling fast for an
  answer that would come elsewhere; asking an offline agent and switching at once no longer loses the notice that it
  is offline.
- Rows the CLI returns that are not messages (a null, a number for content, no key, no time) threw while the thread
  list was built, leaving the channel empty and the incremental read asking for `since NaN`. Such rows are dropped
  where the CLI's output is read; a page that had one still counts as full (so "Older threads" goes on, and a
  500-message thread is still completed over the live connection), each such row is logged once, a row nested
  thousands of levels deep no longer fails the read, and output that is not a list is logged.
- After a failed first read of a channel, the list could stay at the latest 50 messages without "Older threads" for
  up to a minute (when another channel had been read just before, or a reaction came first); the next read now
  brings the cursors.
- Opening a thread of 1,500 messages read `~/.buzz/AGENTS.md` once per message (the relay's host, for inline
  images); it is read once per batch now: 1.3 s became 0.24 s on the stress set.
- The thread list of a channel was built twice on first load in the wide layout (500 rows thrown away before the
  first paint).
- A setup, key or network failure was reported twice: on the setup card and as a toast with the same sentence (also
  when a search result or a notification opened a channel missing from the list).
- Text nested deeper than markdown-it draws (100 levels of quotes, about 50 of lists) was dropped without a trace, so a
  sender could hide text from VS Code users. Blocks now nest 20 levels deep and whatever lies deeper is shown as plain
  text, ending where markdown-it ends a paragraph (a file tree ten levels deep renders exactly as before); code blocks
  are numbered the same way for the proposal bars as on screen.
- A thread found incomplete on open was not marked so when no new message came with it.
- After a failed first read, the recovery poll started filling the list before the page it had read was in: one
  redundant CLI read.
- `npm test` could hang for good: when the live connection's ping test failed on a busy machine, it left its relay
  and reconnect loop running. It cleans up now, a stuck test fails after two minutes, and the run always ends.

### Changed

- The scenario, stress and performance harnesses live in the repository (`test/harness/`, `npm run harness`), next
  to the unit tests, and CI runs them on Ubuntu and Windows. Time budgets in them have headroom and scale with
  `BUZZ_TIME_SCALE` (3 in CI); a harness's own pace is reported, not checked. The fakes answer as the real CLI does
  (presence lists only who is online).

## 0.8.4 - 2026-11-10

### Fixed (third independent review, 32 findings)

- "Older threads" ended too early: a page holding only messages of a thread already opened counted as the end, two
  concurrent reads (the fill loop and the button) made the second look like the end, and a failed first read removed
  the button for good. Pages are now judged by their size, reads are serialised, and the list fills itself once a read
  succeeds.
- A thread whose oldest part could not be read (no live connection) says so instead of looking complete; what a
  cut-short page did bring is kept.
- The wide view closes the side bar only when opened from the side bar's ⤢, not on every notification.
- Older "dm" channels: peers are never computed before the identity is known; a failed member read is retried instead
  of cached; "dm" channels with several people (or a real channel named so) stay channels; member reads run a few at
  a time.
- Jira: a response cut off after its headers no longer hangs the card; switching between Jira Cloud and Server asks
  for a token of the right kind.
- The extension always runs on the local machine (`extensionKind: ui`), also in Remote/WSL windows.
- Setup card: "Start setup" only when something is really missing; a passing failure offers "Try again".
- Search: a search the extension could not answer no longer traps the list; results keep their scroll position; the
  selected row is marked by id; an all-channel search survives opening a result in another channel; the cap is
  reported as the number of matches read.
- Thread filter: matches the message text and author only (not buttons and labels), folds both English and Turkish
  case, hides day lines left empty, shows authors of grouped messages, opens folded bodies that match, and clears its
  count on a channel switch.
- Smaller: "waiting for @agent…" expires on time; the CLI's buzz.exe next to the app is not taken for the app; the
  macOS launcher reads all of `open`'s output; the member directory cache is cleared on a key change; reply kind
  40003 is read everywhere; a thread opened from a notification is read once, not twice.

## 0.8.3 - 2026-11-10

### Changed

- The thread filter is a visible **Filter** button in the thread header (an icon with a label; the icon alone in the narrow side bar).

## 0.8.2 - 2026-11-10

### Fixed

- Older direct messages that the relay lists only as channels named "dm" showed up as "#dm" channel notes. They are
  direct messages: their members say whose they are, and they join the note of the same person or agent.

## 0.8.1 - 2026-11-10

### Changed

- The thread list fills further on opening a channel (30 threads, up to ten more pages) and reads those pages over
  the live connection, 200 messages at a time, instead of one CLI process per page. **Older threads** is a visible
  button now.

## 0.8.0 - 2026-11-10

### Added

- **Search** above the thread list: Buzz's full-text search over the whole history you can read (the live
  connection, else the CLI), in this channel or in every channel, with the threads that match as the result.
- **⌕** in the thread header: an instant filter over the messages of the open thread.

## 0.7.9 - 2026-11-10

### Fixed

- Long threads were cut: the CLI returns at most 100 messages of a thread unless asked for more, so a thread of
  275 showed 237. The chat now asks for 500 and reads anything beyond that over the live connection, page by page.

## 0.7.8 - 2026-11-10

### Changed

- "@agent is working…" is shown only on the agent's own signal, as in Buzz Desktop. After a mention without a
  signal the chat says "waiting for @agent…" for up to three minutes.

## 0.7.7 - 2026-11-10

### Changed

- The chat remembers where it is worked in. After **⤢**, a notification, the status bar item and the commands open
  the editor tab (again, after a reload or when the tab was closed) instead of the side bar; **⤡** in the tab is the
  way back to the side bar. Closing the tab no longer pops the side bar open.

## 0.7.6 - 2026-11-10

### Changed

- **⤢** moves the chat into the editor tab instead of opening a second chat next to the side bar: the side bar closes,
  and **⤡** in the tab (or closing it) brings the chat back to the side bar.

## 0.7.5 - 2026-11-10

### Added

- Jira Cloud (`*.atlassian.net`): **Buzz: Connect Jira** asks for the account e-mail and sends it with the API token
  (Basic), as Cloud requires; Jira Server / Data Center keeps the personal access token (Bearer). Setting
  `buzz.jira.email`.
- **Buzz: Diagnostics** writes what the extension sees on this computer into the connection log, for support.

## 0.7.4 - 2026-11-10

### Fixed

- The subscription for channel events other than messages is back to all kinds: the relay accepts a channel-scoped
  filter without `kinds` (seen in production), and that is what refreshes the channel at once on deletions, member
  changes and channel edits. 0.7.3 had narrowed it to deletions.
- The connection log no longer lists the relay's acknowledgement of every finished search.

## 0.7.3 - 2026-11-10

### Changed

- **Add a member** and **Join a channel** open their lists at once and fill them while loading; the member directory
  comes from the live connection in one query (kept for a minute) instead of one CLI call per channel.
- Show diff on a branch the agent is still working on finds its uncommitted changes wherever the branch is checked
  out: the agents' folder or one of its git worktrees (agents often keep one per task); a branch fast-forwarded into
  `buzz` shows its own commits again.

### Fixed (second independent review)

- Reading uncommitted work used `git diff`, which refreshes the agents' `.git/index` even with `--no-optional-locks`;
  it is `git status` now, which does not write. A test hashes the index to prove it.
- A live read the relay refused or cut short (CLOSED, timeout, connection lost) was taken as a complete answer: Lens
  cached "no conversations" and missing thread roots were never fetched. Reads now say whether they are complete; the
  CLI answers otherwise, and unconfirmed roots are looked for again later.
- "Load older" on a DM note that stands for several conversations paged only the newest one with a cursor from all
  of them; each conversation has its own cursor now. A page that brings nothing new ends the paging.
- The subscription for deletions had no `kinds` and was refused by the relay: deletions made in Buzz Desktop now
  disappear at once again.
- On a channel switch the previous channel's members lingered until the new list arrived, so the agents-offline bar
  could name the wrong agents; the bar's sentence follows the EN/TR switch.
- Starting Buzz Desktop is reported only once it actually ran; the chosen path is remembered after a successful
  start, and the CLI's own `buzz.exe` is not accepted as the app. On a Mac, `open`'s complaints are shown.
- Add a member: direct messages are no longer offered as targets; the CLI fallback reads a few channels at a time.
- A failed first read of a channel no longer leaves "Loading…" without polling; an empty channel no longer re-reads
  four times; one transient presence error no longer disables presence for the whole session; an edited message's
  proposals are read again; a superseded thread load cannot write into a newer one.
- File names with Turkish İ/ı are found by Lens whatever their case; `[`, `]`, `*` in a name no longer pick up other
  files' histories (literal pathspecs).
- CI runs on Node 22 and the test script no longer relies on shell globbing.

## 0.7.2 - 2026-11-10

### Fixed

- Direct messages: one grey note per person or agent. Buzz may hold several DM conversations with the same people
  (each `dms open` makes a new one and the list repeats them), which showed up as a growing row of identical notes.
  The note now stands for all of them: their messages are read together, a reply goes into the conversation its
  thread lives in, a new thread into the newest one.

## 0.7.1 - 2026-11-10

### Changed

- Buzz Lens searches over the live connection (NIP-50) in pages of 500, reading the history in time windows when
  a page is full, so old conversations are found too; the CLI remains the fallback. The search text names the file
  every way a message may write it (name, name with extension, path). The connection log shows the timing.

## 0.7.0 - 2026-11-09

### Added

- When every agent of the channel is offline (Buzz Desktop closed), a bar says so and **Open Buzz Desktop** starts
  it; mentioning an offline agent shows a notice instead of a silent "working…". Setting `buzz.desktopPath`.
- Channel management: **＋** next to the channel notes and the commands **New channel…**, **Join a channel…**,
  **Add a member to a channel…**.
- Show diff on a branch the agent is still working on (no commits of its own yet) shows the uncommitted changes of
  the agents' folder, marked as such.

### Fixed

- Show diff on a branch without commits of its own used to show the last commit of `buzz`, which was another task's
  work.

## 0.6.0 - 2026-11-09

### Changed

- The thread list reads more pages when the first one does not fill the screen, and fetches the first messages of
  threads that the pages did not include, so no thread shows an "older…" placeholder.
- Messages are rendered once and reused: opening a long thread is several times faster, and a nested reply no
  longer re-renders the whole thread.
- The extension ships as one bundled file (esbuild): a smaller package and a quicker start.
- The webview's Content Security Policy no longer allows inline styles.

### Internal

- Typed messages between the extension and the webview (`src/protocol.ts`).
- The chat controller is split: rendering (`chatRender.ts`), presence and typing (`presence.ts`), the first-run
  wizards (`setup.ts`), the git questions about the agents' repositories (`agentGit.ts`, with tests against a real
  temporary repository).
- Bounded caches for Jira issues and announced mentions; no module-level singletons for the agents' repositories.
- ESLint, Prettier and a CI workflow; stricter TypeScript settings.

## 0.5.0 - 2026-11-09

First public version, as `semihdesticioglu.buzz-for-vscode`.

- Chat with channels, threads, nested replies, live connection and typing/working indicators.
- Agent proposals: Show diff against the agents' code; branch and commit reports open VS Code's changes editor.
- Read-only access to the agents' repository (`~/.buzz/REPOS`, branch `buzz`).
- Buzz Lens: a bee in the gutter where a conversation discussed the code, hover card, status bar count.
- Send selections, problems and terminal output to agents; mention notifications; Jira cards.
- English and Turkish interface.
