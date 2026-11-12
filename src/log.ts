// The extension's output channel ("Buzz" in the Output panel), created on activation and used everywhere.
import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export const log = {
  /** Called once on activation with the channel the extension owns. */
  init(c: vscode.OutputChannel): void {
    channel = c;
  },
  info(line: string): void {
    channel?.appendLine(line);
  },
  show(): void {
    channel?.show(true);
  },
};
