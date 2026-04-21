import * as vscode from 'vscode';
import { SessionManager } from '../SessionManager';

export const SESSION_DIFF_SCHEME = 'session-diff';

export class SessionDiffProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly sessionManager: SessionManager) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const sessionId = uri.path.replace(/\.diff$/, '').replace(/^\//, '');
    const fileFilter = uri.query || undefined;

    const session = this.sessionManager.getSessionById(sessionId);
    if (!session?.git?.diff) {
      return '(Nenhum diff salvo para esta sessão)';
    }

    if (!fileFilter) {
      return session.git.diff;
    }

    return this.extractFileDiff(session.git.diff, fileFilter);
  }

  private extractFileDiff(fullDiff: string, relativePath: string): string {
    const lines = fullDiff.split('\n');
    const result: string[] = [];
    let inside = false;

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        inside = line.includes(relativePath);
      }
      if (inside) { result.push(line); }
    }

    return result.length > 0
      ? result.join('\n')
      : `(Nenhum diff encontrado para ${relativePath})`;
  }

  buildUri(sessionId: string, relativePath?: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SESSION_DIFF_SCHEME,
      path: `/${sessionId}.diff`,
      query: relativePath ?? ''
    });
  }
}
