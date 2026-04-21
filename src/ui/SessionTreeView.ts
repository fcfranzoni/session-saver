import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TrackedFile, WorkSession, AgentSession, AGENT_DISPLAY_NAMES } from '../types';
import { SessionManager } from '../SessionManager';

// ─── Active Session ───────────────────────────────────────────────────────────

export class ActiveSessionProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly sessionManager: SessionManager) {
    sessionManager.onDidChangeSession(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  getChildren(): vscode.TreeItem[] {
    const session = this.sessionManager.getActiveSession();
    if (!session) {
      const item = new vscode.TreeItem('Nenhuma sessão ativa');
      item.description = 'Use $(add) para iniciar';
      return [item];
    }

    const elapsed = this.sessionManager.getElapsedMinutes();
    const h = Math.floor(elapsed / 60);
    const m = elapsed % 60;
    const timeStr = h > 0 ? `${h}h${m > 0 ? m + 'm' : ''}` : `${m}m`;

    const nameItem = new vscode.TreeItem(session.name);
    nameItem.iconPath = new vscode.ThemeIcon('circle-filled');
    nameItem.description = timeStr;
    return [nameItem];
  }
}

// ─── Agent Context ────────────────────────────────────────────────────────────

interface KnownAgent {
  id: string;
  label: string;
  icon: string;
  autoCapture: boolean;
}

const KNOWN_AGENTS: KnownAgent[] = [
  { id: 'Anthropic.claude-code', label: 'Claude Code',    icon: 'robot',   autoCapture: true },
  { id: 'GitHub.copilot-chat',   label: 'GitHub Copilot', icon: 'github',  autoCapture: false },
  { id: 'openai.chatgpt',        label: 'Codex / ChatGPT', icon: 'sparkle', autoCapture: true },
  { id: 'saoudrizwan.claude-dev', label: 'Cline',          icon: 'terminal', autoCapture: true },
];

class AgentGroupItem extends vscode.TreeItem {
  constructor(
    public readonly agentId: string,
    label: string,
    icon: string,
    sessionCount: number,
    isActive: boolean,
    autoCapture: boolean
  ) {
    super(label, sessionCount > 0
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.iconPath = new vscode.ThemeIcon(isActive ? 'check' : icon);
    this.description = isActive
      ? `ativo · ${sessionCount} chat(s)`
      : `${sessionCount} chat(s)`;
    this.tooltip = autoCapture
      ? 'Captura automática ao salvar sessão'
      : 'Use Ctrl+Alt+L para registrar chats';
    this.command = {
      command: 'sessionSaver.setAgent',
      title: 'Definir como agente ativo',
      arguments: [agentId]
    };
    this.contextValue = 'agentGroup';
  }
}

class AgentSessionItem extends vscode.TreeItem {
  constructor(public readonly agentSession: AgentSession) {
    super(agentSession.title, vscode.TreeItemCollapsibleState.None);
    const isManual = agentSession.sessionId.startsWith('manual:');
    this.tooltip = [
      agentSession.title,
      agentSession.updatedAt ? new Date(agentSession.updatedAt).toLocaleString('pt-BR') : undefined
    ].filter(Boolean).join('\n');
    this.description = isManual ? 'manual' : undefined;
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.contextValue = isManual ? 'manualAgentSession' : 'agentSession';

    if (agentSession.conversationPath) {
      this.command = {
        command: 'sessionSaver.openConversation',
        title: 'Abrir conversa',
        arguments: [agentSession.conversationPath]
      };
    }
  }
}

class LogPromptActionItem extends vscode.TreeItem {
  constructor() {
    super('Registrar chat', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('add');
    this.description = 'Ctrl+Alt+L';
    this.command = {
      command: 'sessionSaver.logPrompt',
      title: 'Registrar chat'
    };
  }
}

type AgentTreeItem = AgentGroupItem | AgentSessionItem | LogPromptActionItem;

export class AgentContextProvider implements vscode.TreeDataProvider<AgentTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cached set of installed extension IDs — updated only on extension change events */
  private installedExtIds: Set<string>;

  constructor(private readonly sessionManager: SessionManager) {
    this.installedExtIds = this.buildInstalledSet();
    sessionManager.onDidChangeSession(() => this._onDidChangeTreeData.fire());
    sessionManager.onDidChangePrompts(() => this._onDidChangeTreeData.fire());
    vscode.extensions.onDidChange(() => {
      this.installedExtIds = this.buildInstalledSet();
      this._onDidChangeTreeData.fire();
    });
  }

