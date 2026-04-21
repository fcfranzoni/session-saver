import * as vscode from 'vscode';
import { WorkSession } from '../types';

export class StatsPanel {
  private static instance: StatsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  static show(context: vscode.ExtensionContext, sessions: WorkSession[]): void {
    if (StatsPanel.instance) {
      StatsPanel.instance.update(sessions);
      StatsPanel.instance.panel.reveal();
      return;
    }
    StatsPanel.instance = new StatsPanel(context, sessions);
  }

  private constructor(context: vscode.ExtensionContext, sessions: WorkSession[]) {
    this.panel = vscode.window.createWebviewPanel(
      'sessionSaverStats',
      'Session Saver — Estatísticas',
      vscode.ViewColumn.One,
      { enableScripts: false, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => { StatsPanel.instance = undefined; }, null, context.subscriptions);
    this.update(sessions);
  }

  update(sessions: WorkSession[]): void {
    this.panel.webview.html = this.buildHtml(sessions);
  }

  private buildHtml(sessions: WorkSession[]): string {
    const total     = sessions.length;
    const totalMins = sessions.reduce((n, s) => n + s.durationMinutes, 0);
    const totalHours = (totalMins / 60).toFixed(1);

    // Sessions per day (last 30 days)
    const now = Date.now();
    const dayCount: Record<string, number> = {};
    for (const s of sessions) {
      const age = (now - new Date(s.savedAt).getTime()) / 86_400_000;
      if (age > 30) { continue; }
      const key = new Date(s.savedAt).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
      dayCount[key] = (dayCount[key] ?? 0) + 1;
    }
    const dayKeys   = Object.keys(dayCount);
    const dayValues = Object.values(dayCount);
    const maxDay    = Math.max(...dayValues, 1);

    // Tags frequency
    const tagCount: Record<string, number> = {};
    for (const s of sessions) {
      for (const t of s.tags ?? []) { tagCount[t] = (tagCount[t] ?? 0) + 1; }
    }
    const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // Files frequency
    const fileCount: Record<string, number> = {};
    for (const s of sessions) {
      for (const f of s.files ?? []) { fileCount[f.relativePath] = (fileCount[f.relativePath] ?? 0) + 1; }
    }
    const topFiles = Object.entries(fileCount).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // Agent sessions
    const agentCount: Record<string, number> = {};
    for (const s of sessions) {
      for (const a of s.agentSessions ?? []) { agentCount[a.agent] = (agentCount[a.agent] ?? 0) + 1; }
    }

    const e = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const bars = dayKeys.map((k, i) => {
      const h = Math.max(4, Math.round((dayValues[i] / maxDay) * 72));
      return `<div class="bar" style="height:${h}px" title="${e(k)}: ${dayValues[i]}"></div>`;
    }).join('');

    const barLabels = dayKeys.map(k => `<span class="bl">${e(k)}</span>`).join('');

    const tagRows = topTags.map(([t, n]) =>
      `<tr><td><span class="pill">${e(t)}</span></td><td>${n}</td></tr>`
    ).join('');

    const fileRows = topFiles.map(([f, n]) =>
      `<tr><td class="mono">${e(f)}</td><td>${n}</td></tr>`
    ).join('');

    const agentRows = Object.entries(agentCount).sort((a, b) => b[1] - a[1]).map(([a, n]) =>
      `<tr><td>${e(a)}</td><td>${n}</td></tr>`
    ).join('');

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px 24px}
h1{font-size:1.3em;margin-bottom:20px}
h2{font-size:.8em;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground);margin:20px 0 10px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:4px}
.card{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border,#444);border-radius:6px;padding:14px 20px;min-width:110px}
.val{font-size:1.9em;font-weight:bold}
.lbl{font-size:.75em;color:var(--vscode-descriptionForeground);margin-top:2px}
.chart{display:flex;align-items:flex-end;gap:3px;height:76px;margin-bottom:4px}
.bar{background:var(--vscode-button-background);border-radius:2px 2px 0 0;flex:1;min-width:8px;cursor:default}
.bar:hover{opacity:.75}
.labels{display:flex;gap:3px;font-size:.6em;color:var(--vscode-descriptionForeground);overflow:hidden}
.bl{flex:1;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
table{width:100%;border-collapse:collapse;font-size:.9em}
th,td{padding:5px 8px;border-bottom:1px solid var(--vscode-widget-border,#333);text-align:left}
th{color:var(--vscode-descriptionForeground);font-weight:normal}
.pill{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);padding:1px 8px;border-radius:10px;font-size:.85em}
.mono{font-family:var(--vscode-editor-font-family,monospace);font-size:.85em}
</style>
</head>
<body>
<h1>📊 Estatísticas de Sessões</h1>
<div class="cards">
  <div class="card"><div class="val">${total}</div><div class="lbl">Sessões salvas</div></div>
  <div class="card"><div class="val">${totalHours}h</div><div class="lbl">Tempo total</div></div>
  <div class="card"><div class="val">${topTags.length}</div><div class="lbl">Tags únicas</div></div>
  <div class="card"><div class="val">${Object.keys(fileCount).length}</div><div class="lbl">Arquivos tocados</div></div>
</div>
${dayKeys.length > 0 ? `
<h2>Sessões nos últimos 30 dias</h2>
<div class="chart">${bars}</div>
<div class="labels">${barLabels}</div>
` : ''}
${topTags.length > 0 ? `
<h2>Tags mais usadas</h2>
<table><tr><th>Tag</th><th>Sessões</th></tr>${tagRows}</table>
` : ''}
${topFiles.length > 0 ? `
<h2>Arquivos mais editados</h2>
<table><tr><th>Arquivo</th><th>Sessões</th></tr>${fileRows}</table>
` : ''}
${Object.keys(agentCount).length > 0 ? `
<h2>Chats por agente de IA</h2>
<table><tr><th>Agente</th><th>Chats</th></tr>${agentRows}</table>
` : ''}
</body>
</html>`;
  }
}
