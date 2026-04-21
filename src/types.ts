export interface WorkSession {
  id: string;
  name: string;
  createdAt: string;
  savedAt: string;
  durationMinutes: number;
  workspaceFolder: string;
  files: TrackedFile[];
  editorState: EditorState;
  agentSessions?: AgentSession[];
  prompts?: CapturedPrompt[];
  git?: GitState;
  summary: {
    auto: string;
    ai?: string;
  };
  tags: string[];
  notes?: string;
  pinned?: boolean;
  ticket?: string;
  ticketTitle?: string;
}

export interface TrackedFile {
  path: string;
  relativePath: string;
  changeType: 'modified' | 'added' | 'deleted';
  openedAt: string;
  savedAt?: string;
}

export interface EditorState {
  openTabs: string[];
  activeFile?: string;
  cursorPositions: Record<string, { line: number; character: number }>;
}

export interface GitState {
  branch: string;
  commitHash: string;
  commitMessage: string;
  diff: string;
}

export interface CapturedPrompt {
  agent: 'claude' | 'copilot' | 'chatgpt' | 'manual';
  question: string;
  timestamp: string;
  sourceSessionId?: string;
  sourcePath?: string;
  sourceLine?: number;
}

export interface AgentSession {
  agent: 'claude' | 'copilot' | 'chatgpt' | 'codex' | 'cline' | 'manual';
  sessionId: string;
  title: string;
  sourcePath?: string;
  archivePath?: string;
  conversationPath?: string;
  startedAt?: string;
  updatedAt?: string;
}

export const AGENT_DISPLAY_NAMES: Record<string, string> = {
  claude:  'Claude Code',
  copilot: 'GitHub Copilot',
  chatgpt: 'ChatGPT',
  codex:   'Codex',
  cline:   'Cline',
  manual:  'IA (manual)',
};
