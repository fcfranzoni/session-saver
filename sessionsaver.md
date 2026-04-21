# Session Saver — Contexto do Projeto

Use este arquivo como contexto para o Claude Code. Cole o conteúdo dele no início da conversa ou salve como `CLAUDE.md` na raiz do projeto.

---

## O que é

Plugin para VS Code chamado **Session Saver** que salva e restaura sessões de trabalho. Quando o usuário aciona "salvar sessão", o plugin captura:

- Quais arquivos foram tocados (abertos, modificados, adicionados, deletados)
- O estado do editor (abas abertas, arquivo ativo)
- O contexto git (branch, commit, diff)
- O histórico do chat da IA usada (Claude Code, Copilot, Codex, Cline)

Ao restaurar, reabre os arquivos e reinjecta o contexto para o usuário continuar de onde parou.

---

## Decisões tomadas

### Agnóstico de agente
O plugin não depende de nenhuma IA específica. Cada agente salva o histórico em um local diferente no disco — o plugin lê esses arquivos diretamente. Não há API padronizada entre agentes.

### Resumo da sessão — Opção 3 (local + IA opcional)
- Sempre gera um resumo automático local (duração, arquivos, branch, agente)
- IA é um enhancement opcional configurável pelo usuário
- Providers suportados: `none` | `claude` | `openai` | `ollama`
- Se não configurado, funciona normalmente sem IA

### Ícones
Usa exclusivamente **Codicons** — a biblioteca de ícones nativa do VS Code. Nada custom. Exemplos: `$(save)`, `$(trash)`, `$(play)`, `$(add)`, `$(debug-stop)`, `$(circle-filled)`, `$(robot)`.

### Sessões salvas em disco
Ficam em `.vscode/sessions/*.worksession.json` dentro do workspace. Formato JSON documentado abaixo.

---

## Visual da sidebar (padrão nativo VS Code)

```
SESSION SAVER                    $(save) $(debug-stop) $(add)
─────────────────────────────────────────────────────
SESSÃO ATIVA
  ● Fix no login JWT                              1h42m
    branch feat/auth-fix · Claude Code

ARQUIVOS ALTERADOS                                    6
  M  login.ts                              src/auth
  M  token.ts                              src/auth
  A  auth.ts                          src/middleware
  M  auth.test.ts                            tests
  D  legacy.ts                             src/auth
  M  .env.example                               ./

SESSÕES SALVAS
  Hoje
  $(save) Refactor payment service    3h atrás  Copilot  [$(trash) no hover]
  $(save) Setup CI pipeline           5h atrás           [$(trash) no hover]
  Ontem
  $(save) Algolia search filter       14 abr    Claude   [$(trash) no hover]
  $(save) GraphQL federation fix      14 abr    Codex    [$(trash) no hover]
```

**Comportamento do hover nas sessões salvas:**
- Estado normal: mostra tempo + agente
- Hover: esconde tempo/agente, mostra `$(play) Continuar` + `$(trash)` inline

**Cabeçalho:**
- `$(save)` = salvar sessão ativa
- `$(debug-stop)` = encerrar sessão ativa
- `$(add)` = iniciar nova sessão
- Ícones aparecem via `view/title` no `package.json` com `when` condicional

---

## Estrutura de arquivos

```
session-saver/
├── package.json
├── tsconfig.json
├── README.md
├── .gitignore
└── src/
    ├── extension.ts            ← entry point, registra comandos e providers
    ├── types.ts                ← schema TypeScript do WorkSession
    ├── SessionManager.ts       ← ciclo de vida: start, save, stop, resume, delete
    ├── FileTracker.ts          ← listeners de onDidSave, onDidOpen, etc
    ├── GitTracker.ts           ← captura branch, commit e diff com simple-git
    ├── adapters/               ← (Fase 5) leitura do histórico por agente
    │   ├── ClaudeCodeAdapter.ts
    │   ├── CopilotAdapter.ts
    │   ├── CodexAdapter.ts
    │   └── ClineAdapter.ts
    ├── summarizer/             ← (Fase 4b) resumo com IA opcional
    │   ├── AISummarizer.ts     ← interface comum
    │   ├── LocalSummarizer.ts  ← sempre funciona, sem IA
    │   ├── ClaudeSummarizer.ts
    │   ├── OpenAISummarizer.ts
    │   └── OllamaSummarizer.ts
    └── ui/
        ├── SessionTreeView.ts  ← 3 TreeDataProviders da sidebar
        └── StatusBarItem.ts    ← item na barra de status
```

---

## Schema do .worksession.json

