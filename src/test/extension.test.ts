import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { ClaudeCodeAdapter } from '../adapters/ClaudeCodeAdapter';
import { GitTracker } from '../GitTracker';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('GitTracker returns undefined outside a git repo', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-saver-no-git-'));
		try {
			const state = await new GitTracker(dir).capture();
			assert.strictEqual(state, undefined);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('GitTracker captures branch, latest commit, and working diff', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-saver-git-'));
		try {
			runGit(dir, 'init', '-b', 'main');
			runGit(dir, 'config', 'user.email', 'test@example.com');
			runGit(dir, 'config', 'user.name', 'Session Saver Test');

			const filePath = path.join(dir, 'notes.txt');
			fs.writeFileSync(filePath, 'hello\n', 'utf-8');
			runGit(dir, 'add', 'notes.txt');
			runGit(dir, 'commit', '-m', 'Initial notes');

			fs.writeFileSync(filePath, 'hello world\n', 'utf-8');

			const state = await new GitTracker(dir).capture();

			assert.ok(state);
			assert.strictEqual(state.branch, 'main');
			assert.strictEqual(state.commitMessage, 'Initial notes');
			assert.match(state.commitHash, /^[a-f0-9]{40}$/);
			assert.ok(state.diff.includes('-hello'));
			assert.ok(state.diff.includes('+hello world'));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('ClaudeCodeAdapter resolves project directory dynamically', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-saver-claude-'));
		try {
			const workspaceRoot = path.join(root, 'workspace');
			const projectsRoot = path.join(root, 'projects');
			const projectDir = path.join(projectsRoot, workspaceRoot.replace(/\//g, '-'));
			const sessionId = '11111111-2222-3333-4444-555555555555';
			const since = new Date('2026-04-16T00:00:00.000Z');
			const adapter = new ClaudeCodeAdapter(workspaceRoot, projectsRoot);

			assert.strictEqual(adapter.isAvailable(), false);

			fs.mkdirSync(projectDir, { recursive: true });
			fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
				JSON.stringify({
					type: 'ai-title',
					sessionId,
					aiTitle: 'Salvar e reabrir chats de IA'
				}),
				JSON.stringify({
					type: 'assistant',
					timestamp: '2026-04-16T00:30:00.000Z',
					sessionId,
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Resposta anterior' }]
					}
				}),
				JSON.stringify({
					type: 'user',
					timestamp: '2026-04-16T01:00:00.000Z',
					sessionId,
					message: {
						role: 'user',
						content: [{ type: 'text', text: 'Como salvo esta sessão da IA?' }]
					}
				}),
				''
			].join('\n'), 'utf-8');

			const agentSessions = adapter.captureAgentSessionsSince(since);
			const prompts = adapter.capturePromptsSince(since);

			assert.strictEqual(adapter.isAvailable(), true);
			assert.strictEqual(agentSessions.length, 1);
			assert.strictEqual(agentSessions[0].title, 'Salvar e reabrir chats de IA');
			assert.strictEqual(agentSessions[0].sessionId, sessionId);
			assert.strictEqual(prompts.length, 1);
			assert.strictEqual(prompts[0].agent, 'claude');
			assert.strictEqual(prompts[0].sourceSessionId, sessionId);
			assert.ok(prompts[0].sourcePath?.endsWith(`${sessionId}.jsonl`));
			assert.strictEqual(prompts[0].sourceLine, 3);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

function runGit(cwd: string, ...args: string[]): void {
	execFileSync('git', args, { cwd, stdio: 'ignore' });
}
