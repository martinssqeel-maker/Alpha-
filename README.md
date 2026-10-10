# Alpha AI Workspace

A premium, local-first Windows desktop AI development environment. Alpha AI Workspace
connects to your **existing Ollama** installation (and optional cloud providers), opens
real project folders, performs **controlled** file edits, runs dev commands, and manages
Git/GitHub — all behind an explicit permission and approval model.

- **Stack:** Electron 44 + React 19 + TypeScript + Vite (via `electron-vite`)
- **Persistence:** `sql.js` (WASM SQLite) — no native rebuilds required
- **Secrets:** Electron `safeStorage` (Windows DPAPI) with an obfuscation fallback

---

## Highlights

- **Bring your own models.** Auto-discovers models from a local Ollama server
  (streaming, thinking, native tool calling) and supports any OpenAI-compatible
  endpoint (OpenAI, OpenRouter, Groq, DeepSeek, Together, LM Studio, custom).
- **Agentic, but safe.** A permission system (`chat` / `assist` / `agent` modes with
  per-capability `allow` / `ask` / `deny` levels) gates every file write, delete,
  command, package install, network call, commit, and push.
- **Approvals.** Risky actions surface an approval dialog and are only executed once
  you accept.
- **Project-aware.** File access is confined to the opened project root. Path
  traversal and symlink escapes are blocked; sensitive files (`.env`, keys,
  credentials, `.ssh`, `.aws`, …) are denied by default.
- **Real editing.** Unified diffs, checkpoint/restore, atomic writes with stale-file
  conflict detection.
- **Integrated tools.** Streaming terminal with risk assessment, Git panel
  (status/diff/stage/commit/branch/push/pull — **never force-push**), GitHub repo
  browsing/creation, and ecosystem/script detection for tests and builds.
- **Attachments & voice.** Drag-and-drop text/image analysis, PDF extraction, and
  microphone dictation via a configured transcription provider.

---

## Requirements

- **Windows 10/11 (x64)**
- **Node.js 20+** (developed/tested on Node 24) and npm
- **Ollama** running locally (default `http://127.0.0.1:11434`) — optional; cloud
  providers can be used instead
- **Git** on `PATH` for source control features (optional)
- **GitHub CLI (`gh`)** — optional, used automatically when present and authenticated

Verify Ollama:

```powershell
curl http://127.0.0.1:11434/api/version
curl http://127.0.0.1:11434/api/tags
```

---

## Getting started

```powershell
npm install
```

> **Note:** npm 11 blocks dependency install scripts by default. If the Electron
> binary is missing after install, run once:
>
> ```powershell
> node "node_modules\electron\install.js"
> ```

Run in development:

```powershell
npm run dev
```

First launch: open a project folder (Projects tab), pick a model in the composer
footer, choose a mode, and start chatting.

---

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Launch the app in development with hot reload |
| `npm run build` | Build main / preload / renderer bundles into `out/` |
| `npm start` | Preview the production build |
| `npm run typecheck` | Type-check main and renderer (`tsc --noEmit`) |
| `npm test` | Run the Vitest suite |
| `npm run test:watch` | Run tests in watch mode |
| `npm run dist` | Build and create the Windows NSIS installer (`release/`) |
| `npm run dist:dir` | Build an unpacked app directory (`release/win-unpacked/`) |
| `npm run release` | Build and publish the installer to GitHub Releases (requires `GH_TOKEN`) |
| `node scripts/make-icon.cjs` | Regenerate `build/icon.ico` |

---

## Using the app

1. **Open a project** — Projects tab → *Open folder*. This grants controlled,
   root-confined access to that folder.
2. **Pick a model** — the composer footer lists models per provider (local vs cloud,
   with capability badges such as `tools` / `vision`).
3. **Choose a mode** — Chat, Assist, or Agent:
   - **Chat** — conversation only; all mutating actions are disabled.
   - **Assist** — read and propose; changes require approval.
   - **Agent** — autonomous multi-step tasks within safer defaults.
4. **Work with tools** — watch tool activity in the inspector; approve or deny
   actions when prompted.
5. **Review & commit** — inspect diffs in Changes/Diff, then stage and commit in Git.

### Inspector tabs

