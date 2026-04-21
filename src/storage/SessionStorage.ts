import * as fs from 'fs';
import * as path from 'path';
import { WorkSession } from '../types';

export class SessionStorage {
  private cache: WorkSession[] | null = null;

  constructor(readonly dir: string) {
    this.ensureDir();
  }

  ensureDir(): void {
    if (!fs.existsSync(this.dir)) { fs.mkdirSync(this.dir, { recursive: true }); }
  }

  invalidateCache(): void { this.cache = null; }

  list(): WorkSession[] {
    if (this.cache) { return this.cache; }
    if (!fs.existsSync(this.dir)) { return []; }

    this.cache = fs.readdirSync(this.dir)
      .filter(f => f.endsWith('.worksession.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf-8')) as WorkSession; }
        catch { return null; }
      })
      .filter((s): s is WorkSession => s !== null)
      .sort((a, b) => {
        if (a.pinned && !b.pinned) { return -1; }
        if (!a.pinned && b.pinned) { return 1; }
        return b.savedAt < a.savedAt ? -1 : b.savedAt > a.savedAt ? 1 : 0;
      });
    return this.cache;
  }

  getById(id: string): WorkSession | undefined {
    return this.list().find(s => s.id === id);
  }

  write(session: WorkSession): void {
    this.ensureDir();
    fs.writeFileSync(this.sessionPath(session.id), JSON.stringify(session, null, 2), 'utf-8');
    // Upsert in-memory cache instead of discarding it entirely
    if (this.cache) {
      const idx = this.cache.findIndex(s => s.id === session.id);
      if (idx >= 0) {
        this.cache[idx] = session;
      } else {
        this.cache.unshift(session);
      }
      // Re-sort: pinned-first, then ISO desc (lexicographic compare works for ISO strings)
      this.cache.sort((a, b) => {
        if (a.pinned && !b.pinned) { return -1; }
        if (!a.pinned && b.pinned) { return 1; }
        return b.savedAt < a.savedAt ? -1 : b.savedAt > a.savedAt ? 1 : 0;
      });
    }
  }

  delete(session: WorkSession): void {
    const filePath = this.sessionPath(session.id);
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
    const assetsDir = path.join(this.dir, `${session.id}.assets`);
    if (fs.existsSync(assetsDir)) { fs.rmSync(assetsDir, { recursive: true, force: true }); }
    this.invalidateCache();
  }

  writeDraft(session: WorkSession): void {
    this.ensureDir();
    try {
      fs.writeFileSync(this.draftPath(session.id), JSON.stringify(session, null, 2), 'utf-8');
    } catch { /* non-fatal */ }
  }

  deleteDraft(sessionId: string): void {
    try { fs.unlinkSync(this.draftPath(sessionId)); } catch { /* ok */ }
  }

  readDrafts(): WorkSession[] {
    if (!fs.existsSync(this.dir)) { return []; }
    return fs.readdirSync(this.dir)
      .filter(f => f.endsWith('.draft.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf-8')) as WorkSession; }
        catch { return null; }
      })
      .filter((s): s is WorkSession => s !== null);
  }

  sessionPath(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.worksession.json`);
  }

  private draftPath(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.draft.json`);
  }
}
