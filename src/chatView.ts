// Where the chat lives: the side bar view (resolved by VS Code when the view is shown) or an editor tab.
import * as vscode from 'vscode';
import { ChatController } from './chat';
export class ChatViewProvider implements vscode.WebviewViewProvider {
  controller?: ChatController;
  private pending?: () => void;

  constructor(private readonly make: () => ChatController) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const c = this.make();
    c.attach({
      kind: 'view',
      webview: view.webview,
      isVisible: () => view.visible,
      onVisibility: (cb) => view.onDidChangeVisibility(cb),
      onDispose: (cb) => view.onDidDispose(cb),
      reveal: () => view.show(true),
      close: () => undefined,
    });
    this.controller = c;
    view.onDidDispose(() => {
      if (this.controller === c) this.controller = undefined;
    });
    this.pending?.();
    this.pending = undefined;
  }

  /** Reveals the view; if it isn't resolved yet, runs the work once it is. */
  async withController(fn: (c: ChatController) => void | Promise<void>): Promise<void> {
    if (this.controller) {
      this.controller.reveal();
      await fn(this.controller);
      return;
    }
    this.pending = () => void Promise.resolve(fn(this.controller!)).catch(() => undefined);
    await vscode.commands.executeCommand('buzz.chat.focus');
  }
}

/** Opens the chat in an editor tab: threads on the left, the conversation on the right. `onClosed` runs when the tab goes. */
export function openChatPanel(make: () => ChatController, onClosed?: () => void): ChatController {
  const panel = vscode.window.createWebviewPanel('buzz.chatPanel', 'Buzz', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  const c = make();
  c.attach({
    kind: 'panel',
    webview: panel.webview,
    isVisible: () => panel.visible,
    onVisibility: (cb) => panel.onDidChangeViewState(cb),
    onDispose: (cb) => panel.onDidDispose(cb),
    reveal: () => panel.reveal(),
    close: () => panel.dispose(),
  });
  if (onClosed) panel.onDidDispose(onClosed);
  return c;
}
