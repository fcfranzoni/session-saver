import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentSession } from '../types';

interface CodexIndexEntry {
  id?: string;
  thread_name?: string;
  updated_at?: string;
}

interface CodexSessionMeta {
  type?: string;
  payload?: {
    id?: string;
    cwd?: string;
    timestamp?: string;
  };
}

export class CodexAdapter {
  constructor(
    private readonly workspaceRoot: string,
    private readonly codexRoot = path.join(os.homedir(), '.codex')
  ) {}

  isAvailable(): boolean {
    return fs.existsSync(path.join(this.codexRoot, 'session_index.jsonl'));
  }

  captureAgentSessionsSince(since: Date): AgentSession[] {
    const indexPath = path.join(this.codexRoot, 'session_index.jsonl');
    if (!fs.existsSync(indexPath)) { return []; }

    const sourceFiles = this.indexSourceFiles();
    const byId = new Map<string, AgentSession>();

    for (const entry of this.readIndex(indexPath)) {
      if (!entry.id || !entry.updated_at || new Date(entry.updated_at) < since) { continue; }

      const sourcePath = sourceFiles.get(entry.id);
      const meta = sourcePath ? this.readSessionMeta(sourcePath) : undefined;
      if (meta?.payload?.cwd && !this.isSameWorkspace(meta.payload.cwd)) { continue; }
      if (!meta?.payload?.cwd && sourcePath) { continue; }

      byId.set(entry.id, {
        agent: 'codex',
        sessionId: entry.id,
        title: this.titleFor(entry.thread_name, entry.id),
        sourcePath,
        startedAt: meta?.payload?.timestamp,
        updatedAt: entry.updated_at
      });
    }

    return Array.from(byId.values()).sort(
      (a, b) => new Date(b.updatedAt ?? '').getTime() - new Date(a.updatedAt ?? '').getTime()
    );
  }

  private readIndex(indexPath: string): CodexIndexEntry[] {
    try {
      return fs.readFileSync(indexPath, 'utf-8')
        .split(/\r?\n/)
        .filter(line => line.trim().length > 0)
        .map(line => {
          try { return JSON.parse(line) as CodexIndexEntry; } catch { return null; }
        })
        .filter((entry): entry is CodexIndexEntry => entry !== null);
    } catch {
      return [];
    }
  }

  private indexSourceFiles(): Map<string, string> {
    const sessionsDir = path.join(this.codexRoot, 'sessions');
    const byId = new Map<string, string>();
    if (!fs.existsSync(sessionsDir)) { return byId; }

    const visit = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath);
          continue;
        }

        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) { continue; }
        const id = this.sessionIdFromFilename(entry.name);
        if (id) { byId.set(id, fullPath); }
      }
    };

    visit(sessionsDir);
    return byId;
  }

  private sessionIdFromFilename(filename: string): string | undefined {
    const match = filename.match(/rollout-.+?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    return match?.[1];
  }

  private readSessionMeta(filePath: string): CodexSessionMeta | undefined {
    const firstLine = this.readFirstLine(filePath);
    if (!firstLine) { return undefined; }

    try {
      const meta = JSON.parse(firstLine) as CodexSessionMeta;
      return meta.type === 'session_meta' ? meta : undefined;
    } catch {
      return undefined;
    }
  }

  private readFirstLine(filePath: string): string | undefined {
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      const chunks: Buffer[] = [];
      const buffer = Buffer.alloc(4096);

      while (true) {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) { break; }

        const newlineIndex = buffer.subarray(0, bytesRead).indexOf(10);
        if (newlineIndex !== -1) {
          chunks.push(Buffer.from(buffer.subarray(0, newlineIndex)));
          break;
        }
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }

      return Buffer.concat(chunks).toString('utf-8').trim();
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  private isSameWorkspace(cwd: string): boolean {
    return path.resolve(cwd) === path.resolve(this.workspaceRoot);
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
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; }

      if (!entry || typeof entry !== 'object') { continue; }
      const record = entry as Record<string, unknown>;

      if (record.type !== 'event_msg') { continue; }

      const payload = record.payload as Record<string, unknown> | undefined;
      if (!payload) { continue; }

      if (payload.type === 'user_message') {
        const text = typeof payload.message === 'string' ? payload.message.trim() : '';
        if (text.length >= 2) {
          messages.push({ role: 'user', text });
        }
      }

      if (payload.type === 'agent_message' && payload.phase === 'final_answer') {
        const text = typeof payload.message === 'string' ? payload.message.trim() : '';
        if (text.length >= 2) {
          messages.push({ role: 'assistant', text });
        }
      }
    }

    return messages;
  }

  private titleFor(threadName: string | undefined, sessionId: string): string {
    const title = threadName?.trim();
    return title || `Codex session ${sessionId.slice(0, 8)}`;
  }
}
