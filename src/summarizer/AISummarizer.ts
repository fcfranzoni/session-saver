import * as vscode from 'vscode';
import { WorkSession } from '../types';

export class AISummarizer {
  async summarizeSession(session: WorkSession): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('sessionSaver');
    const provider = config.get<string>('ai.provider', 'none');
    if (provider === 'none') { return undefined; }

    const prompt = this.buildPrompt(session);
    const apiKey = config.get<string>('ai.apiKey', '');
    const model = config.get<string>('ai.model', '');
    const rawOllamaUrl = config.get<string>('ai.ollamaUrl', 'http://localhost:11434');
    const ollamaUrl = this.sanitizeOllamaUrl(rawOllamaUrl);
    if (provider === 'ollama' && !ollamaUrl) {
      void vscode.window.showErrorMessage('Session Saver: ollamaUrl must point to localhost or 127.0.0.1.');
      return undefined;
    }

    try {
      if (provider === 'claude') {
        return await this.callClaude(prompt, apiKey, model || 'claude-haiku-4-5-20251001');
      }
      if (provider === 'openai') {
        return await this.callOpenAI(prompt, apiKey, model || 'gpt-4o-mini');
      }
      if (provider === 'ollama') {
        return await this.callOllama(prompt, ollamaUrl, model || 'llama3');
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private buildPrompt(session: WorkSession): string {
    const parts: string[] = [
      `Summarize this coding session in 1-2 sentences (Portuguese, concise):`,
      `Session: "${session.name}"`,
      `Duration: ${session.durationMinutes} minutes`,
    ];

    if (session.git) {
      parts.push(`Branch: ${session.git.branch}`);
      if (session.git.commitMessage) {
        parts.push(`Last commit: ${session.git.commitMessage}`);
      }
    }

    if (session.files.length > 0) {
      const modified = session.files.filter(f => f.changeType === 'modified').map(f => f.relativePath);
      const added = session.files.filter(f => f.changeType === 'added').map(f => f.relativePath);
      const deleted = session.files.filter(f => f.changeType === 'deleted').map(f => f.relativePath);
      if (modified.length) { parts.push(`Modified: ${modified.slice(0, 5).join(', ')}`); }
      if (added.length)    { parts.push(`Added: ${added.slice(0, 5).join(', ')}`); }
      if (deleted.length)  { parts.push(`Deleted: ${deleted.slice(0, 5).join(', ')}`); }
    }

    if (session.agentSessions?.length) {
      const titles = session.agentSessions.slice(0, 3).map(a => a.title);
      parts.push(`AI chats: ${titles.join('; ')}`);
    }

    if (session.notes) {
      parts.push(`Notes: ${session.notes}`);
    }

    return parts.join('\n');
  }

  private async callClaude(prompt: string, apiKey: string, model: string): Promise<string> {
    const res = await this.fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
    });
    const json = await res.json() as { content?: { text?: string }[] };
    return json.content?.[0]?.text?.trim() ?? '';
  }

  private async callOpenAI(prompt: string, apiKey: string, model: string): Promise<string> {
    const res = await this.fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
    });
    const json = await res.json() as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content?.trim() ?? '';
  }

  /** Returns the URL only if it targets loopback; otherwise undefined. */
  private sanitizeOllamaUrl(raw: string): string | undefined {
    try {
      const u = new URL(raw);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1') {
        return raw;
      }
    } catch { /* invalid URL */ }
    return undefined;
  }

  private async callOllama(prompt: string, baseUrl: string, model: string): Promise<string> {
    const url = new URL('/api/generate', baseUrl).toString();
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
    });
    const json = await res.json() as { response?: string };
    return json.response?.trim() ?? '';
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