  private buildInstalledSet(): Set<string> {
    return new Set(KNOWN_AGENTS.map(a => a.id).filter(id => vscode.extensions.getExtension(id) !== undefined));
  }

  getTreeItem(element: AgentTreeItem): vscode.TreeItem { return element; }

  getChildren(element?: AgentTreeItem): AgentTreeItem[] {
    if (element instanceof AgentGroupItem) {
      return this.sessionsForAgent(element.agentId);
    }
    if (element) { return []; }

    return this.buildRootItems();
  }

  private buildRootItems(): AgentTreeItem[] {
    const activeAgent  = this.sessionManager.getActiveAgent();
    const liveSessions = this.sessionManager.getLiveAgentSessions();
    const hasSession   = this.sessionManager.getActiveSession() !== null;

    const items: AgentTreeItem[] = [];

    for (const agent of KNOWN_AGENTS) {
      if (!this.installedExtIds.has(agent.id)) { continue; }

      const agentKeys  = this.agentKeys(agent.id);
      const count      = liveSessions.filter(s => agentKeys.includes(s.agent)).length;
      const isActive   = activeAgent === agent.id;

      items.push(new AgentGroupItem(
        agent.id, agent.label, agent.icon,
        count, isActive, agent.autoCapture
      ));
    }

    if (items.length === 0) {
      const none = new vscode.TreeItem('Nenhuma IA detectada') as AgentTreeItem;
      (none as vscode.TreeItem).iconPath = new vscode.ThemeIcon('info');
      items.push(none);
    }

    // Show "Log prompt" action only during an active session
    if (hasSession) {
      items.push(new LogPromptActionItem());
    }

    return items;
  }

  private sessionsForAgent(agentId: string): AgentTreeItem[] {
    const agentKey = this.agentKey(agentId);
    const agentKeys = this.agentKeys(agentId);
    const sessions  = this.sessionManager.getLiveAgentSessions()
      .filter(s => agentKeys.includes(s.agent));

    if (sessions.length === 0) {
      const empty = new vscode.TreeItem('Nenhum chat registrado') as AgentTreeItem;
      (empty as vscode.TreeItem).iconPath = new vscode.ThemeIcon('dash');
      return [empty];
    }

    return sessions
      .sort((a, b) => Number(a.sessionId.startsWith('manual:')) - Number(b.sessionId.startsWith('manual:')))
      .map(s => new AgentSessionItem(s));
  }

  private agentKey(agentId: string): AgentSession['agent'] {
    if (agentId === 'Anthropic.claude-code')  { return 'claude'; }
    if (agentId === 'GitHub.copilot-chat')    { return 'copilot'; }
    if (agentId === 'openai.chatgpt')          { return 'codex'; }
    if (agentId === 'saoudrizwan.claude-dev') { return 'cline'; }
    return 'manual';
  }

  private agentKeys(agentId: string): AgentSession['agent'][] {
    if (agentId === 'openai.chatgpt') { return ['codex', 'chatgpt']; }
    return [this.agentKey(agentId)];
  }
}

// ─── Changed Files ────────────────────────────────────────────────────────────

export class ChangedFileItem extends vscode.TreeItem {
  constructor(public readonly file: TrackedFile) {
    super(path.basename(file.relativePath), vscode.TreeItemCollapsibleState.None);
    this.description = path.dirname(file.relativePath);
    this.tooltip = file.relativePath;

    const iconMap: Record<TrackedFile['changeType'], string> = {
      modified: 'edit', added: 'add', deleted: 'trash'
    };
    this.iconPath = new vscode.ThemeIcon(iconMap[file.changeType]);
    this.contextValue = `changedFile_${file.changeType}`;

    // Default click: open the file (FileTracker already guarantees it exists when not deleted)
    if (file.changeType !== 'deleted') {
      this.command = {
        command: 'vscode.open',
        title: 'Abrir arquivo',
        arguments: [vscode.Uri.file(file.path)]
      };
    }
  }
}

export class ChangedFilesProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly sessionManager: SessionManager) {
    sessionManager.onDidChangeSession(() => this._onDidChangeTreeData.fire());
    sessionManager.onDidTrackFile(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  getChildren(): vscode.TreeItem[] {
    const tracker = this.sessionManager.getFileTracker();
    if (!tracker) {
      const item = new vscode.TreeItem('Nenhuma sessão ativa');
      return [item];
    }

    const files = tracker.getTrackedFiles();
    if (files.length === 0) {
      const item = new vscode.TreeItem('Nenhum arquivo alterado ainda');
      item.iconPath = new vscode.ThemeIcon('info');
      return [item];
    }

    return files.map(f => new ChangedFileItem(f));
  }

}

// ─── Saved Sessions ───────────────────────────────────────────────────────────

export class SavedSessionItem extends vscode.TreeItem {
  constructor(public readonly session: WorkSession) {
    const hasAgents = session.agentSessions?.some(a => a.conversationPath) ?? false;
    super(session.name, hasAgents
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None
    );
    const tags = session.tags?.length ? ` [${session.tags.join(', ')}]` : '';
    const ticketSuffix = session.ticket ? ` · ${this.shortTicket(session.ticket)}` : '';
    this.description = session.summary.auto + tags + ticketSuffix;

    const tooltipLines = [
      session.pinned ? `$(pinned) ${session.name}` : session.name,
      new Date(session.savedAt).toLocaleString('pt-BR')
    ];
    if (session.ticket) {
      const isUrl = session.ticket.startsWith('http://') || session.ticket.startsWith('https://');
      const ticketLink = isUrl
        ? `[🎫 ${this.shortTicket(session.ticket)}](${session.ticket})`
        : `🎫 ${session.ticket}`;
      tooltipLines.push('', ticketLink);
    }
    if (session.notes)  { tooltipLines.push('', session.notes); }
    const md = new vscode.MarkdownString(tooltipLines.join('\n\n'));
    md.isTrusted = true;
    this.tooltip = md;

    this.iconPath = new vscode.ThemeIcon(session.pinned ? 'pinned' : 'save');
    this.contextValue = session.ticket ? 'savedSessionWithTicket' : 'savedSession';
  }

