import * as vscode from 'vscode';
import { SessionManager } from '../SessionManager';

export class SessionStatusBarItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly sessionManager: SessionManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.update();
    sessionManager.onDidChangeSession(() => {
      this.restartTimer();
      this.update();
    });
    this.startTimer();
  }

  private update(): void {
    const session = this.sessionManager.getActiveSession();
    if (!session) {
      this.item.text = '$(save) Session Saver';
      this.item.tooltip = 'Click to start a session';
      this.item.command = 'sessionSaver.startSession';
    } else {
      const elapsed = this.sessionManager.getElapsedMinutes();
      const h = Math.floor(elapsed / 60);
      const m = elapsed % 60;
      const timeStr = h > 0 ? `${h}h${m > 0 ? m + 'm' : ''}` : `${m}m`;
      this.item.text = `$(circle-filled) ${session.name} · ${timeStr}`;
      const tooltip = new vscode.MarkdownString(
        `**$(circle-filled) ${session.name}**\n\nDuração: ${timeStr}\n\nClique para salvar · \`Ctrl+Alt+S\``
      );
      tooltip.isTrusted = true;
      this.item.tooltip = tooltip;
      this.item.command = 'sessionSaver.saveSession';
    }
    this.item.show();
  }

  private startTimer(): void {
    this.timer = setInterval(() => this.update(), 60_000);
  }

  private restartTimer(): void {
    if (this.timer) { clearInterval(this.timer); }
    this.startTimer();
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); }
    this.item.dispose();
  }
}
