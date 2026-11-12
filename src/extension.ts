// Buzz for VS Code: entry point.
import * as vscode from 'vscode';
import { AGENT_SCHEME, AgentFs, AgentRepos, openAgentFile } from './agentRepo';
import { BuzzClient } from './api';
import { addMember, channelMenu, clearDirectory, joinChannel, newChannel } from './channelAdmin';
import { ChatController, contextFromEditor } from './chat';
import { ChatViewProvider, openChatPanel } from './chatView';
import * as cfg from './config';
import { openBuzzDesktop } from './desktop';
import { runDiagnostics } from './diagnostics';
import { CodeContext } from './core';
import { setLang, t } from './i18n';
import { JiraService } from './jira';
import { BuzzLens, openLensTargets } from './lens';
import { LiveManager } from './live';
import { MentionWatcher } from './mentions';
import { pickProblem, SendProblemActions, terminalSelection } from './problems';
import { PROPOSAL_SCHEME, ProposalDocuments } from './proposals';
import { sendDiff, sendSelection } from './sendCode';
import { cliOptions, connectJira, promptKey, runSetup, Secrets, verifyConnection } from './setup';
import { log } from './log';

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  setLang(cfg.uiLanguage());
  const secrets = new Secrets(ctx.secrets);
  const client = new BuzzClient(
    () => cliOptions(secrets),
    (line) => log.info(line),
  );
  const out = vscode.window.createOutputChannel('Buzz');
  log.init(out);
  ctx.subscriptions.push(out);
  const live = new LiveManager(secrets); // live connection to the relay (polling continues without it)
  const jira = new JiraService(() => secrets.jira(), cfg.jiraUrl, cfg.jiraEmail); // read-only, for issue cards
  const docs = new ProposalDocuments(); // proposed text shown in the diff view
  // the agents' repositories, read-only: file links, Show diff and Lens read their branch
  const agentRepos = new AgentRepos();
  const agentFs = new AgentFs(agentRepos);
  const make = () => new ChatController(ctx, client, live, jira, docs, agentRepos);
  const chat = new ChatViewProvider(make);
  const mentions = new MentionWatcher(ctx, client, live);
  ctx.subscriptions.push(
    agentRepos,
    agentFs,
    vscode.workspace.registerFileSystemProvider(AGENT_SCHEME, agentFs, { isCaseSensitive: true, isReadonly: true }),
    vscode.commands.registerCommand('buzz.openAgentFile', () => openAgentFile(agentRepos)),
  );
  const lens = new BuzzLens(client, ctx.extensionUri, agentRepos, live); // Buzz threads above the code they discuss
  let wide: ChatController | undefined; // wide view (editor tab); preferred while open
  let settingUp = false;

  const controllers = () => [chat.controller, wide?.alive ? wide : undefined].filter((c): c is ChatController => !!c);

  const reloadAll = async () => {
    client.reset();
    clearDirectory();
    lens.clear();
    await live.restart();
    await chat.controller?.reload().catch(() => undefined);
    if (wide?.alive) await wide.reload().catch(() => undefined);
  };

  // where the chat is worked in: the editor tab (⤢) or the side bar (⤡); a notification, the status bar and the
  // commands open it there, also after a reload or when the tab was closed
  const WIDE_MODE = 'buzz.wideMode';
  const wideMode = () => ctx.globalState.get<boolean>(WIDE_MODE, false);
  /** `fromSideBar`: the user pressed ⤢ in the side bar, so the tab takes the side bar's place; otherwise the side bar is left alone. */
  const openWide = async (fromSideBar = false): Promise<ChatController> => {
    if (wide?.alive) {
      wide.reveal();
      return wide;
    }
    wide = openChatPanel(make);
    await ctx.globalState.update(WIDE_MODE, true);
    if (fromSideBar) await vscode.commands.executeCommand('workbench.action.closeSidebar');
    return wide;
  };
  /** Runs in the wide view when it is open or preferred, otherwise in the side bar view. */
  const withChat = async (fn: (c: ChatController) => void | Promise<void>) => {
    if (wide?.alive || wideMode()) {
      const c = await openWide(); // what is asked before the tab is ready waits for it (openChannel, addContext)
      await fn(c);
    } else {
      await chat.withController(fn);
    }
  };
  const addToChat = (c: CodeContext | undefined) => (c ? withChat((ctrl) => ctrl.addContext(c)) : undefined);
  // channel management works on the channel the chat shows
  const admin = {
    client,
    live,
    current: () => (wide?.alive ? wide : chat.controller)?.channel,
    open: (id: string) => withChat((c) => c.openChannel(id)),
  };

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('buzz.chat', chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, docs),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new SendProblemActions(), {
      providedCodeActionKinds: SendProblemActions.kinds,
    }),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lens),
    docs,
    lens,
    live,
    mentions,
    vscode.commands.registerCommand('buzz.showLog', () => log.show()),
    vscode.commands.registerCommand('buzz.diagnostics', () => runDiagnostics({ ctx, client, live, secrets })),
    vscode.commands.registerCommand('buzz.lens.open', openLensTargets),
    vscode.commands.registerCommand('buzz.lens.refresh', () => lens.clear()),
    vscode.commands.registerCommand('buzz.lens.showFile', () => lens.showFile()),
    vscode.commands.registerCommand('buzz.setup', async () => {
      settingUp = true; // the wizard writes settings as it goes; one reload at its end, not one per setting
      try {
        await runSetup(secrets, client, reloadAll);
      } finally {
        settingUp = false;
      }
    }),
    vscode.commands.registerCommand('buzz.refresh', reloadAll),
    vscode.commands.registerCommand('buzz.openDesktop', openBuzzDesktop),
    vscode.commands.registerCommand('buzz.newChannel', () => newChannel(admin)),
    vscode.commands.registerCommand('buzz.joinChannel', () => joinChannel(admin)),
    vscode.commands.registerCommand('buzz.addMember', () => addMember(admin)),
    vscode.commands.registerCommand('buzz.channelMenu', () => channelMenu(admin)),
    vscode.commands.registerCommand('buzz.openChannel', (id: string, eventId?: string) => withChat((c) => c.openChannel(id, eventId))),
    vscode.commands.registerCommand('buzz.showChat', async () => {
      mentions.clearUnread();
      if (wide?.alive || wideMode()) await openWide();
      else await vscode.commands.executeCommand('buzz.chat.focus');
    }),
    vscode.commands.registerCommand('buzz.backToSideBar', async () => {
      await ctx.globalState.update(WIDE_MODE, false);
      wide?.close();
      await vscode.commands.executeCommand('buzz.chat.focus');
    }),
    vscode.commands.registerCommand('buzz.openChatInEditor', () => openWide(true)),
    vscode.commands.registerCommand('buzz.addSelectionToChat', () => {
      const c = contextFromEditor(vscode.window.activeTextEditor);
      if (!c) return vscode.window.showInformationMessage(t('sel.none'));
      return addToChat(c);
    }),
    vscode.commands.registerCommand('buzz.sendProblem', async (uri?: vscode.Uri, diag?: vscode.Diagnostic) =>
      addToChat(await pickProblem(uri instanceof vscode.Uri ? uri : undefined, diag)),
    ),
    vscode.commands.registerCommand('buzz.sendTerminalSelection', async () => addToChat(await terminalSelection())),
    vscode.commands.registerCommand('buzz.sendSelection', () => sendSelection(ctx, client)),
    vscode.commands.registerCommand('buzz.sendDiff', (sc?: { rootUri?: vscode.Uri }) => sendDiff(ctx, client, sc)),
    vscode.commands.registerCommand('buzz.setKey', async () => {
      if (await promptKey(secrets)) await verifyConnection(client, reloadAll);
    }),
    vscode.commands.registerCommand('buzz.setJiraToken', async () => {
      if (await connectJira(secrets)) jira.clear();
    }),
    vscode.commands.registerCommand('buzz.forget', async () => {
      await secrets.forget();
      jira.clear();
      client.reset();
      clearDirectory();
      await vscode.commands.executeCommand('setContext', 'buzz.ready', false);
      void vscode.window.showInformationMessage(t('forget.done'));
      await reloadAll();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('buzz.language')) {
        setLang(cfg.uiLanguage());
        jira.clear(); // cached error texts are in the old language
        mentions.refresh();
        lens.redraw();
        controllers().forEach((c) => c.languageChanged());
      }
      if (e.affectsConfiguration('buzz.lens.enabled') || e.affectsConfiguration('buzz.lens.inline')) lens.redraw();
      if (e.affectsConfiguration('buzz.mentionSeconds')) mentions.settingsChanged();
      if (e.affectsConfiguration('buzz.proposals')) controllers().forEach((c) => c.languageChanged());
      if (e.affectsConfiguration('buzz.jira')) {
        // issue keys become links (or stop being links) right away
        jira.clear();
        controllers().forEach((c) => c.languageChanged());
      }
      if (!settingUp && (e.affectsConfiguration('buzz.cliPath') || e.affectsConfiguration('buzz.relayUrl'))) void reloadAll();
      else if (e.affectsConfiguration('buzz.live')) void live.restart();
    }),
  );

  await vscode.commands.executeCommand('setContext', 'buzz.ready', !!(await secrets.key()));
  await live.restart();
  mentions.start();
}

export function deactivate(): void {
  /* everything is disposed through ctx.subscriptions */
}
