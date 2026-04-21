import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentSession, CapturedPrompt } from '../types';

// System-injected context prefixes to ignore
const SYSTEM_PREFIXES = ['<ide_opened_file>', '<system-reminder>', '<command-name>', '<ide_'];

interface ClaudeRawMessage {
  type: string;
  timestamp?: string;
  sessionId?: string;
  aiTitle?: string;
  message?: {
    role: string;
    content: Array<{
      type: string;
      text?: string;
      tool_use_id?: string;
    }>;
  };
}

export class ClaudeCodeAdapter {
  constructor(
    private readonly workspaceRoot: string,
    private readonly projectsRoot = path.join(os.homedir(), '.claude', 'projects')
  ) {}

  private resolveProjectDir(): string | null {
    // Claude encodes the workspace path replacing / with -
    const encoded = this.workspaceRoot.replace(/\//g, '-');
    const dir = path.join(this.projectsRoot, encoded);
    return fs.existsSync(dir) ? dir : null;
  }

  isAvailable(): boolean {
    return this.resolveProjectDir() !== null;
  }

  /** Returns JSONL files in the Claude project dir modified at or after `since`. */
  private recentJsonlFiles(projectDir: string, since: Date): string[] {
    try {
      return fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))
        .map(f => path.join(projectDir, f))
        .filter(f => { try { return fs.statSync(f).mtime >= since; } catch { return false; } });
    } catch {
      return [];
    }
  }

  capturePromptsSince(since: Date): CapturedPrompt[] {
    const projectDir = this.resolveProjectDir();
    if (!projectDir) { return []; }

    const prompts: CapturedPrompt[] = [];
    for (const file of this.recentJsonlFiles(projectDir, since)) {
      prompts.push(...this.parseSessionPrompts(file, since));
    }

    return prompts.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  captureAgentSessionsSince(since: Date): AgentSession[] {
    const projectDir = this.resolveProjectDir();
    if (!projectDir) { return []; }

    const sessions: AgentSession[] = [];
    for (const file of this.recentJsonlFiles(projectDir, since)) {
      const session = this.parseSessionFile(file, since);
      if (session) { sessions.push(session); }
    }

    return sessions.sort(
      (a, b) => new Date(a.updatedAt ?? '').getTime() - new Date(b.updatedAt ?? '').getTime()
    );
  }

  extractFullConversation(filePath: string): { role: 'user' | 'assistant'; text: string }[] {
    if (!fs.existsSync(filePath)) { return []; }

    let rawLines: string[];
    try {
      rawLines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
    } catch {
      return [];
    }

    const messages: { role: 'user' | 'assistant'; text: string }[] = [];

    for (const line of rawLines) {
      if (!line.trim()) { continue; }
      let msg: ClaudeRawMessage;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.type === 'user') {
        const content = msg.message?.content ?? [];
        const text = content
          .filter(c => c.type === 'text' && c.text && !c.tool_use_id)
          .map(c => c.text!)
          .filter(t => !SYSTEM_PREFIXES.some(prefix => t.trimStart().startsWith(prefix)))
          .join('\n\n')
          .trim();
        if (text && text.length >= 5) {
          messages.push({ role: 'user', text });
        }
      }

      if (msg.type === 'assistant') {
        const content = msg.message?.content ?? [];
        const text = content
          .filter(c => c.type === 'text' && c.text)
          .map(c => c.text!)
          .join('\n\n')
          .trim();
        if (text && text.length >= 5) {
          messages.push({ role: 'assistant', text });
        }
      }
    }

    return messages;
  }

  private parseSessionFile(file: string, since: Date): AgentSession | null {
    const sessionIdFromFile = path.basename(file, '.jsonl');
    let title = '';
    let sessionId = sessionIdFromFile;
    let startedAt: string | undefined;
    let updatedAt: string | undefined;

    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) { continue; }

      let msg: ClaudeRawMessage;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.sessionId) { sessionId = msg.sessionId; }
      if (msg.type === 'ai-title' && msg.aiTitle?.trim()) {
        title = msg.aiTitle.trim();
      }
      if (msg.timestamp) {
        startedAt = this.earlier(startedAt, msg.timestamp);
        updatedAt = this.later(updatedAt, msg.timestamp);
      }

      if (msg.type === 'user' && msg.timestamp) {
        updatedAt = this.later(updatedAt, msg.timestamp);
      }
    }

    if (!updatedAt || new Date(updatedAt) < since) {
      return null;
    }

    return {
      agent: 'claude',
      sessionId,
      title: title || this.fallbackTitle(sessionId),
      sourcePath: file,
      startedAt,
      updatedAt
    };
  }

  private parseSessionPrompts(file: string, since: Date): CapturedPrompt[] {
    const prompts: CapturedPrompt[] = [];
    const lines = fs.readFileSync(file, 'utf-8').split('\n');

    for (const [index, line] of lines.entries()) {
      if (!line.trim()) { continue; }
      const prompt = this.parseLine(line, since, file, index + 1);
      if (prompt) { prompts.push(prompt); }
    }

    return prompts;
  }

  private parseLine(line: string, since: Date, sourcePath: string, sourceLine: number): CapturedPrompt | null {
    let msg: ClaudeRawMessage;
    try { msg = JSON.parse(line); } catch { return null; }

    return this.parsePromptMessage(msg, since, sourcePath, sourceLine);
  }

  private parsePromptMessage(
    msg: ClaudeRawMessage,
    since: Date,
    sourcePath: string,
    sourceLine: number
  ): CapturedPrompt | null {
    if (msg.type !== 'user') { return null; }
    if (!msg.timestamp || new Date(msg.timestamp) < since) { return null; }

    const content = msg.message?.content ?? [];

    // Extract only real user text — skip tool_results and system context
    const question = content
      .filter(c => c.type === 'text' && c.text && !c.tool_use_id)
      .map(c => c.text!)
      .filter(t => !SYSTEM_PREFIXES.some(prefix => t.trimStart().startsWith(prefix)))
      .join(' ')
      .trim();

    if (!question || question.length < 5) { return null; }

    return {
      agent: 'claude',
      question: question.slice(0, 500),
      timestamp: msg.timestamp,
      sourceSessionId: msg.sessionId ?? path.basename(sourcePath, '.jsonl'),
      sourcePath,
      sourceLine
    };
  }

  private earlier(current: string | undefined, next: string): string {
    if (!current) { return next; }
    return new Date(next).getTime() < new Date(current).getTime() ? next : current;
  }

  private later(current: string | undefined, next: string): string {
    if (!current) { return next; }
    return new Date(next).getTime() > new Date(current).getTime() ? next : current;
  }

  private fallbackTitle(sessionId: string): string {
    return `Claude session ${sessionId.slice(0, 8)}`;
  }
}