  private shortTicket(ticket: string): string {
    try {
      const url = new URL(ticket);
      const parts = url.pathname.split('/').filter(Boolean);
      return parts[parts.length - 1] ?? url.hostname;
    } catch {
      return ticket.length > 20 ? ticket.slice(0, 20) + '…' : ticket;
    }
  }
}

class AgentGroupInSavedItem extends vscode.TreeItem {
  constructor(
    public readonly agentLabel: string,
    public readonly agentSessions: AgentSession[]
  ) {
    super(agentLabel, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
  }
}

class ConversationFileItem extends vscode.TreeItem {
  constructor(title: string, filePath: string) {
    super(title, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.tooltip = filePath;
    this.command = {
      command: 'sessionSaver.openConversation',
      title: 'Abrir conversa',
      arguments: [filePath]
    };
  }
}

export class SavedSessionGroupItem extends vscode.TreeItem {
  constructor(public readonly groupLabel: string) {
    super(groupLabel, vscode.TreeItemCollapsibleState.Expanded);
  }
}

type SessionTreeItem = SavedSessionItem | SavedSessionGroupItem | AgentGroupInSavedItem | ConversationFileItem;

export class SavedSessionsProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private filterText = '';
  private workspaceOnly = false;
  private groupMode: 'date' | 'ticket' = 'date';
  private dateFilter: 'all' | 'today' | 'week' | 'month' = 'all';

  constructor(private readonly sessionManager: SessionManager) {
    sessionManager.onDidChangeSession(() => this._onDidChangeTreeData.fire());
  }

  setFilter(text: string): void {
    this.filterText = text.toLowerCase().trim();
    this._onDidChangeTreeData.fire();
  }

  clearFilter(): void {
    this.filterText = '';
    this._onDidChangeTreeData.fire();
  }

  toggleWorkspaceFilter(): void {
    this.workspaceOnly = !this.workspaceOnly;
    this._onDidChangeTreeData.fire();
  }

  get isWorkspaceOnly(): boolean { return this.workspaceOnly; }

  toggleGroupByTicket(): void {
    this.groupMode = this.groupMode === 'ticket' ? 'date' : 'ticket';
    this._onDidChangeTreeData.fire();
  }

  get isGroupByTicket(): boolean { return this.groupMode === 'ticket'; }