```typescript
interface WorkSession {
  id: string                  // uuid v4
  name: string                // nome dado pelo usuário ou gerado
  createdAt: string           // ISO timestamp de início
  savedAt: string             // ISO timestamp do save
  durationMinutes: number
  workspaceFolder: string     // caminho absoluto do workspace
  files: TrackedFile[]
  editorState: EditorState
  agentSessions?: AgentSession[] // chats/sessões de IA capturados por título/id
  prompts?: CapturedPrompt[]  // legado: versões antigas salvavam perguntas individuais
  git?: GitState              // opcional, capturado na Fase 2
  agentContext?: AgentContext  // opcional, Fase 5
  summary: {
    auto: string              // sempre presente: "2h · 6 modificados · Claude Code"
    ai?: string               // opcional: resumo gerado por IA
  }
  tags: string[]
}

interface TrackedFile {
  path: string           // absoluto
  relativePath: string   // relativo ao workspace
  changeType: 'modified' | 'added' | 'deleted'
  openedAt: string
  savedAt?: string
}

interface EditorState {
  openTabs: string[]
  activeFile?: string
  cursorPositions: Record<string, { line: number; character: number }>
}

interface GitState {
  branch: string
  commitHash: string
  commitMessage: string
  diff: string
}

interface CapturedPrompt {
  agent: 'claude' | 'copilot' | 'chatgpt' | 'manual'
  question: string
  timestamp: string
  sourceSessionId?: string  // ex: UUID do JSONL do Claude Code
  sourcePath?: string       // arquivo de origem usado como ponteiro/debug
  sourceLine?: number       // linha 1-based dentro do arquivo de origem
}

interface AgentSession {
  agent: 'claude' | 'copilot' | 'chatgpt' | 'codex' | 'manual'
  sessionId: string         // ex: UUID do JSONL do Claude Code
  title: string             // ex: aiTitle do Claude Code
  sourcePath?: string       // arquivo de origem usado como ponteiro/debug
  startedAt?: string
  updatedAt?: string
}

interface AgentContext {
  agent: 'claude' | 'copilot' | 'codex' | 'cline' | 'continue' | 'none'
  messages: { role: 'user' | 'assistant'; content: string; timestamp: string }[]
  capturedAt: string
}
```

---

## Fases de desenvolvimento

### Fase 1 — Núcleo (começar aqui)
- `types.ts` — schema completo
- `FileTracker.ts` — listeners de arquivo
- `SessionManager.ts` — start, save, stop, resume, delete, list
- `ui/SessionTreeView.ts` — 3 TreeDataProviders
- `ui/StatusBarItem.ts` — status bar
- `extension.ts` — entry point, registro de comandos

**Quando Fase 1 estiver pronta:** plugin já funciona, rastreia arquivos, salva/restaura sessões, mostra sidebar e status bar.

### Fase 2 — Git ✅
- `GitTracker.ts` usando lib `simple-git`
- Adiciona `git?: GitState` no `.worksession.json`
- Captura branch atual, último commit e diff staged/unstaged ao salvar a sessão

### Fase 3 — Resumo automático local
- `summarizer/LocalSummarizer.ts`
- Gera texto como: `"2h34min · 8 modificados · branch feat/login · Claude Code"`

### Fase 4 — Resumo com IA (opcional)
- `summarizer/AISummarizer.ts` — interface comum
- Implementações: Claude, OpenAI, Ollama
- Configurado via `sessionSaver.ai.provider` nas settings

### Fase 5 — Adaptadores por agente
Cada agente salva o histórico em local diferente:

| Agente | Localização do histórico |
|--------|--------------------------|
| Copilot | `workspaceStorage/.../chatSessions/*.json` |
| Claude Code | `~/.claude/projects/<workspace-encoded>/*.jsonl` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Cline | `globalStoragePath/history/` |
| Continue | `globalStoragePath/history/` |

Limitação conhecida: não é possível reabrir o chat visual do agente. O plugin injeta o histórico em texto num arquivo `CLAUDE.md` ou `.clinerules` para o agente usar como contexto.

---

## Comandos registrados

| Comando | Ícone | Quando aparece |
|---------|-------|----------------|
| `sessionSaver.startSession` | `$(add)` | Sem sessão ativa |
| `sessionSaver.saveSession` | `$(save)` | Com sessão ativa |
| `sessionSaver.stopSession` | `$(debug-stop)` | Com sessão ativa |
| `sessionSaver.resumeSession` | `$(play)` | Hover em sessão salva |
| `sessionSaver.deleteSession` | `$(trash)` | Hover em sessão salva |
| `sessionSaver.openAgentSession` | `$(comment-discussion)` | Clique/ação inline em chat capturado |

**Ao clicar em um chat capturado:**
- Abre direto a UI nativa do agente, quando houver comando disponível
- Para Claude, chama `claude-vscode.primaryEditor.open` com o `sessionId`
- Para Copilot e Codex, abre a UI geral do agente até termos adapters que capturem ids/títulos retomáveis

---

## Configurações (contributes.configuration)

| Chave | Tipo | Padrão | Descrição |
|-------|------|--------|-----------|
| `sessionSaver.autoSaveOnStop` | boolean | `true` | Salva ao encerrar |
| `sessionSaver.remindAfterMinutes` | number | `60` | Lembrete de save (0 = off) |
| `sessionSaver.ai.provider` | enum | `"none"` | `none` / `claude` / `openai` / `ollama` |
| `sessionSaver.ai.apiKey` | string | `""` | API key do provider |
| `sessionSaver.ai.ollamaUrl` | string | `"http://localhost:11434"` | URL do Ollama |
| `sessionSaver.ai.model` | string | `""` | Modelo (ex: `llama3`, `gpt-4o`) |

---

## Setup inicial

```bash
# Pré-requisitos: Node.js 18+ e VS Code instalados

npm install -g yo generator-code
yo code

# Responder:
# Type: New Extension (TypeScript)
# Name: session-saver
# Identifier: session-saver
# Webpack: No
# Package manager: npm

cd session-saver
npm install simple-git
npm run compile

# Pressionar F5 no VS Code para testar
```

---

## Instrução para o Claude Code

Ao iniciar, diga ao Claude Code:
