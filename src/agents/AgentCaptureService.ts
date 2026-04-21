import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkSession, AgentSession, CapturedPrompt, AGENT_DISPLAY_NAMES } from '../types';
import { ClaudeCodeAdapter } from '../adapters/ClaudeCodeAdapter';
import { CopilotCliAdapter } from '../adapters/CopilotCliAdapter';
import { CodexAdapter } from '../adapters/CodexAdapter';
import { ClineAdapter } from '../adapters/ClineAdapter';

export class AgentCaptureService {
  private readonly claude: ClaudeCodeAdapter;
  private readonly copilot: CopilotCliAdapter;
  private readonly codex: CodexAdapter;
  private readonly cline: ClineAdapter;

  constructor(
    private readonly workspaceRoot: string,
    private readonly sessionsDir: string,
    clineHistoryRoot: string
  ) {
    this.claude  = new ClaudeCodeAdapter(workspaceRoot);
    this.copilot = new CopilotCliAdapter(workspaceRoot);
    this.codex   = new CodexAdapter(workspaceRoot);
    this.cline   = new ClineAdapter(workspaceRoot, clineHistoryRoot);
  }

  isClaudeAvailable(): boolean { return this.claude.isAvailable(); }

  captureAndArchive(
    since: Date,
    workSessionId: string,
    existing: AgentSession[],
    manualPrompts: CapturedPrompt[]
  ): AgentSession[] {
    const ext = (id: string) => vscode.extensions.getExtension(id) !== undefined;
    const sources: AgentSession[][] = [
      existing,
      ext('Anthropic.claude-code')   ? this.claude.captureAgentSessionsSince(since)  : [],
      ext('GitHub.copilot-chat')     ? this.copilot.captureAgentSessionsSince(since) : [],
      ext('openai.chatgpt')          ? this.codex.captureAgentSessionsSince(since)   : [],
      ext('saoudrizwan.claude-dev')  ? this.cline.captureAgentSessionsSince(since)   : [],
      this.buildManualSessions(manualPrompts),
    ];
    const captured = sources.reduce((acc, src) => this.merge(acc, src), [] as AgentSession[]);
    return this.archive(workSessionId, captured);
  }

  writeConversationFiles(session: WorkSession, agentSessions: AgentSession[]): AgentSession[] {
    return agentSessions.map(agentSession => {
      const messages = this.extractFullConversation(agentSession);
      if (messages.length === 0) { return agentSession; }

      const agentName = this.displayName(agentSession.agent);
      const lines: string[] = [
        `# ${agentSession.title}`,
        `_${agentName} · ${new Date(session.savedAt).toLocaleString('pt-BR')}_`,
        ''
      ];
      if (session.notes)       { lines.push(`> ${session.notes}`, ''); }
      if (session.tags?.length) { lines.push(`**Tags:** ${session.tags.join(', ')}`, ''); }

      for (const msg of messages) {
        lines.push(`**${msg.role === 'user' ? 'Você' : agentName}:** ${msg.text}`, '');
      }

      const conversationPath = this.conversationFilePath(session.id, agentSession);
      try {
        fs.writeFileSync(conversationPath, lines.join('\n'), 'utf-8');
        return { ...agentSession, conversationPath };
      } catch { return agentSession; }
    });
  }

  displayName(agent: string): string {
    return AGENT_DISPLAY_NAMES[agent] ?? agent;
  }

  merge(a: AgentSession[], b: AgentSession[]): AgentSession[] {
    const byKey = new Map<string, AgentSession>();
    for (const s of [...a, ...b]) {
      const key = `${s.agent}:${s.sessionId}`;
      const prev = byKey.get(key);
      byKey.set(key, prev ? {
        ...prev, ...s,
        title: s.title || prev.title,
        startedAt: this.earlier(prev.startedAt, s.startedAt),
        updatedAt: this.later(prev.updatedAt, s.updatedAt)
      } : { ...s });
    }
    return Array.from(byKey.values())
      .map(s => ({ s, t: new Date(s.updatedAt ?? '').getTime() }))
      .sort((x, y) => y.t - x.t)
      .map(({ s }) => s);
  }

  buildManualSessions(prompts: CapturedPrompt[]): AgentSession[] {
    return prompts.map(p => ({
      agent: p.agent,
      sessionId: `manual:${p.agent}:${p.timestamp}`,
      title: p.question.trim().length > 80 ? p.question.trim().slice(0, 77) + '...' : p.question.trim(),
      startedAt: p.timestamp,
      updatedAt: p.timestamp
    }));
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private archive(workSessionId: string, agentSessions: AgentSession[]): AgentSession[] {
    return agentSessions.map(s => {
      const archivePath = this.archiveOne(workSessionId, s);
      return archivePath ? { ...s, archivePath } : s;
    });
  }

  private archiveOne(workSessionId: string, agentSession: AgentSession): string | undefined {
    const sourcePath = this.archiveSource(agentSession);
    if (!sourcePath || !fs.existsSync(sourcePath)) { return agentSession.archivePath; }

    const archiveDir = path.join(this.sessionsDir, `${workSessionId}.assets`, 'agents');
    const safeId = this.safeFileName(`${agentSession.agent}-${agentSession.sessionId}`);
    const stat = fs.statSync(sourcePath);
    const dest = stat.isDirectory()
      ? path.join(archiveDir, safeId)
      : path.join(archiveDir, safeId, path.basename(sourcePath));

    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      stat.isDirectory()
        ? fs.cpSync(sourcePath, dest, { recursive: true, force: true })
        : fs.copyFileSync(sourcePath, dest);
      return dest;
    } catch { return agentSession.archivePath; }
  }

  private archiveSource(agentSession: AgentSession): string | undefined {
    if (!agentSession.sourcePath) { return undefined; }
    return agentSession.agent === 'copilot'
      ? path.dirname(agentSession.sourcePath)
      : agentSession.sourcePath;
  }

  private extractFullConversation(agentSession: AgentSession): { role: 'user' | 'assistant'; text: string }[] {
    const filePath = agentSession.archivePath ?? agentSession.sourcePath;
    if (!filePath) { return []; }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) { return []; }
      if (agentSession.agent === 'claude')  { return this.claude.extractFullConversation(filePath); }
      if (agentSession.agent === 'codex')   { return this.codex.extractFullConversation(filePath); }
      if (agentSession.agent === 'copilot') {
        return this.copilot.extractFullConversation(stat.isDirectory() ? filePath : path.dirname(filePath));
      }
    } catch { /* non-fatal */ }
    return [];
  }

  private conversationFilePath(workSessionId: string, agentSession: AgentSession): string {
    const shortId = agentSession.sessionId.replace(/[^a-z0-9]/gi, '').slice(0, 8);
    const dir = path.join(this.sessionsDir, `${workSessionId}.assets`, 'conversations');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${agentSession.agent}-${shortId}.md`);
  }

  private safeFileName(value: string): string {
    return value.replace(/[^a-z0-9._-]/gi, '_').slice(0, 120);
  }

  private earlier(a: string | undefined, b: string | undefined): string | undefined {
    if (!a) { return b; } if (!b) { return a; }
    return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
  }

  private later(a: string | undefined, b: string | undefined): string | undefined {
    if (!a) { return b; } if (!b) { return a; }
    return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
  }
}