  setDateFilter(range: 'all' | 'today' | 'week' | 'month'): void {
    this.dateFilter = range;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem { return element; }

  getChildren(element?: SessionTreeItem): SessionTreeItem[] {
    if (element instanceof SavedSessionItem)      { return this.getAgentGroups(element.session); }
    if (element instanceof AgentGroupInSavedItem) { return this.getConversationItems(element.agentSessions); }
    if (element instanceof SavedSessionGroupItem) { return this.getSessionsForGroup(element.groupLabel); }

    const sessions = this.filteredSessions();
    if (sessions.length === 0) {
      const empty = new vscode.TreeItem((this.filterText || this.dateFilter !== 'all') ? 'Nenhuma sessão encontrada' : 'Nenhuma sessão salva') as SessionTreeItem;
      (empty as vscode.TreeItem).iconPath = new vscode.ThemeIcon('info');
      return [empty];
    }
    return this.filterText ? sessions.map(s => new SavedSessionItem(s)) : this.buildGroups(sessions);
  }

  private getAgentGroups(session: WorkSession): AgentGroupInSavedItem[] {
    const byAgent = new Map<string, AgentSession[]>();
    for (const a of session.agentSessions ?? []) {
      if (!a.conversationPath || !fs.existsSync(a.conversationPath)) { continue; }
      const list = byAgent.get(a.agent) ?? [];
      list.push(a);
      byAgent.set(a.agent, list);
    }
    return Array.from(byAgent.entries()).map(([agent, sessions]) =>
      new AgentGroupInSavedItem(this.agentLabel(agent), sessions)
    );
  }

  private getConversationItems(agentSessions: AgentSession[]): ConversationFileItem[] {
    return agentSessions
      .filter(a => a.conversationPath && fs.existsSync(a.conversationPath))
      .map(a => new ConversationFileItem(a.title, a.conversationPath!));
  }

  private agentLabel(agent: string): string {
    return AGENT_DISPLAY_NAMES[agent] ?? agent;
  }

  private filteredSessions(): WorkSession[] {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let all = this.sessionManager.listSessions();

    if (this.workspaceOnly && workspaceRoot) {
      all = all.filter(s => s.workspaceFolder === workspaceRoot);
    }

    if (this.dateFilter !== 'all') {
      const cutoff = new Date();
      if      (this.dateFilter === 'today') { cutoff.setHours(0, 0, 0, 0); }
      else if (this.dateFilter === 'week')  { cutoff.setDate(cutoff.getDate() - 7); }
      else if (this.dateFilter === 'month') { cutoff.setMonth(cutoff.getMonth() - 1); }
      all = all.filter(s => s.savedAt >= cutoff.toISOString());
    }

    if (!this.filterText) { return all; }
    return all.filter(s => {
      const haystack = [
        s.name,
        s.notes ?? '',
        s.tags?.join(' ') ?? '',
        s.ticket ?? '',
        s.summary.auto,
        s.summary.ai ?? '',
        s.git?.branch ?? '',
        s.git?.commitMessage ?? ''
      ].join(' ').toLowerCase();
      return haystack.includes(this.filterText);
    });
  }

  private buildGroups(sessions: WorkSession[]): SavedSessionGroupItem[] {
    if (this.groupMode === 'ticket') {
      const labels = [...new Set(sessions.map(s => this.ticketGroupLabel(s)))];
      return labels.map(l => new SavedSessionGroupItem(l));
    }
    const groups: SavedSessionGroupItem[] = [];
    const seen = new Set<string>();

    if (sessions.some(s => s.pinned)) {
      groups.push(new SavedSessionGroupItem('📌 Fixadas'));
      seen.add('📌 Fixadas');
    }

    for (const s of sessions) {
      if (s.pinned) { continue; }
      const label = this.groupLabel(new Date(s.savedAt));
      if (!seen.has(label)) { seen.add(label); groups.push(new SavedSessionGroupItem(label)); }
    }
    return groups;
  }

  private ticketGroupLabel(session: WorkSession): string {
    if (!session.ticket) { return '📋 Sem ticket'; }
    if (session.ticketTitle) {
      const t = session.ticketTitle;
      return `🎫 ${t.length > 45 ? t.slice(0, 45) + '…' : t}`;
    }
    try {
      const url = new URL(session.ticket);
      const parts = url.pathname.split('/').filter(Boolean);
      return `🎫 ${parts[parts.length - 1] ?? url.hostname}`;
    } catch {
      const s = session.ticket;
      return `🎫 ${s.length > 30 ? s.slice(0, 30) + '…' : s}`;
    }
  }

  private getSessionsForGroup(label: string): SavedSessionItem[] {
    if (this.groupMode === 'ticket') {
      return this.filteredSessions()
        .filter(s => this.ticketGroupLabel(s) === label)
        .map(s => new SavedSessionItem(s));
    }
    const all = this.sessionManager.listSessions();
    if (label === '📌 Fixadas') {
      return all.filter(s => s.pinned).map(s => new SavedSessionItem(s));
    }
    return all
      .filter(s => !s.pinned && this.groupLabel(new Date(s.savedAt)) === label)
      .map(s => new SavedSessionItem(s));
  }

  private groupLabel(date: Date): string {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    if (d.getTime() === today.getTime())     { return 'Hoje'; }
    if (d.getTime() === yesterday.getTime()) { return 'Ontem'; }
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  }
}
