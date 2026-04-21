import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentSession } from '../types';

interface CopilotWorkspaceYaml {
  id?: string;
  cwd?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
}

export class CopilotCliAdapter {
  constructor(
    private readonly workspaceRoot: string,
    private readonly sessionsRoot = path.join(os.homedir(), '.copilot', 'session-state')
  ) {}

  isAvailable(): boolean {
    return fs.existsSync(this.sessionsRoot);
  }

  captureAgentSessionsSince(since: Date): AgentSession[] {
    if (!this.isAvailable()) { return []; }

    const sessions: AgentSession[] = [];

    try {
      for (const sessionId of fs.readdirSync(this.sessionsRoot)) {
        const sessionDir = path.join(this.sessionsRoot, sessionId);
        const workspaceFile = path.join(sessionDir, 'workspace.yaml');
        if (!fs.existsSync(workspaceFile)) { continue; }

        const stat = fs.statSync(workspaceFile);
        if (stat.mtime < since) { continue; }

        const parsed = this.parseWorkspaceYaml(workspaceFile);
        const updatedAt = parsed.updated_at ?? stat.mtime.toISOString();
        if (new Date(updatedAt) < since) { continue; }
        if (!this.isSameWorkspace(parsed.cwd)) { continue; }

        sessions.push({
          agent: 'copilot',
          sessionId: parsed.id ?? sessionId,
          title: this.titleFor(parsed.summary, parsed.id ?? sessionId),
          sourcePath: workspaceFile,
          startedAt: parsed.created_at,
          updatedAt
        });
      }
    } catch {
      // Non-fatal: return what we found.
    }

    return sessions.sort(
      (a, b) => new Date(b.updatedAt ?? '').getTime() - new Date(a.updatedAt ?? '').getTime()
    );
  }

  private parseWorkspaceYaml(filePath: string): CopilotWorkspaceYaml {
    const result: CopilotWorkspaceYaml = {};
    const content = fs.readFileSync(filePath, 'utf-8');

    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (!match) { continue; }

      const key = match[1] as keyof CopilotWorkspaceYaml;
      if (!['id', 'cwd', 'summary', 'created_at', 'updated_at'].includes(key)) { continue; }
      result[key] = this.unquote(match[2].trim());
    }

    return result;
  }

  private unquote(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }

  private isSameWorkspace(cwd: string | undefined): boolean {
    if (!cwd) { return false; }
    return path.resolve(cwd) === path.resolve(this.workspaceRoot);
  }

  extractFullConversation(sessionDir: string): { role: 'user' | 'assistant'; text: string }[] {
    const eventsFile = path.join(sessionDir, 'events.jsonl');
    if (!fs.existsSync(eventsFile)) { return []; }

    let rawLines: string[];
    try {
      rawLines = fs.readFileSync(eventsFile, 'utf-8').split(/\r?\n/);
    } catch {
      return [];
    }

    const messages: { role: 'user' | 'assistant'; text: string }[] = [];

    for (const line of rawLines) {
      if (!line.trim()) { continue; }
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; }

      if (!entry || typeof entry !== 'object') { continue; }
      const record = entry as Record<string, unknown>;
      const data = record.data as Record<string, unknown> | undefined;
      if (!data) { continue; }

      if (record.type === 'user.message') {
        const text = typeof data.content === 'string' ? data.content.trim() : '';
        if (text.length >= 2) {
          messages.push({ role: 'user', text });
        }
      }

      if (record.type === 'assistant.message') {
        const text = typeof data.content === 'string' ? data.content.trim() : '';
        if (text.length >= 2) {
          messages.push({ role: 'assistant', text });
        }
      }
    }

    return messages;
  }

  private titleFor(summary: string | undefined, sessionId: string): string {
    const title = summary?.trim();
    return title || `Copilot session ${sessionId.slice(0, 8)}`;
  }
}
