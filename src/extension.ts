import * as vscode from 'vscode';
import * as path from 'path';
import { SessionManager } from './SessionManager';
import {
  ActiveSessionProvider,
  AgentContextProvider,
  ChangedFilesProvider,
  ChangedFileItem,
  SavedSessionsProvider,
  SavedSessionItem
} from './ui/SessionTreeView';
import { SessionStatusBarItem } from './ui/StatusBarItem';
import { SessionDiffProvider, SESSION_DIFF_SCHEME } from './ui/SessionDiffProvider';
import { StatsPanel } from './ui/StatsPanel';
import { WorkSession } from './types';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const sessionManager = new SessionManager(context);

  type GitRepo = { state: { HEAD?: { commit?: string; ref?: string }; onDidChange: vscode.Event<void> } };
  type GitAPI  = { toGitUri(uri: vscode.Uri, ref: string): vscode.Uri; repositories: GitRepo[] };
  let gitApi: GitAPI | undefined;

  const gitExt = vscode.extensions.getExtension('vscode.git') as
    vscode.Extension<{ getAPI(v: 1): GitAPI }> | undefined;
  if (gitExt) {
    try {
      const git = gitExt.isActive ? gitExt.exports : await gitExt.activate();
      gitApi = git.getAPI(1);
      for (const repo of gitApi.repositories) {
        let lastBranch = repo.state.HEAD?.ref;
        context.subscriptions.push(
          repo.state.onDidChange(() => {
            const config = vscode.workspace.getConfiguration('sessionSaver');

            // Suggest starting session on branch change
            const currentBranch = repo.state.HEAD?.ref;
            if (currentBranch && currentBranch !== lastBranch) {
              lastBranch = currentBranch;
              if (!sessionManager.getActiveSession() && config.get<boolean>('suggestOnBranchChange', true)) {
                sessionManager.suggestStartForBranch(currentBranch);
              }
            }

            if (!config.get<boolean>('autoSaveOnCommit', false)) { return; }
            if (!sessionManager.getActiveSession()) { return; }
            const commit = repo.state.HEAD?.commit;
            if (commit && commit !== sessionManager.getLastKnownCommit()) {
              sessionManager.setLastKnownCommit(commit);
              sessionManager.saveSession(true);
            }
          })
        );
      }
    } catch { /* git unavailable */ }
  }

  const diffProvider = new SessionDiffProvider(sessionManager);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SESSION_DIFF_SCHEME, diffProvider)
  );

  const statusBar = new SessionStatusBarItem(sessionManager);

  const activeProvider = new ActiveSessionProvider(sessionManager);
  const agentProvider  = new AgentContextProvider(sessionManager);
  const filesProvider  = new ChangedFilesProvider(sessionManager);
  const savedProvider  = new SavedSessionsProvider(sessionManager);

  await vscode.commands.executeCommand('setContext', 'sessionSaver.hasActiveSession', false);

  // Check for interrupted sessions from a previous crash
  await sessionManager.checkForCrashDraft();

  // Suggest starting a session if already on a feature branch
  if (!sessionManager.getActiveSession() && gitApi) {
    const branch = gitApi.repositories[0]?.state.HEAD?.ref;
    const isFeatureBranch = branch && !['main', 'master', 'develop', 'dev'].includes(branch);
    const config = vscode.workspace.getConfiguration('sessionSaver');
    if (isFeatureBranch && config.get<boolean>('suggestOnBranchChange', true)) {
      sessionManager.suggestStartForBranch(branch);
    }
  }

  context.subscriptions.push(
    sessionManager,
    statusBar,
    vscode.window.registerTreeDataProvider('sessionSaver.activeSession', activeProvider),
    vscode.window.registerTreeDataProvider('sessionSaver.agentContext', agentProvider),
    vscode.window.registerTreeDataProvider('sessionSaver.changedFiles', filesProvider),
    vscode.window.registerTreeDataProvider('sessionSaver.savedSessions', savedProvider),

    vscode.commands.registerCommand('sessionSaver.startSession', () =>
      sessionManager.startSession()),

    vscode.commands.registerCommand('sessionSaver.saveSession', () =>
      sessionManager.saveSession()),

    vscode.commands.registerCommand('sessionSaver.stopSession', () =>
      sessionManager.stopSession()),

    vscode.commands.registerCommand('sessionSaver.resumeSession', (item?: SavedSessionItem) => {
      if (!item?.session) {
        vscode.window.showWarningMessage('Selecione uma sessão na sidebar para retomar');
        return;
      }
      sessionManager.resumeSession(item.session);
    }),

    vscode.commands.registerCommand('sessionSaver.deleteSession', (item?: SavedSessionItem) => {
      if (!item?.session) {
        vscode.window.showWarningMessage('Selecione uma sessão na sidebar para deletar');
        return;
      }
      sessionManager.deleteSession(item.session);
    }),

    vscode.commands.registerCommand('sessionSaver.renameSession', (item?: SavedSessionItem) => {
      if (!item?.session) {
        vscode.window.showWarningMessage('Selecione uma sessão na sidebar para renomear');
        return;
      }
      sessionManager.renameSession(item.session);
    }),

    vscode.commands.registerCommand('sessionSaver.togglePinSession', (item?: SavedSessionItem) => {
      if (!item?.session) { return; }
      sessionManager.togglePinSession(item.session);
    }),

    vscode.commands.registerCommand('sessionSaver.setSessionTicket', (item?: SavedSessionItem) => {
      if (!item?.session) { return; }
      sessionManager.setSessionTicket(item.session);
    }),

    vscode.commands.registerCommand('sessionSaver.openTicket', async (item?: SavedSessionItem) => {
      const ticket = item?.session?.ticket;
      if (!ticket) { return; }
      const isUrl = ticket.startsWith('http://') || ticket.startsWith('https://');
      if (isUrl) {
        await vscode.env.openExternal(vscode.Uri.parse(ticket));
      } else {
        await vscode.env.clipboard.writeText(ticket);
        vscode.window.showInformationMessage(`Ticket copiado: ${ticket}`);
      }
    }),

    vscode.commands.registerCommand('sessionSaver.copyTicket', async (item?: SavedSessionItem) => {
      const ticket = item?.session?.ticket;
      if (!ticket) { return; }
      await vscode.env.clipboard.writeText(ticket);
      vscode.window.showInformationMessage(`Ticket copiado: ${ticket}`);
    }),

    vscode.commands.registerCommand('sessionSaver.setAgent', (agentId: string) =>
      sessionManager.setActiveAgent(agentId)),

    vscode.commands.registerCommand('sessionSaver.logPrompt', () =>
      sessionManager.logPrompt()),

    vscode.commands.registerCommand('sessionSaver.openConversation', async (filePath?: string) => {
      if (!filePath) { return; }
      const fs = await import('fs');
      if (!fs.existsSync(filePath)) {
        vscode.window.showWarningMessage('Arquivo de conversa não encontrado. Salve a sessão novamente para gerar.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('sessionSaver.filterSessions', async () => {
      const text = await vscode.window.showInputBox({
        prompt: 'Filtrar sessões salvas',
        placeHolder: 'Nome, tag, nota, branch...',
        value: ''
      });
      if (text === undefined) { return; }
      savedProvider.setFilter(text);
    }),

    vscode.commands.registerCommand('sessionSaver.clearSessionFilter', () => {
      savedProvider.clearFilter();
    }),

    vscode.commands.registerCommand('sessionSaver.toggleWorkspaceFilter', () => {
      savedProvider.toggleWorkspaceFilter();
      const label = savedProvider.isWorkspaceOnly ? 'Mostrando só este workspace' : 'Mostrando todos os workspaces';
      vscode.window.showInformationMessage(label);
    }),

    vscode.commands.registerCommand('sessionSaver.openChangedFileDiff',
      (item: ChangedFileItem) => {
        if (!item?.file) { return; }
        vscode.commands.executeCommand(
          'sessionSaver.openFileDiff', item.file.path, item.file.changeType
        );
      }
    ),

    vscode.commands.registerCommand('sessionSaver.openFileDiff',
      async (filePath: string, changeType: 'modified' | 'added' | 'deleted') => {
        const uri = vscode.Uri.file(filePath);
        const filename = path.basename(filePath);

        if (changeType === 'added') {
          await vscode.commands.executeCommand('vscode.open', uri);
          return;
        }

        if (!gitApi) {
          await vscode.commands.executeCommand('vscode.open', uri);
          return;
        }

        try {
          const headUri = gitApi.toGitUri(uri, 'HEAD');
          if (changeType === 'deleted') {
            const doc = await vscode.workspace.openTextDocument(headUri);
            await vscode.window.showTextDocument(doc, { preview: true });
          } else {
            await vscode.commands.executeCommand(
              'vscode.diff', headUri, uri,
              `${filename}  (HEAD ↔ Working Tree)`
            );
          }
        } catch {
          await vscode.commands.executeCommand('vscode.open', uri);
        }
      }
    ),

    vscode.commands.registerCommand('sessionSaver.openSessionDiff',
      async (item?: SavedSessionItem) => {
        const session: WorkSession | undefined = item?.session;
        if (!session) {
          vscode.window.showWarningMessage('Selecione uma sessão para ver o diff');
          return;
        }
        if (!session.git?.diff) {
          vscode.window.showInformationMessage('Nenhum diff salvo para esta sessão');
          return;
        }
        const uri = diffProvider.buildUri(session.id);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(
          await vscode.languages.setTextDocumentLanguage(doc, 'diff'),
          { preview: false }
        );
      }
    ),

    vscode.commands.registerCommand('sessionSaver.setSessionTags', (item?: SavedSessionItem) => {
      if (!item?.session) { return; }
      sessionManager.setSessionTags(item.session);
    }),

    vscode.commands.registerCommand('sessionSaver.setSessionNotes', (item?: SavedSessionItem) => {
      if (!item?.session) { return; }
      sessionManager.setSessionNotes(item.session);
    }),

    vscode.commands.registerCommand('sessionSaver.exportSessions', () => {
      sessionManager.exportSessionsJson();
    }),

    vscode.commands.registerCommand('sessionSaver.showStats', () => {
      StatsPanel.show(context, sessionManager.listSessions());
    }),

    vscode.commands.registerCommand('sessionSaver.filterByDate', async () => {
      const options = [
        { label: '$(calendar) Hoje',        description: 'Sessões de hoje',          range: 'today'  as const },
        { label: '$(calendar) Esta semana', description: 'Últimos 7 dias',           range: 'week'   as const },
        { label: '$(calendar) Este mês',    description: 'Últimos 30 dias',          range: 'month'  as const },
        { label: '$(clear-all) Sem filtro', description: 'Mostrar todas as sessões', range: 'all'    as const },
      ];
      const pick = await vscode.window.showQuickPick(options, { placeHolder: 'Filtrar sessões por período' });
      if (!pick) { return; }
      savedProvider.setDateFilter(pick.range);
    }),

    vscode.commands.registerCommand('sessionSaver.toggleGroupByTicket', () => {
      savedProvider.toggleGroupByTicket();
      vscode.window.showInformationMessage(
        savedProvider.isGroupByTicket ? 'Agrupando por ticket' : 'Agrupando por data'
      );
    })
  );
}

export function deactivate(): void {}
