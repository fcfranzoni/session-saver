import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { WorkSession } from '../types';
import { AgentCaptureService } from '../agents/AgentCaptureService';

const CONTEXT_START = '<!-- session-saver:start -->';
const CONTEXT_END   = '<!-- session-saver:end -->';

export class ContextInjector {
  constructor(
    private readonly workspaceRoot: string,
    private readonly agentCapture: AgentCaptureService
  ) {}

  async inject(session: WorkSession): Promise<void> {
    const block = this.buildBlock(session);

    const githubDir = path.join(this.workspaceRoot, '.github');
    if (!fs.existsSync(githubDir)) { fs.mkdirSync(githubDir, { recursive: true }); }

    await Promise.all([
      this.upsertFile(path.join(this.workspaceRoot, 'CLAUDE.md'), block),
      this.upsertFile(path.join(githubDir, 'copilot-instructions.md'), block),
      this.upsertFile(path.join(this.workspaceRoot, '.vscode', 'session-context.md'), block),
    ]);
  }

  private buildBlock(session: WorkSession): string {
    const date = new Date(session.savedAt).toLocaleString('pt-BR');
    const lines = [
      `## Contexto da Sessão Anterior`,
      `**Sessão:** ${session.name} · ${date}`
    ];

    if (session.summary.ai)    { lines.push(`**Resumo:** ${session.summary.ai}`); }
    else                       { lines.push(`**Resumo:** ${session.summary.auto}`); }
    if (session.notes)         { lines.push(`**Nota:** ${session.notes}`); }
    if (session.tags?.length)  { lines.push(`**Tags:** ${session.tags.join(', ')}`); }
    if (session.ticket) {
      const isUrl = session.ticket.startsWith('http://') || session.ticket.startsWith('https://');
      lines.push(isUrl
        ? `**Ticket:** [${session.ticket}](${session.ticket})`
        : `**Ticket:** ${session.ticket}`
      );
    }

    if (session.git) {
      lines.push(
        `**Branch:** ${session.git.branch} · ${session.git.commitHash.slice(0, 8)} ${session.git.commitMessage}`
      );
    }

    if (session.files.length) {
      lines.push('', '**Arquivos alterados:**');
      const byType = { modified: [] as string[], added: [] as string[], deleted: [] as string[] };
      for (const f of session.files) { byType[f.changeType].push(f.relativePath); }
      if (byType.modified.length) { lines.push(`- Modificados: ${byType.modified.join(', ')}`); }
      if (byType.added.length)    { lines.push(`- Adicionados: ${byType.added.join(', ')}`); }
      if (byType.deleted.length)  { lines.push(`- Deletados: ${byType.deleted.join(', ')}`); }
    }

    if (session.agentSessions?.length) {
      lines.push('', '**Chats de IA nesta sessão:**');
      for (const a of session.agentSessions) {
        lines.push(`- [${this.agentCapture.displayName(a.agent)}] ${a.title}`);
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  private async upsertFile(filePath: string, block: string): Promise<void> {
    const marked = `${CONTEXT_START}\n${block}\n${CONTEXT_END}`;
    try {
      let content = await fsp.readFile(filePath, 'utf-8');
      const start = content.indexOf(CONTEXT_START);
      const end   = content.indexOf(CONTEXT_END);
      content = (start !== -1 && end !== -1)
        ? content.slice(0, start) + marked + content.slice(end + CONTEXT_END.length)
        : content.trimEnd() + '\n\n' + marked + '\n';
      await fsp.writeFile(filePath, content, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await fsp.writeFile(filePath, marked + '\n', 'utf-8');
      }
      // other errors are non-fatal — silently skip
    }
  }
}
