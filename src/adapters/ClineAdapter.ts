import * as fs from 'fs';
import * as path from 'path';
import { AgentSession } from '../types';

interface ClineHistoryEntry {
  id?: string;
  task?: string;
  ts?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export class ClineAdapter {
  constructor(
    private readonly workspaceRoot: string,
    private readonly historyRoot: string
  ) {}

  isAvailable(): boolean {
    return fs.existsSync(this.historyRoot);
  }

  captureAgentSessionsSince(since: Date): AgentSession[] {
    if (!this.isAvailable()) { return []; }

    const sessions: AgentSession[] = [];

    try {
      for (const entry of this.readHistoryEntries()) {
        if (!entry.id || !entry.ts) { continue; }
        const updatedAt = new Date(entry.ts).toISOString();
        if (new Date(updatedAt) < since) { continue; }

        const sessionDir = path.join(this.historyRoot, entry.id);

        sessions.push({
          agent: 'cline',
          sessionId: entry.id,
          title: this.titleFor(entry.task, entry.id),
          sourcePath: fs.existsSync(sessionDir) ? sessionDir : undefined,
          updatedAt
        });
      }
    } catch { /* non-fatal */ }

    return sessions.sort(
      (a, b) => new Date(b.updatedAt ?? '').getTime() - new Date(a.updatedAt ?? '').getTime()
    );
  }

  private readHistoryEntries(): ClineHistoryEntry[] {
    const indexPath = path.join(this.historyRoot, 'history.json');
    if (!fs.existsSync(indexPath)) { return this.readLegacyEntries(); }

    try {
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  private readLegacyEntries(): ClineHistoryEntry[] {
    // Older Cline versions store one JSON file per session directly in historyRoot.
    // We only read files whose mtime is plausibly relevant (stat is cheap vs. full JSON parse).
    const entries: ClineHistoryEntry[] = [];
    let dirEntries: fs.Dirent[];
    try { dirEntries = fs.readdirSync(this.historyRoot, { withFileTypes: true }); } catch { return entries; }

    for (const dirent of dirEntries) {
      if (!dirent.isFile() || !dirent.name.endsWith('.json')) { continue; }
      const filePath = path.join(this.historyRoot, dirent.name);
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const id  = dirent.name.replace(/\.json$/, '');
        const ts  = raw.ts ?? raw.updatedAt ?? raw.created_at;
        entries.push({
          id,
          task: raw.task ?? raw.title,
          ts: typeof ts === 'number' ? ts : ts ? new Date(ts).getTime() : undefined,
        });
      } catch { /* skip malformed file */ }
    }

    return entries;
  }

  private titleFor(task: string | undefined, sessionId: string): string {
    const title = task?.trim().split('\n')[0];
    return title || `Cline session ${sessionId.slice(0, 8)}`;
  }
}
