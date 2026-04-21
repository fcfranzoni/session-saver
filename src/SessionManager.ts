import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WorkSession, EditorState, CapturedPrompt, AgentSession } from './types';
import { FileTracker } from './FileTracker';
import { GitTracker } from './GitTracker';
import { SessionStorage } from './storage/SessionStorage';
import { AgentCaptureService } from './agents/AgentCaptureService';
import { ContextInjector } from './context/ContextInjector';
import { AISummarizer } from './summarizer/AISummarizer';

export class SessionManager implements vscode.Disposable {
  private activeSession: WorkSession | null = null;
  private sessionStartTime: Date | null = null;
  private fileTracker: FileTracker | null = null;
  private remindTimer: NodeJS.Timeout | null = null;
  private autoSaveTimer: NodeJS.Timeout | null = null;
  private crashDraftTimer: NodeJS.Timeout | null = null;
  private activeAgent = 'none';
  private manualPrompts: CapturedPrompt[] = [];
  private lastKnownCommit: string | undefined;
  private sessionHasMetadata = false;

  private readonly storage: SessionStorage;
  private readonly agentCapture: AgentCaptureService;
  private readonly contextInjector: ContextInjector;
  private readonly summarizer: AISummarizer;
  private readonly gitTracker: GitTracker;
  private readonly workspaceRoot: string;

  private readonly _onDidChangeSession  = new vscode.EventEmitter<void>();
  private readonly _onDidTrackFile      = new vscode.EventEmitter<void>();
  private readonly _onDidChangePrompts  = new vscode.EventEmitter<void>();

  readonly onDidChangeSession  = this._onDidChangeSession.event;
  readonly onDidTrackFile      = this._onDidTrackFile.event;
  readonly onDidChangePrompts  = this._onDidChangePrompts.event;

  getLastKnownCommit(): string | undefined { return this.lastKnownCommit; }
  setLastKnownCommit(c: string | undefined): void { this.lastKnownCommit = c; }

  constructor(private readonly context: vscode.ExtensionContext) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    this.workspaceRoot = workspaceFolder?.uri.fsPath ?? context.extensionPath;

    const sessionsDir = path.join(this.workspaceRoot, '.vscode', 'sessions');
    const clineHistoryRoot = path.join(
      path.dirname(context.globalStorageUri.fsPath),
      'saoudrizwan.claude-dev',
      'history'
    );

