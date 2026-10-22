# Alpha AI Workspace — Project Brief

> Generated from a full read of the repository at commit `5f8f066` (branch `arena/9f7ee453-alpha`).
> Purpose: hand this to another AI assistant so it can add features without guessing.
> Version `1.0.6`, product name **Alpha AI Workspace** (`appId: com.alpha.aiworkspace`).

---

## 0. One-paragraph summary

Alpha AI Workspace is a **local-first Windows desktop AI coding environment** built with
**Electron 44 + React 19 + TypeScript + electron-vite**. It connects to the user's existing
**Ollama** install and to any **OpenAI-compatible** cloud endpoint, opens real project folders,
performs **approval-gated** file edits, runs dev commands, and manages Git/GitHub.
A **second, optional surface** is "Alpha Cloud": one **Neon Postgres** database reached only through
one **Neon Function (Hono)** in `platform/api/`, which serves auth/plans/usage, a server-side
**AI gateway** (so provider keys never reach the client), and admin control-plane RPCs.
A **third surface** is a dependency-free static **website** (`website/`) with marketing pages,
an account portal, and a signed-in dashboard.

Three surfaces, one account, one source of truth.

---

## 1. Tech Stack & Dependencies

### Runtime / build

| Area | Choice |
| --- | --- |
| Desktop shell | **Electron 44** (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`) |
| UI | **React 19**, **Zustand 5** (state), **Tailwind CSS 4** via `@tailwindcss/vite` |
| Language | **TypeScript 5.7**, `strict: true` |
| Bundler | **Vite 7** driven by **electron-vite 5** (`electron.vite.config.ts`) |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-highlight` + `highlight.js` |
| Icons | `lucide-react` |
| Node | 20+ (CI uses 22; project developed on 24) |
| Target | Windows 10/11 x64, NSIS installer, `asar` |

### Local runtime dependencies (app)

| Package | Role |
| --- | --- |
| `sql.js` ^1.13 | **WASM SQLite** for all local persistence — no native rebuilds. File: `%APPDATA%/alpha-ai-workspace/alpha.db` |
| `zod` ^3.25 | Every IPC payload is validated against a schema in `src/shared/schemas.ts` |
| `diff` ^8 | Unified-diff generation/application for the edit pipeline |
| `ignore` ^7 | `.gitignore`-style filtering in the project tree |
| `pdf-parse` ^1.1 | PDF text extraction for attachments |
| `electron-updater` ^6.8 | Auto-update from GitHub Releases |
| `jose` ^6.2 | HS256 session JWTs (backend) |
| `hono` ^4.13 | Backend HTTP framework (the Neon Function) |
| `@neon/config`, `@neon/env`, `@neon/functions` | Neon deploy config (`neon.ts`), env parsing, `waitUntil` |
| `@supabase/supabase-js` | **Present but unused** — leftover from the pre-migration backend. Safe removal candidate. |

### Dev / tooling

`electron` 44, `electron-builder` 26, `electron-vite` 5, `vite` 7, `vitest` 3,
`typescript` 5.7, `pg` + `@electric-sql/pglite` (real Postgres semantics for migration tests),
`@types/*`.

### Secrets & security primitives

- **At rest:** Electron `safeStorage` (Windows DPAPI) → `SafeStorageCipher`; falls back to a
  reversible `ObfuscationCipher` when DPAPI is unavailable (`src/main/services/secrets.ts`,
  `src/main/context.ts`). Stored at `userData/secrets.enc`.
- **CSP** injected via `session.webRequest.onHeadersReceived` — strict in production, relaxed
  in dev (`src/main/index.ts: contentSecurityPolicy`).
- **IPC allow-list:** preload rejects any channel not in `INVOKE_CHANNELS` / `EVENT_CHANNELS`.
- **Log redaction:** `src/shared/redactSensitive.ts`.

### Testing

- `vitest` — 31 files, ~333 cases, `tests/**/*.test.ts`, 15 s timeout (`vitest.config.ts`).
- `vitest.bench.config.ts` — chat pipeline benchmark (`npm run bench:chat`).
- `tests/ollama.live.test.ts` is opt-in/live; everything else is offline with mocked `fetch`.
- CI: `.github/workflows/ci.yml` (Windows runner) — refuses tracked secret files, then
  `npm ci`, typecheck, test, build, website verify.

---

## 2. Directory Structure & File Layout

```
Alpha-/
├─ src/                          # ← desktop app (the main product)
│  ├─ main/                      # Electron main process (Node side)
│  │  ├─ index.ts                # app bootstrap: CSP, window, deep links, updater
│  │  ├─ context.ts              # DI root: constructs every service in order
│  │  ├─ ipc.ts                  # 97 ipcMain.handle() registrations, zod-validated
│  │  └─ services/
│  │     ├─ chat.ts              # agent loop: history, tools, approvals, streaming
│  │     ├─ tools.ts             # tool definitions + executeTool() dispatch
│  │     ├─ providers/           # model adapters (see §4)
│  │     │  ├─ types.ts          # ProviderAdapter contract
│  │     │  ├─ registry.ts       # routing, presets, secrets, gateway sync
│  │     │  ├─ ollama.ts         # native /api/chat (NDJSON stream)
│  │     │  ├─ openaiCompatible.ts# /v1/chat/completions (SSE stream)
│  │     │  └─ gateway.ts        # Alpha Cloud /gateway/chat/completions
│  │     ├─ db.ts                # sql.js open/persist + versioned MIGRATIONS[]
│  │     ├─ store.ts             # repos: Settings, Conversations, Projects, Providers
│  │     ├─ secrets.ts           # Cipher implementations + SecretStore
│  │     ├─ projectService.ts    # tree, read, search, write, root confinement
│  │     ├─ pathGuard.ts         # safeResolve / assertInsideRoot / sensitive files
│  │     ├─ ignoreRules.ts       # .gitignore handling
│  │     ├─ editService.ts       # propose → diff → apply (stale detection)
│  │     ├─ checkpoints.ts       # pre-write backups + restore
│  │     ├─ permissionService.ts # PermissionService + ApprovalBroker
│  │     ├─ terminal.ts          # spawn, stream, risk assessment, cancel
│  │     ├─ git.ts               # status/diff/stage/commit/push/pull/branches
│  │     ├─ github.ts            # REST API via PAT or gh CLI
│  │     ├─ githubOAuth.ts       # Device Flow
│  │     ├─ ollamaManager.ts     # install detect, catalog, pull, hardware, preload
│  │     ├─ attachments.ts       # drag/drop + PDF text extraction
│  │     ├─ skills.ts            # markdown "product skills" → system prompt
│  │     ├─ platform.ts          # Alpha Cloud session (tokens, deep links)
│  │     ├─ browserPreview.ts    # embedded BrowserView + localhost preview
│  │     ├─ updater.ts           # electron-updater wrapper
│  │     └─ logger.ts            # file + level-filtered logger
│  ├─ preload/index.ts           # contextBridge → window.alpha { invoke, subscribe }
│  ├─ renderer/
│  │  ├─ index.html
│  │  └─ src/
│  │     ├─ App.tsx              # shell: titlebar, sidebar, inspector, splash
│  │     ├─ main.tsx
│  │     ├─ pages/               # Home, Chat, Models, Providers, Projects, GitHub,
│  │     │                       # Skills, Settings, Help
│  │     ├─ components/          # Composer, MessageList, Inspector, ModelMenu,
│  │     │  └─ panels/           #  Explorer, Changes, Diff, Activity, Terminal,
│  │     │                       #  Tests, Git, Browser
│  │     ├─ store/useApp.ts      # the big Zustand store (state + all actions)
│  │     ├─ store/useWorkspace.ts# file/diff/search selection state
│  │     ├─ lib/api.ts           # typed IPC client (ChannelName → contract)
│  │     └─ styles.css           # Tailwind + theme tokens
│  └─ shared/                    # imported by ALL three bundles
│     ├─ types.ts                # 500+ lines: every domain model, AppSettings, PlatformConfig
│     ├─ channels.ts             # CH (invoke) + EVENTS (push) allow-lists
│     ├─ ipc.ts                  # IpcContract: request/response type per channel
│     ├─ schemas.ts              # zod schemas used by ipc.ts
│     ├─ permissions.ts          # modes, defaults, resolvePermission()
│     ├─ theme.ts                # theme catalog + CSS token generation
│     ├─ providerUrl.ts          # endpoint validation/normalization
│     ├─ browserUrl.ts           # localhost URL handling for preview
│     ├─ redactSensitive.ts
│     └─ conversationTitle.ts
│
├─ platform/api/                 # ← backend: ONE Neon Function (Hono, Node 24)
│  ├─ index.ts                   # app, CORS, mounts, error handling
│  ├─ auth.ts                    # OTP/magic link, password, register, OAuth, sessions
│  ├─ platform.ts                # /config (the PlatformConfig contract), /device
│  ├─ gateway.ts                 # shared inference proxy + quota claim/settle
│  ├─ admin.ts                   # staff RPC surface (all guarded by admin_* SQL fns)
│  ├─ downloads.ts               # gated installer release
│  ├─ middleware.ts              # requireAuth (Bearer → ctx.userId)
│  ├─ jwt.ts / crypto.ts / password.ts / sessions.ts
│  ├─ db.ts                      # withContext(): sets app.user_id, txn scope
│  ├─ env.ts / types.ts
│  ├─ email.ts / emailTemplates.ts
│  ├─ aiGuard.ts                 # size/token caps, reservation, cost estimate, redact
│  ├─ oauth.ts                   # Google/GitHub token exchange + JWKS verify
│  ├─ profile.ts                 # name/phone validation rules
│  ├─ maintenance.ts / releases.ts
│  └─ downloads.ts
│
├─ database/migrations/          # Postgres schema, applied in order
│  ├─ 0001_platform.sql   (1002 lines: users, sessions, plans, usage, models, admin)
│  ├─ 0002_auth.sql       (identities, password creds, attempts, oauth codes, releases)
│  ├─ 0003_control_center.sql
│  ├─ 0004_shared_ai.sql  (provider/model catalog, gateway quota fns)
│  ├─ 0005_member_passwords.sql
│  └─ 0006_member_profile.sql
│
├─ website/                      # ← static site, NO build step
│  ├─ index / features / pricing / about / download / privacy / terms .html
│  ├─ account.html               # sign-in / sign-up portal (+ assets/account.js)
│  ├─ app.html                   # signed-in dashboard (+ assets/dashboard.js)
│  ├─ admin.html                 # staff dashboard (+ assets/admin.js)
│  ├─ assets/{app,account,dashboard,admin,download,theme}.js|css
│  ├─ config.js                  # committed: window.ALPHA_PLATFORM.apiBaseUrl
│  ├─ gen-config.mjs             # regenerates config.js from API_BASE_URL
│  └─ vercel.json
│
├─ product-skills/*.md           # 4 markdown "skills" injected into the system prompt
├─ .agents/skills/               # vendored Neon agent skills (reference only)
├─ skills-lock.json              # hashes of vendored skills
├─ scripts/*.mjs                 # ops tooling (deploy, migrate, verify, smoke, release)
├─ tests/*.test.ts               # 31 vitest suites
├─ docs/                         # architecture, handover, QA screenshots, platform docs
├─ build/                        # icon.ico, icon.png (packaging resources)
├─ electron-builder.yml          # NSIS + GitHub publish + alpha:// protocol
├─ neon.ts                       # Neon Function deploy config (env forwarding)
├─ electron.vite.config.ts       # aliases @shared/@main/@renderer, 3 bundles
├─ .env.example                  # every backend env var, documented
└─ package.json                  # scripts + deps
```

**Note:** `docs/platform/architecture.md` and `.gitignore` still reference an `admin/`
Vite app that is **not in this repo**. The admin surface now lives in `website/admin.html`
+ `website/assets/admin.js`. Treat the docs as partly stale; the code is authoritative.

---

## 3. Core Logic & Entry Points

### 3.1 Desktop startup sequence

Entry point: **`src/main/index.ts`** (`package.json` → `main: ./out/main/index.js`).

1. `app.requestSingleInstanceLock()` — second launches forward their argv as deep links.
2. `app.whenReady()` →
   - `app.setAppUserModelId(APP_ID)`
   - `hardenSession()` — installs the CSP header on every response; only `media` permission
     requests are granted.
   - `ctx = await buildContext(app.getPath('userData'), emit)` — **the DI root**.
   - `new BrowserPreviewService(...)`, then `registerIpc(ctx, browserPreview)`.
   - `app.setAsDefaultProtocolClient('alpha', ...)` for `alpha://` sign-in callbacks.
   - `createWindow()` — 1440×920, hidden title bar, theme tokens resolved *before* first paint.
   - `ctx.platform.restore()` — reload a persisted cloud session.
   - `setTimeout(4000) → ctx.updates.check()`.
3. `window-all-closed` → quit (non-mac); `before-quit` → `broker.rejectAll()` + `db.close()`.
4. `web-contents-created` — denies `window.open`, routes external `http(s)` to `shell.openExternal`,
   blocks `will-navigate`.

`buildContext()` (**`src/main/context.ts`**) is the assembly order that matters:

```
paths → logger → Db.open → SettingsRepo → Conversations/Projects/Providers repos
      → cipher (safeStorage | obfuscation) → SecretStore
      → ProviderRegistry(providersRepo, secrets)
      → GitHubOAuthService, ProjectService, CheckpointService, EditService,
        GitService, GithubService, PermissionService, TerminalService,
        SkillsService, ApprovalBroker, AttachmentService
      → registry.ensureLocalOllama(settings.ollamaUrl)      // first-run convenience
      → ChatService({... all of the above ...})
      → UpdateService, PlatformService
      → registry.attachGateway({ getToken, apiBaseUrl })   // cloud inference
      → OllamaManager
```

`syncGateway()` keeps a managed `gateway` provider ("Alpha Cloud") in the DB: created/enabled
while signed in, **removed on sign-out** (`ProviderRegistry.syncGateway`).

### 3.2 Renderer boot & state

- `src/renderer/src/main.tsx` → `App.tsx`.
- `App.tsx` calls `useApp.getState().init()` once. `init()` loads settings + layout, applies the
  theme, subscribes to `evt:*` streams, then loads providers/models/projects/conversations.
- Splash overlay: 1.6 s hold, 160 ms fade, hard 8 s cap (a bug here once left an invisible
  full-window overlay mounted — do not "simplify" the timer effect).
- **`useApp.ts` is the god-store**: ~170 members covering theme, providers/models, Ollama,
  conversations, projects, chat send/stop/approval, terminal, updates, platform session.
  `useWorkspace.ts` holds only explorer selection, file content, diff, search results.
- **`lib/api.ts`** wraps `window.alpha.invoke` with `IpcContract[K]` types, so adding an IPC
  channel and its contract keeps the renderer type-safe automatically.

### 3.3 The chat pipeline (the heart)

`ChatService.send()` → `ChatService.run()` in **`src/main/services/chat.ts`**.

```
send(input)                       // returns { requestId } immediately; run() is fire-and-forget
 └─ permissions.setMode(input.mode)
 └─ append user message; auto-title if "New chat" and first user turn
 └─ build provider messages:
       [system prompt] + selectHistory(last 20 msgs, 24k chars) + [user (+attachments)]
 └─ toolsEnabled = Boolean(projectId) && mode !== 'chat'
 └─ loop up to MAX_TOOL_ITERATIONS = 6:
       providers.chat(providerId, {model, messages, tools, signal, onDelta})
         → onDelta emits 'delta' / 'thinking' (first output timestamps TTFT)
         → if tools rejected by the model: retry once without tools
       if no toolCalls → break
       push assistant message with toolCalls
       runTools(...) → push one role:'tool' message per call
 └─ persist assistant message (content + ActivityItem[]) → emit 'done' + 'metrics'
```

Key behaviours to preserve:

- **History budget** is character-based (`MAX_HISTORY_CHARS = 24_000`), newest-first, always keeps
  the latest message. `MAX_HISTORY_MESSAGES = 20`, `MAX_MESSAGE_CHARS = 12_000`.
- **Parallel tool batching** (`isParallelSafeTool`): only read-only,
  non-approval, `permissionKey === 'read'`, category `read`|`git` tools may overlap. Identical
  calls in a round are de-duplicated by `toolCallKey`. Everything mutating stays serial in the
  model's original order.
- **Metrics** emitted per request: `promptMs`, `ttftMs`, `totalMs`, tokens, `tokensPerSecond`,
  `toolCalls`, `toolMs`, `historyMessages`.
- Cancellation is cooperative via a per-request `AbortController`; partial text is still persisted.

### 3.4 Permission & approval model

- Modes: `chat` (all mutating denied), `assist` (default: ask), `agent` (writes + terminal allow).
- Nine keys: `fileWrites`, `fileDeletes`, `terminal`, `packageInstall`, `network`, `gitCommit`,
  `githubPush`, `sensitiveFiles`, plus `mode`. Values `allow` | `ask` | `deny`.
  Live in **`src/shared/permissions.ts`** (`DEFAULT_PERMISSIONS`, `AGENT_PERMISSIONS`,
  `CHAT_PERMISSIONS`, `resolvePermission`).
- `sensitiveFiles` choice is deliberately preserved across mode switches.
- Tool flow (`ChatService.runTool`): resolve permission → `deny` returns an error to the model,
  `ask` calls `ApprovalBroker.request(approvalId)` which resolves only when the renderer answers
  via the `chat:approval` channel → then `executeTool`.
- Each tool call becomes an `ActivityItem` with states
  `proposed → awaiting-approval → running → completed | failed | cancelled`, streamed to the
  Activity panel over `evt:chat`.

---

## 4. Model & Tool Integration

### 4.1 Adapter contract — `src/main/services/providers/types.ts`

```ts
interface ProviderAdapter {
  kind: ProviderKind                       // 'ollama' | 'openai-compatible' | 'gateway'
  listModels(baseUrl, apiKey): Promise<ModelInfo[]>
  test(baseUrl, apiKey): Promise<ProviderStatus>
  chat(baseUrl, apiKey, req: ChatRequest): Promise<ChatResult>
  transcribe?(baseUrl, apiKey, req): Promise<string>
}
```

`ChatRequest` = `{ model, messages, tools?, signal, temperature?, onDelta? }`.
`onDelta` carries `{ content?: string, thinking?: string }` — **thinking/reasoning is a
first-class stream**, not content.
`ProviderError(message, code, status?)` is the single error type; `withTimeout()` composes
timeouts with the caller's `AbortSignal` via `AbortSignal.any`.

### 4.2 The three adapters

| Adapter | File | Wire protocol |
| --- | --- | --- |
| **Ollama (local)** | `providers/ollama.ts` | Native `/api/tags` for models, `/api/chat` with NDJSON streaming. Capabilities read from the tag's `capabilities[]` (`tools`, `vision`) with a name-based fallback. Supports `think`, keep-alive, preload. |
| **OpenAI-compatible** | `providers/openaiCompatible.ts` | `/models` + `/chat/completions` with SSE. Maps tool calls (`assistant.tool_calls` / `role:'tool'`), image parts (`image_url`), `reasoning_content` → thinking, and accumulates `index`-streamed tool-call fragments. Vision is inferred from the model id. Also implements `transcribe` (Whisper-style) for voice dictation. |
| **Alpha Cloud gateway** | `providers/gateway.ts` | OpenAI-compatible SSE against `{apiBaseUrl}/gateway/chat/completions`, authorized with the **platform access token** (`GatewayContext.getToken`). `parseGatewaySseLine()` is exported and unit-tested. Models come from `/gateway/models` (server decides what the plan allows). |

### 4.3 Registry & routing — `providers/registry.ts`

- `PROVIDER_PRESETS` (8): Ollama, OpenAI, OpenRouter, Groq, DeepSeek, Together, LM Studio, Custom.
  Each has `kind`, `baseUrl`, `needsKey`, `local`, `note`.
- Adapters are instantiated once in a `Record<ProviderKind, ProviderAdapter>`.
- **API keys are never stored in SQLite.** `secretRef(providerId) = provider:<id>:apiKey`, stored
  in `SecretStore`. The DB only keeps `hasApiKey: boolean`.
- `save()` re-validates the endpoint through `providerEndpointProblem()` (defence in depth against
  a bad IPC caller).
- `chat(providerId, req)` → `resolve()` → `adapter.chat(provider.baseUrl, apiKey, req)`.
  **There is no automatic cross-provider fallback** — the user picks the provider+model.
- `statuses()` does live probes and caches them; `cachedStatuses()` returns cache only (no I/O) —
  used to keep the UI responsive.
- `syncGateway()` / `attachGateway()` implement the Alpha Cloud lifecycle described in §3.1.

### 4.4 Tool system — `src/main/services/tools.ts`

Eight tools, declared as `TOOL_DEFINITIONS: ToolDefinition[]` (JSON-Schema parameters):

| Tool | Category | Approval | permissionKey |
| --- | --- | --- | --- |
| `list_project_files` | read | no | `read` |
| `search_project` (name or content) | read | no | `read` |
| `read_project_file` | read | no | `read` |
| `propose_file_patch` (`write` \| `patch`) | write | **no** (returns a diff + `proposalId`) | `read` |
| `apply_approved_patch` (by `proposalId`) | write | **yes** | `fileWrites` |
| `get_git_status` | git | no | `read` |
| `get_git_diff` | git | no | `read` |
| `run_approved_command` | execute | **yes** | `terminal` |

Design invariants:

- **Propose → approve → apply is two steps on purpose.** The proposal stores a `baseHash`; if the
  file changed on disk the result is flagged `stale`, and `apply` creates a **checkpoint first**.
- `READ_TOOLS` / `isParallelSafeTool()` gate concurrency.
- Tool results are JSON-stringified and **truncated** before going to the model
  (20 000 chars for results, 8 000 for diffs, last 8 000 of stdout/stderr).
- `executeTool()` is a plain `switch` — add a tool by adding a definition **and** a case; nothing
  else registers it.

### 4.5 Safety layers around tools

| Layer | File | What it enforces |
| --- | --- | --- |
| Path containment | `pathGuard.ts` | `safeResolve` (traversal, absolute escape, NUL), `assertInsideRoot` (realpath on nearest existing ancestor → **symlink escapes**) |
| Sensitive files | `pathGuard.ts` | `.env*`, `id_rsa`, `*.pem`, `*.key`, `.npmrc`, `.netrc`, `credentials`, `secrets.*`, `.aws/`, `.ssh/`, `.gnupg/` — denied unless `sensitiveFiles = allow` |
| Ignore rules | `ignoreRules.ts` | `.gitignore` semantics for tree/search |
| Command risk | `terminal.ts` | Regex classification: `DESTRUCTIVE_PATTERNS`, `INSTALL_PATTERNS`, `NETWORK_PATTERNS` → escalates the required permission. 512 KB stream cap. |
| Git safety | `git.ts` | **Never force-push**; explicit remote/branch operations only |
| Edit safety | `editService.ts` + `checkpoints.ts` | Atomic write, stale-file detection, pre-write backup, restore |

### 4.6 System prompt & skills

`ChatService.systemPrompt()` composes:
1. Identity ("You are Alpha…"), mode, and the `propose_file_patch → apply_approved_patch` rule
   ("never claim a file changed unless the tool result confirms it").
2. Project name + top-level entries (≤60) so the model has orientation without a read.
3. Provider name and local/cloud flag.
4. `SkillsService.promptContext()` — every enabled `product-skills/*.md` rendered as
   `### <name>\n<instructions>`.

`SkillsService` (`services/skills.ts`) parses YAML-style front matter (`id`, `name`,
`description`, `category`, `version`, `enabled-by-default`) from `product-skills/*.md`.
Packaged path: `process.resourcesPath/product-skills` (see `electron-builder.yml extraResources`).
Enable/disable state lives in `settings.skills.enabled`.

### 4.7 Attachments & voice

- `attachments.ts` — text passthrough, image refs, PDF via `pdf-parse`; `extractedText` is inlined
  into the user message by `buildUserContent()`.
- Voice: `voice:transcribe` IPC → `ProviderRegistry.transcribe(providerId, ...)` →
  the OpenAI-compatible adapter. Requires a configured transcription provider.

---

## 5. Backend contract (Alpha Cloud)

Deployed as one Neon Function: `neon.ts` → `functions.api` = `platform/api/index.ts`
(name `alpha-platform-api`). `neon.ts` forwards **only** env keys it lists *and* that are present,
so deleting a key from `.env.local` leaves the live value unchanged.

### Route map

| Mount | Auth | Routes |
| --- | --- | --- |
| `/` `/health` | none | liveness + branch |
| `/auth` | mixed | `POST /request`, `/verify`, `/register`, `/password`, `/password/forgot`, `/password/reset`, `/password/change`🔒, `/refresh`, `/oauth/exchange`, `/signout`🔒; `GET /providers`, `/google/start|callback`, `/github/start|callback`, `/status`; `GET/PATCH /me`🔒, `GET /sessions`🔒, `DELETE /sessions/:id`🔒, `POST /sessions/revoke-others`🔒 |
| `/platform` | required | `GET /config` (the `PlatformConfig` contract), `POST /device` |
| `/gateway` | required | `GET /models`, `GET /status`, `GET /activity`, `POST /chat/completions` |
| `/downloads` | required | `GET /latest` (gated: account status → email verified → maintenance → release) |
| `/admin` | per-RPC | metrics, overview, system, catalog, security, audit, downloads, ai/usage, users CRUD-ish, sessions, releases, providers, models, plans, flags, settings, announcements — all behind `public.require_admin` |

### Auth model

- Bearer **HS256 access JWT** (`AUTH_JWT_SECRET`, `jose`) with `sub`, `email`, `sid`, `role`;
  opaque **refresh token whose hash** lives in `sessions`. Raw tokens never persisted.
- `middleware.ts: requireAuth` verifies and sets `ctx.userId/email/sid`;
  `sessions.ts: requireLiveSession` additionally proves the session row is unrevoked.
- `platform/api/db.ts: withContext(userId, role, fn)` runs a transaction that
  `set_config('app.user_id'|'app.role', …, true)`, so every SQL function resolves the caller via
  `public.current_user_id()`. **This is the authorization mechanism** — not RLS alone.
- Desktop sign-in: `alpha://auth/callback` → `PlatformService.handleRedirectUrl()` →
  `EncryptedSessionStorage` (DPAPI-encrypted, inside `SecretStore`).

### Database contract

`public.get_my_platform_config()` returns the JSON consumed by the desktop app **and** the website
**and** the gateway. Its shape must stay in sync with `PlatformConfig` in `src/shared/types.ts`
(`account`, `plan`, `subscription`, `features`, `limits`, `usage`, `models`, `flags`,
`maintenance`, `announcements`, `desktop`, `serverTime`).
Changing one without the other breaks all three surfaces together.

Migrations are applied in filename order by `npm run db:migrate` (`scripts/db-migrate.mjs`);
`tests/migrations.test.ts` spins up **PGlite** and replays them.

### Ops scripts (`scripts/*.mjs`)

| Script | Purpose |
| --- | --- |
| `db-migrate.mjs` | apply `database/migrations/*.sql` |
| `deploy.mjs` | validate `.env.local` + deploy the Function (`--plan` = diff only) |
| `smoke.mjs` / `verify-auth.mjs` / `verify-admin.mjs` / `verify-website.mjs` | read-only live verification |
| `stub-platform-api.mjs` | local fake API for desktop dev without a deployment |
| `desktop-smoke.mjs`, `qa-shot.mjs` | Electron smoke test / screenshots |
| `admin-password.mjs`, `admin-grant.mjs` | seed admin credentials / roles directly in SQL |
| `register-release.mjs`, `ensure-release.mjs` | publish + register a release row |
| `envRules.mjs` | shared env validation rules (also unit-tested) |

---

## 6. How to extend (recipes)

### Add a chat tool
1. Add a definition to `TOOL_DEFINITIONS` in `src/main/services/tools.ts` (`category`,
   `requiresApproval`, `permissionKey`, JSON schema).
2. Add a `case` to `executeTool()` returning `{ result, summary }`.
3. If it may run in parallel, confirm `isParallelSafeTool()` picks it up (read + `read` key).
4. Add approval copy in `describeApproval()` when it mutates.
5. Test in `tests/chatPipeline.test.ts`.

### Add a provider adapter / preset
1. Implement `ProviderAdapter` next to the existing adapters (reuse `joinUrl`, `withTimeout`,
   `ProviderError`).
2. Add the `kind` to `ProviderKind` in `src/shared/types.ts` **and** to the adapter map in
   `ProviderRegistry`.
3. Add a `PROVIDER_PRESETS` entry; endpoint validation goes in `src/shared/providerUrl.ts`.
4. If it's a new `kind`, update `providerToolSupport()` and the UI's `ProvidersPage`.

### Add an IPC channel (renderer ↔ main)
1. `src/shared/channels.ts` → add to `CH` (invoke) or `EVENTS` (push). Both lists are the
   preload allow-lists.
2. `src/shared/ipc.ts` → add the request/response pair to `IpcContract`.
3. `src/shared/schemas.ts` → add a zod schema.
4. `src/main/ipc.ts` → `handle(CH.yourChannel, zYourSchema, fn)`.
5. `src/renderer/src/lib/api.ts` → expose a typed helper.

### Add a renderer page
1. New file in `src/renderer/src/pages/`.
2. Add the route to `View` in `store/useApp.ts` (`'home' | 'chat' | ...`).
3. Render it in `App.tsx`, add a `Sidebar` entry.

### Add a backend endpoint
1. New router file in `platform/api/` (follow `platform.ts`): `use('*', requireAuth, requireLiveSession)`.
2. Mount it in `platform/api/index.ts`.
3. Do work through `withContext()` so `current_user_id()` resolves.
4. If it needs schema, add `database/migrations/0007_*.sql` (additive only) and a test.
5. Contract change? Update `src/shared/types.ts` **and** the migration's SQL function together.

### Add a product skill
Drop a markdown file in `product-skills/` with the required front matter; it is auto-discovered
at startup. No code change.

---

## 7. Conventions & gotchas

- **Aliases:** `@shared/*` → `src/shared/*`, `@main/*` → `src/main/*`,
  `@renderer/*` → `src/renderer/src/*` (configured in `electron.vite.config.ts`, both tsconfigs,
  and `vitest.config.ts` — keep all three in sync).
- **Everything crossing IPC is zod-validated.** A handler without a schema is a code smell.
- **Secrets never touch SQLite, logs, or settings** — only `SecretStore`.
- **Anything a model can call must be safe on its own**, not just behind an approval prompt:
  path containment + sensitive-file denial are the last line of defence.
- **Local-first is a product promise.** No feature may require an account or network to work with
  Ollama; Alpha Cloud must stay strictly optional and removable.
- **Migrations are additive.** `tests/migrations.test.ts` replays every file; never edit an applied
  migration.
- **Comment style is explanatory**, often recording the bug a guard prevents. Keep that.
- **Windows-first:** path handling uses `path.win32` semantics implicitly; test both separators.
  `pathGuard` and `terminal` are the risky spots.
- **`HANDOVER_NOTE.md` (repo root) is explicitly marked stale** — do not act on it.
  Prefer `README.md`, `docs/platform/architecture.md`, and the code.

---

## 8. Quick-reference data flow

```
User types
  → Composer.tsx
  → useApp.send()
  → api.invoke('chat:send', {conversationId, providerId, modelId, mode, projectId, text})
  → ipc.ts (zChatSend)
  → ChatService.send() ──► providers.chat() ──► Ollama | OpenAI-compatible | Alpha Cloud
  │                          │                       (streaming deltas)
  │                          └─ tool_calls ──► tools.executeTool()
  │                                            ├─ projectService (root-confined fs)
  │                                            ├─ editService (+checkpoints)
  │                                            ├─ git / terminal
  │                                            └─ permissionService + ApprovalBroker
  │                                                  ↕ 'chat:approval'
  └─ emit('evt:chat', {delta|thinking|activity|tool-call|tool-result|done|error|metrics})
        → preload subscribe → useApp → MessageList / ActivityPanel / Inspector
        → conversations.append() in sql.js → persisted to alpha.db
```
