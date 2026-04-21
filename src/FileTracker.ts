import * as vscode from 'vscode';
import { TrackedFile } from './types';

export class FileTracker implements vscode.Disposable {
  private trackedFiles = new Map<string, TrackedFile>();
  private disposables: vscode.Disposable[] = [];
  private readonly workspaceRoot: string;
  private debounceTimer: NodeJS.Timeout | null = null;

  private readonly _onDidChangeFiles = new vscode.EventEmitter<void>();
  readonly onDidChangeFiles = this._onDidChangeFiles.event;

  private scheduleFire(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this._onDidChangeFiles.fire();
    }, 300);
  }

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.register();
  }

  private register(): void {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => this.onSave(doc)),
      vscode.workspace.onDidChangeTextDocument(e => this.onChanged(e.document)),
      vscode.workspace.onDidCreateFiles(e => e.files.forEach(f => this.onCreate(f))),
      vscode.workspace.onDidDeleteFiles(e => e.files.forEach(f => this.onDelete(f)))
    );
  }

  private isTracked(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && uri.fsPath.startsWith(this.workspaceRoot);
  }

  private relativePath(fsPath: string): string {
    const sep = this.workspaceRoot.endsWith('/') ? '' : '/';
    return fsPath.replace(this.workspaceRoot + sep, '');
  }

  private onChanged(doc: vscode.TextDocument): void {
    if (!this.isTracked(doc.uri)) { return; }
    const fsPath = doc.uri.fsPath;
    if (!this.trackedFiles.has(fsPath)) {
      this.trackedFiles.set(fsPath, {
        path: fsPath,
        relativePath: this.relativePath(fsPath),
        changeType: 'modified',
        openedAt: new Date().toISOString()
      });
      this.scheduleFire();
    }
  }

  private onSave(doc: vscode.TextDocument): void {
    if (!this.isTracked(doc.uri)) { return; }
    const fsPath = doc.uri.fsPath;
    const existing = this.trackedFiles.get(fsPath);
    const now = new Date().toISOString();
    if (existing) {
      existing.savedAt = now;
    } else {
      this.trackedFiles.set(fsPath, {
        path: fsPath,
        relativePath: this.relativePath(fsPath),
        changeType: 'modified',
        openedAt: now,
        savedAt: now
      });
    }
    this.scheduleFire();
  }

  private onCreate(uri: vscode.Uri): void {
    if (!this.isTracked(uri)) { return; }
    const fsPath = uri.fsPath;
    this.trackedFiles.set(fsPath, {
      path: fsPath,
      relativePath: this.relativePath(fsPath),
      changeType: 'added',
      openedAt: new Date().toISOString()
    });
    this.scheduleFire();
  }

  private onDelete(uri: vscode.Uri): void {
    if (!this.isTracked(uri)) { return; }
    const fsPath = uri.fsPath;
    const existing = this.trackedFiles.get(fsPath);
    if (existing) {
      existing.changeType = 'deleted';
    } else {
      this.trackedFiles.set(fsPath, {
        path: fsPath,
        relativePath: this.relativePath(fsPath),
        changeType: 'deleted',
        openedAt: new Date().toISOString()
      });
    }
    this.scheduleFire();
  }

  /** Pre-popula o tracker com arquivos de uma sessão salva (usado no resume). */
  loadFiles(files: TrackedFile[]): void {
    this.trackedFiles.clear();
    for (const file of files) {
      this.trackedFiles.set(file.path, { ...file });
    }
    this._onDidChangeFiles.fire();
  }

  getTrackedFiles(): TrackedFile[] {
    return Array.from(this.trackedFiles.values());
  }

  reset(): void {
    this.trackedFiles.clear();
    this._onDidChangeFiles.fire();
  }

  dispose(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.disposables.forEach(d => d.dispose());
    this._onDidChangeFiles.dispose();
  }
}