    this.storage        = new SessionStorage(sessionsDir);
    this.agentCapture   = new AgentCaptureService(this.workspaceRoot, sessionsDir, clineHistoryRoot);
    this.contextInjector = new ContextInjector(this.workspaceRoot, this.agentCapture);
    this.summarizer     = new AISummarizer();
    this.gitTracker     = new GitTracker(this.workspaceRoot);
  }

  // ─── Session lifecycle ────────────────────────────────────────────────────

  async startSession(name?: string): Promise<void> {
    if (this.activeSession) {
      const action = await vscode.window.showWarningMessage(
        `Session "${this.activeSession.name}" is already active. Save and start new?`,
        'Save & Start', 'Cancel'
      );
      if (action !== 'Save & Start') { return; }
      await this.saveSession();
      await this.stopSession(false, true);
    }

    const sessionName = (name ?? await vscode.window.showInputBox({
      prompt: 'Session name', placeHolder: 'e.g. Fix login JWT'
    }))?.trim();
    if (!sessionName) { return; }

    this.manualPrompts    = [];
    this.sessionHasMetadata = false;
    this.fileTracker      = new FileTracker(this.workspaceRoot);
    this.fileTracker.onDidChangeFiles(() => this._onDidTrackFile.fire());
    this.sessionStartTime = new Date();

    this.activeSession = {
      id: crypto.randomUUID(), name: sessionName,
      createdAt: this.sessionStartTime.toISOString(),
      savedAt:   this.sessionStartTime.toISOString(),
      durationMinutes: 0,
      workspaceFolder: this.workspaceRoot,
      files: [], editorState: this.captureEditorState(),
      agentSessions: [], summary: { auto: sessionName }, tags: []
    };

    await vscode.commands.executeCommand('setContext', 'sessionSaver.hasActiveSession', true);
    this._onDidChangeSession.fire();
    this.scheduleReminder();
    this.scheduleAutoSave();
    this.scheduleCrashDraft();
    vscode.window.showInformationMessage(`Session "${sessionName}" started`);
  }

  async saveSession(silent = false): Promise<void> {
    if (!this.activeSession || !this.sessionStartTime || !this.fileTracker) {
      if (!silent) { vscode.window.showWarningMessage('No active session to save'); }
      return;
    }
    try {
      await this.doSaveSession(silent);
    } catch (err) {
      if (!silent) {
        vscode.window.showErrorMessage(`Erro ao salvar sessão: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async doSaveSession(silent = false): Promise<void> {
    if (!this.activeSession || !this.sessionStartTime || !this.fileTracker) { return; }

    const now = new Date();
    const durationMinutes = Math.round((now.getTime() - this.sessionStartTime.getTime()) / 60000);

    // Start the async git capture immediately so it runs while captureAndArchive does sync I/O
    const gitCapture = this.gitTracker.capture();

    const agentSessions = this.agentCapture.captureAndArchive(
      this.sessionStartTime,
      this.activeSession.id,
      this.activeSession.agentSessions ?? [],
      this.manualPrompts
    );

    const gitState = await gitCapture;

    this.activeSession.savedAt         = now.toISOString();
    this.activeSession.durationMinutes = durationMinutes;
    this.activeSession.files           = this.fileTracker.getTrackedFiles();
    this.activeSession.editorState     = this.captureEditorState();
    this.activeSession.agentSessions   = agentSessions;
    delete this.activeSession.prompts;
    if (gitState) { this.activeSession.git = gitState; }
    else          { delete this.activeSession.git; }
    this.activeSession.summary.auto = this.buildAutoSummary(
      durationMinutes, this.activeSession.files.length, agentSessions.length
    );

    if (!silent && !this.sessionHasMetadata) {
      const existingTagsHint = this.getExistingTags().filter(t => !this.activeSession!.tags.includes(t)).slice(0, 5).join(', ');
      const tagsInput = await vscode.window.showInputBox({
        prompt: 'Tags (opcional, separadas por vírgula)',
        placeHolder: existingTagsHint ? `Ex: ${existingTagsHint}` : 'ex: bug, auth, refactor',
        value: this.activeSession.tags.join(', ')
      });
      if (tagsInput !== undefined) {
        this.activeSession.tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
      }
      const notesInput = await vscode.window.showInputBox({
        prompt: 'Nota (opcional)',
        placeHolder: 'O que estava fazendo? Contexto para retomar...',
        value: this.activeSession.notes ?? ''
      });
      if (notesInput !== undefined) {
        this.activeSession.notes = notesInput.trim() || undefined;
      }
      const ticketInput = await vscode.window.showInputBox({
        prompt: 'Ticket (opcional) — Jira, Linear, GitHub Issue...',
        placeHolder: 'ex: https://linear.app/... ou PROJ-123',
        value: this.activeSession.ticket ?? ''
      });
      if (ticketInput !== undefined) {
        this.activeSession.ticket = ticketInput.trim() || undefined;
        this.activeSession.ticketTitle = undefined;
      }
    }
    this.sessionHasMetadata = true;

    this.activeSession.agentSessions = this.agentCapture.writeConversationFiles(
      this.activeSession, agentSessions
    );
    this.storage.write(this.activeSession);
    this.storage.deleteDraft(this.activeSession.id);

    this._onDidChangeSession.fire();
    this._onDidChangePrompts.fire();
    this.clearReminder();
    this.scheduleReminder();
    if (!silent) {
      vscode.window.showInformationMessage(`Session "${this.activeSession.name}" saved`);
    }

    const snapshot = this.activeSession;
    this.summarizer.summarizeSession(snapshot).then(aiSummary => {
      if (!aiSummary) { return; }
      if (!fs.existsSync(this.storage.sessionPath(snapshot.id))) { return; }
      snapshot.summary.ai = aiSummary;
      this.storage.write(snapshot);
      this._onDidChangeSession.fire();
    }).catch(() => { /* non-fatal */ });
  }

  async stopSession(save = true, silent = false): Promise<void> {
    if (!this.activeSession) { return; }
    const config = vscode.workspace.getConfiguration('sessionSaver');
    if (save && config.get<boolean>('autoSaveOnStop', true)) { await this.saveSession(); }

    this.clearReminder();
    this.clearAutoSave();
    this.clearCrashDraft();
    this.fileTracker?.dispose();
    this.fileTracker      = null;
    this.activeSession    = null;
    this.sessionStartTime = null;
    this.manualPrompts    = [];
    this.sessionHasMetadata = false;

    await vscode.commands.executeCommand('setContext', 'sessionSaver.hasActiveSession', false);
    this._onDidChangeSession.fire();
    if (!silent) { vscode.window.showInformationMessage('Session stopped'); }
  }

  async resumeSession(session: WorkSession): Promise<void> {
    if (this.activeSession) {
      const action = await vscode.window.showWarningMessage(
        'Save current session before resuming?', 'Save', 'Discard', 'Cancel'
      );
      if (action === 'Cancel') { return; }
      if (action === 'Save')   { await this.saveSession(); }
      await this.stopSession(false, true);
    }

    this.fileTracker = new FileTracker(this.workspaceRoot);
    this.fileTracker.onDidChangeFiles(() => this._onDidTrackFile.fire());
    this.fileTracker.loadFiles(session.files);
    this.manualPrompts    = (session.prompts ?? []).filter(p => p.agent !== 'claude');
    this.sessionHasMetadata = true; // sessão já tem metadados salvos
    this.sessionStartTime = new Date();
    this.activeSession    = {
      ...session,
      createdAt: session.createdAt,
      savedAt:   this.sessionStartTime.toISOString(),
      durationMinutes: 0
    };

    if (session.git?.branch) {
      const current = await this.gitTracker.currentBranch();
      if (current && current !== session.git.branch) {
        const action = await vscode.window.showInformationMessage(
          `A sessão estava no branch "${session.git.branch}" (atual: "${current}"). Fazer checkout?`,
          'Sim', 'Não'
        );
        if (action === 'Sim') {
          try { await this.gitTracker.checkout(session.git.branch); }
          catch { vscode.window.showWarningMessage(`Não foi possível checkout para "${session.git.branch}"`); }
        }
      }
    }

    this.contextInjector.inject(session).catch(() => { /* non-fatal */ });
    await this.restoreEditorState(session.editorState);

    await vscode.commands.executeCommand('setContext', 'sessionSaver.hasActiveSession', true);
    this._onDidChangeSession.fire();
    this._onDidChangePrompts.fire();
    this.scheduleReminder();
    this.scheduleAutoSave();
    this.scheduleCrashDraft();
    vscode.window.showInformationMessage(`Session "${session.name}" resumed`);
  }

  // ─── Session CRUD ─────────────────────────────────────────────────────────

  async togglePinSession(session: WorkSession): Promise<void> {
    const saved = this.storage.getById(session.id);
    if (!saved) { return; }
    saved.pinned = !saved.pinned;
    this.storage.write(saved);
    this._onDidChangeSession.fire();
  }

  async setSessionTicket(session: WorkSession): Promise<void> {
    const ticket = await vscode.window.showInputBox({
      prompt: 'Link ou ID do ticket (Jira, Linear, GitHub Issue...)',
      placeHolder: 'ex: https://linear.app/... ou PROJ-123',
      value: session.ticket ?? ''
    });
    if (ticket === undefined) { return; }
    const saved = this.storage.getById(session.id);
    if (!saved) { return; }
    saved.ticket = ticket.trim() || undefined;
    saved.ticketTitle = undefined;
    this.storage.write(saved);
    this._onDidChangeSession.fire();
    // Fetch GitHub issue/PR title in background
    if (saved.ticket) {
      this.tryFetchTicketTitle(saved.ticket).then(title => {
        if (!title) { return; }
        const s = this.storage.getById(saved.id);
        if (!s) { return; }
        s.ticketTitle = title;
        this.storage.write(s);
        this._onDidChangeSession.fire();
      }).catch(() => {});
    }
  }

  async setSessionTags(session: WorkSession): Promise<void> {
    const existing = this.getExistingTags();
    const current  = session.tags ?? [];
    let finalTags: string[];

    if (existing.length > 0) {
      const items: vscode.QuickPickItem[] = [
        ...existing.map(t => ({ label: t, picked: current.includes(t) })),
        { label: '$(add) Nova tag...', description: 'Digitar nova(s) tag(s)' }
      ];
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true, placeHolder: 'Selecione as tags', title: 'Tags da sessão'
      });
      if (picked === undefined) { return; }
      finalTags = picked.filter(i => !i.label.startsWith('$(add)')).map(i => i.label);
      if (picked.some(i => i.label.startsWith('$(add)'))) {
        const extra = await vscode.window.showInputBox({
          prompt: 'Nova(s) tag(s) separadas por vírgula', placeHolder: 'ex: feature, v2'
        });
        if (extra) {
          finalTags = [...new Set([...finalTags, ...extra.split(',').map(t => t.trim()).filter(Boolean)])];
        }
      }
    } else {
      const input = await vscode.window.showInputBox({
        prompt: 'Tags (separadas por vírgula)',
        value: current.join(', '),
        placeHolder: 'ex: bug, auth, refactor'
      });
      if (input === undefined) { return; }
      finalTags = input.split(',').map(t => t.trim()).filter(Boolean);
    }

    const saved = this.storage.getById(session.id);
    if (!saved) { return; }
    saved.tags = finalTags;
    this.storage.write(saved);
    if (this.activeSession?.id === saved.id) { this.activeSession.tags = finalTags; }
    this._onDidChangeSession.fire();
  }

  async setSessionNotes(session: WorkSession): Promise<void> {
    const notes = await vscode.window.showInputBox({
      prompt: 'Nota da sessão (opcional)',
      value: session.notes ?? '',
      placeHolder: 'Contexto, decisões, próximos passos...'
    });
    if (notes === undefined) { return; }
    const saved = this.storage.getById(session.id);
    if (!saved) { return; }
    saved.notes = notes.trim() || undefined;
    this.storage.write(saved);
    if (this.activeSession?.id === saved.id) { this.activeSession.notes = saved.notes; }
    this._onDidChangeSession.fire();
  }

  async exportSessionsJson(): Promise<void> {
    const sessions = this.storage.list();
    const defaultName = `sessions-export-${new Date().toISOString().slice(0, 10)}.json`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(this.workspaceRoot, defaultName)),
      filters: { 'JSON': ['json'] },
      saveLabel: 'Exportar'
    });
    if (!uri) { return; }
    fs.writeFileSync(uri.fsPath, JSON.stringify(sessions, null, 2), 'utf-8');
    const action = await vscode.window.showInformationMessage(
      `${sessions.length} sessão(ões) exportadas`, 'Abrir'
    );
    if (action === 'Abrir') {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    }
  }

  async suggestStartForBranch(branchName: string): Promise<void> {
    const action = await vscode.window.showInformationMessage(
      `Branch "${branchName}" detectada. Iniciar sessão?`,
      'Iniciar', 'Não'
    );
    if (action === 'Iniciar') { await this.startSession(branchName); }
  }

  async renameSession(session: WorkSession): Promise<void> {
    const newName = await vscode.window.showInputBox({
      prompt: 'Novo nome da sessão', value: session.name,
      validateInput: v => v.trim() ? undefined : 'Nome não pode ser vazio'
    });
    if (!newName?.trim() || newName.trim() === session.name) { return; }
    const saved = this.storage.getById(session.id);
    if (!saved) { return; }
    saved.name = newName.trim();
    this.storage.write(saved);
    if (this.activeSession?.id === session.id) { this.activeSession.name = saved.name; }
    this._onDidChangeSession.fire();
  }

  async deleteSession(session: WorkSession): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Delete session "${session.name}"?`, 'Delete', 'Cancel'
    );
    if (confirm !== 'Delete') { return; }
    this.storage.delete(session);
    this._onDidChangeSession.fire();
    vscode.window.showInformationMessage(`Session "${session.name}" deleted`);
  }

  // ─── Prompt log ───────────────────────────────────────────────────────────

  async logPrompt(): Promise<void> {
    if (!this.activeSession) {
      vscode.window.showWarningMessage('Inicie uma sessão antes de registrar chats');
      return;
    }
    const selectedAgent = await this.resolveManualAgent();
    if (!selectedAgent) { return; }

    const clipboard = await vscode.env.clipboard.readText();
    const question  = await vscode.window.showInputBox({
      prompt: `Título do chat usado no ${selectedAgent.label}`,
      value: clipboard.slice(0, 500),
      placeHolder: 'Cole ou digite o título do chat...'
    });
    if (!question?.trim()) { return; }

    this.manualPrompts.push({
      agent: selectedAgent.agent, question: question.trim(),
      timestamp: new Date().toISOString()
    });
    this._onDidChangePrompts.fire();
    vscode.window.showInformationMessage(`Chat registrado para ${selectedAgent.label}`);
  }

  // ─── Crash draft ──────────────────────────────────────────────────────────

  async checkForCrashDraft(): Promise<void> {
    for (const draft of this.storage.readDrafts()) {
      const age = Math.round((Date.now() - new Date(draft.savedAt).getTime()) / 60000);
      const action = await vscode.window.showWarningMessage(
        `Sessão "${draft.name}" foi interrompida (${age}min atrás). Restaurar?`,
        'Restaurar', 'Descartar'
      );
      if (action === 'Restaurar') { await this.resumeSession(draft); }
      else { this.storage.deleteDraft(draft.id); }
    }
  }

  private writeCrashDraft(): void {
    if (!this.activeSession || !this.fileTracker) { return; }
    this.storage.writeDraft({
      ...this.activeSession,
      files: this.fileTracker.getTrackedFiles(),
      savedAt: new Date().toISOString()
    });
  }

  private clearCrashDraft(): void {
    if (this.crashDraftTimer) { clearInterval(this.crashDraftTimer); this.crashDraftTimer = null; }
    if (this.activeSession) { this.storage.deleteDraft(this.activeSession.id); }
  }

  private scheduleCrashDraft(): void {
    this.crashDraftTimer = setInterval(() => this.writeCrashDraft(), 5 * 60 * 1000);
  }

  // ─── Getters ──────────────────────────────────────────────────────────────

  getActiveSession(): WorkSession | null { return this.activeSession; }
  getFileTracker(): FileTracker | null   { return this.fileTracker; }
  getActiveAgent(): string               { return this.activeAgent; }
  isClaudeAvailable(): boolean           { return this.agentCapture.isClaudeAvailable(); }

  getElapsedMinutes(): number {
    return this.sessionStartTime
      ? Math.round((Date.now() - this.sessionStartTime.getTime()) / 60000)
      : 0;
  }

  getLivePrompts(): CapturedPrompt[] { return [...this.manualPrompts]; }

  getLiveAgentSessions(): AgentSession[] {
    return this.agentCapture.merge(
      this.activeSession?.agentSessions ?? [],
      this.agentCapture.buildManualSessions(this.manualPrompts)
    );
  }

  setActiveAgent(agent: string): void {
    this.activeAgent = agent;
    this._onDidChangeSession.fire();
  }

  listSessions(): WorkSession[]                    { return this.storage.list(); }
  getSessionById(id: string): WorkSession | undefined { return this.storage.getById(id); }

  getExistingTags(): string[] {
    const set = new Set<string>();
    for (const s of this.storage.list()) {
      for (const t of s.tags ?? []) { set.add(t); }
    }
    for (const t of this.activeSession?.tags ?? []) { set.add(t); }
    return Array.from(set).sort();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async restoreEditorState(editorState: EditorState): Promise<void> {
    for (const filePath of editorState.openTabs) {
      if (!fs.existsSync(filePath)) { continue; }
      try {
        const doc      = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        const isActive = filePath === editorState.activeFile;
        await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: !isActive });
        const cursor = editorState.cursorPositions[filePath];
        if (isActive && cursor) {
          const editor = vscode.window.activeTextEditor;
          if (editor?.document.uri.fsPath === filePath) {
            const pos = new vscode.Position(cursor.line, cursor.character);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          }
        }
      } catch { /* skip unreadable */ }
    }
  }

  private captureEditorState(): EditorState {
    const openTabs = vscode.window.tabGroups.all
      .flatMap(g => g.tabs).map(t => t.input)
      .filter((i): i is vscode.TabInputText => i instanceof vscode.TabInputText)
      .map(i => i.uri.fsPath);
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    const cursorPositions: Record<string, { line: number; character: number }> = {};
    for (const editor of vscode.window.visibleTextEditors) {
      cursorPositions[editor.document.uri.fsPath] = {
        line: editor.selection.active.line,
        character: editor.selection.active.character
      };
    }
    return { openTabs, activeFile, cursorPositions };
  }

  private buildAutoSummary(minutes: number, fileCount: number, chatCount: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const time = h > 0 ? `${h}h${m > 0 ? m + 'min' : ''}` : `${m}min`;
    const parts = [time, `${fileCount} arquivo(s)`];
    if (chatCount > 0) { parts.push(`${chatCount} chat(s)`); }
    return parts.join(' · ');
  }

  private async tryFetchTicketTitle(ticket: string): Promise<string | undefined> {
    const gh = ticket.match(/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)/);
    if (!gh) { return undefined; }
    const [, repo, type, num] = gh;
    const endpoint = type === 'pull' ? 'pulls' : 'issues';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/${endpoint}/${num}`, {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'vscode-session-saver' },
        signal: controller.signal
      });
      if (!res.ok) { return undefined; }
      const json = await res.json() as { title?: string };
      return json.title?.trim();
    } catch { return undefined; }
    finally { clearTimeout(timer); }
  }

  private scheduleReminder(): void {
    const minutes = vscode.workspace.getConfiguration('sessionSaver').get<number>('remindAfterMinutes', 60);
    if (minutes <= 0) { return; }
    this.remindTimer = setTimeout(() => {
      if (!this.activeSession) { return; }
      vscode.window.showWarningMessage(
        `Session "${this.activeSession.name}" está rodando há ${minutes} minutos. Salvar?`,
        'Salvar', 'Depois'
      ).then(a => { if (a === 'Salvar') { this.saveSession(); } });
    }, minutes * 60 * 1000);
  }

  private clearReminder(): void {
    if (this.remindTimer) { clearTimeout(this.remindTimer); this.remindTimer = null; }
  }

  private scheduleAutoSave(): void {
    const minutes = vscode.workspace.getConfiguration('sessionSaver').get<number>('autoSaveIntervalMinutes', 0);
    if (minutes <= 0) { return; }
    this.autoSaveTimer = setInterval(() => {
      if (this.activeSession) { this.saveSession(true); }
    }, minutes * 60 * 1000);
  }

  private clearAutoSave(): void {
    if (this.autoSaveTimer) { clearInterval(this.autoSaveTimer); this.autoSaveTimer = null; }
  }

  private async resolveManualAgent(): Promise<{ agent: CapturedPrompt['agent']; label: string } | undefined> {
    if (this.activeAgent === 'Anthropic.claude-code') { return { agent: 'claude', label: 'Claude Code' }; }
    if (this.activeAgent === 'GitHub.copilot-chat')   { return { agent: 'copilot', label: 'GitHub Copilot' }; }
    if (this.activeAgent === 'openai.chatgpt')         { return { agent: 'chatgpt', label: 'ChatGPT' }; }
    return vscode.window.showQuickPick([
      { label: 'GitHub Copilot', agent: 'copilot'  as const },
      { label: 'ChatGPT',        agent: 'chatgpt'  as const },
      { label: 'Claude Code',    agent: 'claude'   as const },
      { label: 'Outra IA / manual', agent: 'manual' as const }
    ], { placeHolder: 'Qual IA recebeu esse prompt?' });
  }

  dispose(): void {
    this.clearReminder();
    this.clearAutoSave();
    if (this.crashDraftTimer) { clearInterval(this.crashDraftTimer); this.crashDraftTimer = null; }
    this.fileTracker?.dispose();
    this._onDidChangeSession.dispose();
    this._onDidTrackFile.dispose();
    this._onDidChangePrompts.dispose();
  }
}