`Explorer` · `Changes` · `Diff` · `Activity` · `Terminal` · `Tests` · `Git`

---

## Permissions

Each capability is set to `allow`, `ask`, or `deny`. In `chat` mode every mutating
capability is denied regardless of stored levels.

| Key | Controls |
| --- | --- |
| `fileWrites` | Create / modify files |
| `fileDeletes` | Delete files |
| `terminal` | Run shell commands in the project |
| `packageInstall` | npm/pip/other package managers |
| `network` | Commands that reach the network |
| `gitCommit` | Stage and commit |
| `githubPush` | Push to a remote |
| `sensitiveFiles` | `.env`, keys, credentials (`deny` by default) |

---

## Providers

**Local (Ollama):** discovered automatically. The default URL is editable in Settings.

**Cloud / OpenAI-compatible presets:** OpenAI, OpenRouter, Groq, DeepSeek, Together AI,
LM Studio, or a custom base URL. API keys are stored via OS-level encryption and are
never written to logs.

Cloud providers receive your prompts. Acknowledge the context-disclosure setting in
Settings before using non-local models.

---

## Security model

- `contextIsolation: true`, `nodeIntegration: false`; the renderer talks to the main
  process only through an allow-listed IPC bridge (`window.alpha`).
- A Content-Security-Policy is applied in production (strict) and relaxed only in dev.
- File system access is root-confined with traversal and symlink-escape protection.
- Sensitive files are denied by default; secrets are redacted from logs.
- Force-push is never performed.

---

## Architecture

```
src/
  shared/        Types, IPC contract, channel allow-list, zod schemas, permissions
  preload/       contextBridge surface (window.alpha: invoke + subscribe)
  main/
    services/    logger, db (sql.js), secrets, store, pathGuard, ignoreRules,
                 checkpoints, projectService, editService, permissionService,
                 terminal, git, github, attachments, tools, chat
    providers/   ollama, openai-compatible, registry
    context.ts   service wiring
    ipc.ts       IPC handlers (validated with zod)
    index.ts     window creation, CSP, hardening
  renderer/src/
    components/  UI building blocks + inspector panels
    pages/       Chat, Models, Providers, Projects, GitHub, Settings, Help
    store/       zustand stores (useApp, useWorkspace)
    lib/api.ts   typed IPC client
```

Data (SQLite DB + logs) lives under `%APPDATA%\alpha-ai-workspace`.

---

## Testing

```powershell
npm test
```

Covers permission resolution and mode enforcement, path containment/traversal
guards, sensitive/git-internal detection, and the Ollama / OpenAI-compatible
adapters (streaming, tool-call accumulation, error mapping) with mocked `fetch`.

---

## Releasing & auto-update

The app is configured for **auto-update via GitHub Releases** using
`electron-updater`. Update checks run a few seconds after launch (packaged builds
only) and can also be triggered from **Settings → Updates**.

1. **Publish target.** `electron-builder.yml` is preconfigured to publish to
   `martinssqeel-maker/Alpha-`. Change `publish.owner` / `publish.repo` if your
   release repository differs. The repo must exist before the first release.
2. **(First release) create the repo and upload once manually.** Create a GitHub
   repo, bump `version` in `package.json`, then build and publish:

   ```powershell
   $env:GH_TOKEN = "ghp_your_token_with_repo_scope"
   npm run release
   ```

   This builds the NSIS installer, generates `latest.yml`, and attaches both to a
   new GitHub *release*. Installed copies will pick it up automatically.

3. **Subsequent releases.** Bump `version` and run `npm run release` again. The
   `GH_TOKEN` needs `repo` scope (classic) or `Contents: read/write` (fine-grained).

### Code signing (optional)

Builds are currently **unsigned**, so Windows SmartScreen shows a warning on first
run. To sign later, provide a certificate to `electron-builder` via environment
variables — no config change is needed:

```powershell
$env:CSC_LINK = "C:\path\to\cert.pfx"        # or a base64-encoded pfx
$env:CSC_KEY_PASSWORD = "your-password"
npm run dist
```

For a hardware/EV token, configure a custom `sign` command under `win:` in
`electron-builder.yml`. Signed builds avoid SmartScreen warnings and are required
by the auto-updater on some managed machines.

---

## License

MIT
