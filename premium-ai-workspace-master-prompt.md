# Master Build Prompt: Premium Local-First AI Coding Workspace

> **Use this prompt with a coding agent that can inspect and modify a software project.** It asks the agent to build the application, not just describe it. It is intentionally phased so a working, secure core is delivered before optional features expand the scope.

---

## 1. Role and execution contract

Act as an autonomous senior desktop-app engineering team: product-minded architect, Windows/Electron engineer, AI-provider integrator, application-security engineer, Git specialist, test engineer, and premium UI/UX designer.

Your assignment is to **inspect the current workspace and build a real Windows-first desktop application** for local and cloud AI-assisted software development. This is an implementation task. Do not stop after a proposal, architecture diagram, mock-up, or scaffold. Implement the highest-priority end-to-end workflows, run the available tests and build, fix failures, and report exactly what is and is not verified.

Work carefully in the existing repository:

- Inspect its files, scripts, runtime, package manager, dependencies, and current state before changing anything.
- Preserve useful work. Do not delete, overwrite, or replace existing project files blindly.
- If the workspace is empty, scaffold a clean application. If it already contains an app, extend it rather than creating a competing one.
- Make ordinary engineering and design decisions independently. Ask the owner only for a genuinely blocking decision, credential, permission, or irreversible action.
- Do not claim a feature, test, installer, model connection, file edit, Git operation, or upload succeeded unless it actually did.
- If a required live service or credential is unavailable, implement and test the safe parts with mocks where possible, then clearly mark live verification as blocked.
- Keep a concise implementation-status document in the repository and update it as the work progresses. Do not use that document as a substitute for implementation.

## 2. Product definition

Build a polished, local-first **AI coding workspace** for developers. It should take useful interaction patterns from OpenCode and other modern AI coding workspaces—sessions, model/provider selection, project context, visible agent activity, change review, and integrated development tools—without copying another product's name, branding, assets, or exact interface.

This application is the **desktop interface and secure tool layer**, not an AI model. The selected provider supplies model inference. The application gives the user a controlled way to chat, inspect a chosen project, propose and review file changes, run approved development commands, and work with Git.

### The owner’s starting point

- The target is a Windows desktop app, with Windows 10/11 as the first-class platform.
- The owner already has Ollama and a local Qwen 2.5 3B model. The actual Ollama model tag may differ; discover it instead of assuming a particular name.
- The owner also wants cloud models configured through API credentials and endpoints.
- Do not train, build, or bundle an AI model. Do not require downloading a model to use the app. Reuse the owner’s existing Ollama installation.

### Important model-discovery boundary

Automatically discover models that the configured Ollama service reports through its API. Refresh the list when the app starts, when the user revisits model/provider settings, when the app regains focus, and periodically while open (about every 30 seconds is reasonable), with a manual **Refresh models** action as well. A newly installed Ollama model should appear without an app restart when Ollama reports it.

Do **not** pretend the app can automatically find every model file installed anywhere on a computer. Models managed by another runtime must be exposed through a supported provider/endpoint or a future adapter. Do not scan arbitrary drives, guess model directories, or silently download, remove, or replace models. Explain this limitation plainly in the UI or documentation.

### Product boundaries

- This is an AI-assisted coding workspace, not a full replacement for Visual Studio Code or a general-purpose unrestricted shell.
- Focus on the conversation, project context, actual file changes, diffs, and approved development tasks. A lightweight code/file preview is sufficient; do not build a full IDE unless the existing project already provides one.
- Local Ollama inference should remain local when using a local Ollama endpoint. Cloud inference requires internet and sends requests to the selected provider.
- Model capabilities vary. Never promise tool calling, vision, audio, or a long context window unless the chosen provider/model supports it.
- Do not silently transmit project files, attachments, secrets, or conversation content to a cloud provider.

## 3. Product experience

Create an original, premium desktop interface: calm, precise, modern, and suitable for long coding sessions. Avoid a generic chatbot template, excessive gradients, clutter, oversized decoration, or controls that do nothing.

### Main workspace

Use a flexible layout with:

1. **Navigation/sidebar** — app identity, New Chat, conversation history, projects/workspaces, Models & Providers, GitHub/Git, Settings, and Help/Diagnostics.
2. **Conversation area** — readable user and assistant messages, streaming responses, Markdown and code rendering, copy controls, file references, and concise task summaries.
3. **Optional inspector/panel** — project explorer, changed files, diff review, agent activity, terminal output, test results, and Git status. Let the user collapse or resize panels where practical.
4. **Composer** — multiline prompt, attachment control when implemented, active project, selected provider/model, permission mode, send/stop controls, and clear busy/error states.

Include a discoverable command/search affordance and sensible keyboard shortcuts. Support Enter to send and Shift+Enter for a newline, while respecting platform conventions. Streaming must not freeze the interface. Show cancellation for requests that can be cancelled.

### Visual and accessibility requirements

- Provide a coherent dark theme and a usable light theme.
- Use consistent typography, spacing, icons, focus states, and design tokens.
- Provide resizable/collapsible panels where useful, with persisted layout preferences if practical.
- Use accessible labels, keyboard navigation, visible focus, and readable contrast.
- Include intentional first-run, empty, loading, disconnected, error, approval, success, and no-project states.
- Keep the app name, icon, and key visual tokens easy to change in one place.
- Do not add a microphone, attachment type, GitHub control, or other UI element as a nonfunctional placeholder. Either implement it or clearly defer/hide it.

## 4. Required first-release scope

Deliver a working vertical slice before broadening the feature set. A feature is complete only when its UI, backend behavior, permission checks, error handling, and relevant tests are present.

### A. Desktop foundation

- Use a maintained desktop framework and a clear main-process / renderer separation.
- Prefer **Electron + React + TypeScript + Vite** unless inspection reveals a strong reason to use Tauri or preserve a different existing stack.
- Use a small, maintainable component/design system. Tailwind or well-structured CSS modules are both acceptable.
- Use typed, validated IPC contracts. Do not let the renderer directly access Node, the filesystem, shell, credentials, or unrestricted network capabilities.
- Provide development scripts, a production build, Windows packaging configuration, app metadata, and practical run/build instructions.
- Keep the architecture modular: desktop shell, provider registry/adapters, conversation state, project/filesystem service, permission service, tool orchestration, Git service, persistence, and UI.

### B. Ollama: the top-priority inference path

Implement a real Ollama adapter using the current official Ollama API documentation. At minimum:

- Default to the usual local Ollama endpoint, while allowing the user to change it.
- Detect whether the endpoint is reachable and distinguish “Ollama is stopped/unreachable,” “no models installed,” “model not found,” timeout, and inference errors.
- Discover models from the running service dynamically; display actual names/tags and refresh as specified above.
- Allow model selection per conversation and a default-model preference. Show provider and connection status clearly.
- Send real chat requests, stream responses where supported, stop/cancel requests, handle malformed streams/timeouts, and preserve conversation state.
- Make no assumption that `qwen2.5:3b` is the exact tag. If the owner’s Qwen model is returned by Ollama, show it like every other discovered model.
- Never auto-pull or delete a model. If the service is unavailable, give concise recovery guidance without misrepresenting the status.
- Keep local inference local when the configured Ollama endpoint is local. If the owner points to a remote endpoint, disclose that it is remote.

### C. Cloud and custom API providers

Use a provider-adapter design so more integrations can be added without rebuilding chat or project features.

The first release must support at least one **working OpenAI-compatible chat-completions endpoint** with user-configurable base URL, API key, and model ID. Where practical, provide a convenient preset for a well-documented provider, but do not claim that every service labelled “OpenAI-compatible” behaves identically.

Provider settings must support:

- Add, edit, test, enable/disable, and remove a provider.
- Test credentials/endpoint and report actionable errors without exposing secrets.
- Discover models when the endpoint supports model listing; otherwise let the user enter a model ID manually.
- Select a provider and model per conversation.
- Stream and cancel responses when supported.
- Show which provider/model is selected and whether the request is local or cloud-based.

Keep credentials out of the renderer, ordinary logs, crash reports, prompts, and plaintext configuration. Prefer the operating system’s secure credential storage; in Electron, use a suitable OS-backed mechanism such as `safeStorage`/Windows DPAPI and handle unavailable encryption safely. Store only non-secret provider metadata in normal application settings/database. Mask credentials in the UI and provide replace/remove actions.

Do not send one provider’s credential to another provider. Validate URLs and TLS behavior. Permit a user-configured local endpoint when explicitly requested, but clearly identify the endpoint. Never hardcode API keys or require a live credential for the automated test suite.

### D. Projects and real file operations

- Provide a native **Open Project** / **Add Project** folder picker.
- Work in the chosen original directory; do not make an unrelated copy.
- Support multiple/recent projects, switching projects, and conversations associated with a project.
- Show a useful file tree and filename/content search. Handle large repositories without eagerly loading every file.
- Detect common project metadata (language, package/build/test manifests) as hints, not as certainty.
- Respect `.gitignore` where practical and conservatively skip dependency folders, build output, caches, VCS internals, and likely secrets.
- Do not include the whole repository in every request. Read only the files relevant to a task and show the user which project context is being used.

Implement a backend-owned file tool service for listing/searching/reading files and for preparing edits. Validate schemas and canonical paths on every request. Restrict operations to the selected project root; handle traversal, absolute paths, symlinks, missing files, permissions, large files, and binary files safely. Do not rely only on a UI check or string-prefix path check.

For code changes:

1. Have the model propose a structured edit/patch or a complete replacement for explicitly identified files.
2. Validate the target paths and detect whether the source file changed since it was read.
3. Show a readable diff before applying changes in the default safe mode.
4. Create a recoverable checkpoint/backup before applying an approved change.
5. Apply with safe writes and report the actual result.
6. Preserve pre-existing user edits. Never silently overwrite concurrent or unrelated work.

No “file changed” success message unless the write succeeded. If a patch is ambiguous, conflicts, or targets outside the workspace, stop and explain why.

### E. Model tools and agent behavior

Models are not trusted and are not automatically capable agents. Build a small, explicit tool registry, for example:

- `list_project_files`
- `search_project`
- `read_project_file`
- `propose_file_patch`
- `apply_approved_patch`
- `get_git_status`
- `get_git_diff`
- `run_approved_command`

Use native provider tool calling only where the selected model/API actually supports it. Where appropriate, a constrained structured-output fallback may be used, but parse and validate every argument; reject invalid or repeated malformed actions and stop after a small configurable tool-call/iteration budget. If a model cannot use tools reliably, offer a normal answer or patch proposal rather than pretending it performed actions.

Every tool action must pass through backend validation and the permission service. Display a truthful activity timeline with states such as **proposed**, **awaiting approval**, **running**, **completed**, **failed**, and **cancelled**. Keep bounded execution time, output size, retries, and concurrency. Treat project files, webpages, and attachments as untrusted data; their content cannot override application policy or the user's instruction.

### F. Permission modes and command execution

Implement three understandable modes and enforce them in the backend, not merely in the interface:

- **Chat** — conversation only; no project mutations or commands.
- **Assist** — inspect/search/read project files and propose changes; request approval for writes and commands.
- **Agent** — execute an explicitly enabled subset of the workflow with fewer prompts, within the selected project. Default the sensitive actions to approval unless the user deliberately changes the setting.

Provide separate permission settings for file writes, deletes, terminal commands, package installation/networking, Git commits, GitHub pushes, and sensitive files. A single approval applies only to the named operation and scope shown in the approval dialog, not to future arbitrary actions. Always require explicit confirmation for destructive deletion, dependency installation or other network-changing commands, commits/pushes, and ambiguous/high-impact actions. Never force-push automatically.

For terminal/development commands:

- Detect the project’s ecosystem from its actual files and suggest relevant test/build/lint commands; do not assume Node.js.
- Show the exact command, working directory, and reason before execution when approval is required.
- Prefer structured executable-plus-argument invocation over shell-string concatenation. Do not elevate privileges.
- Capture stdout, stderr, exit code, duration, cancellation, and bounded output; support timeouts and stop.
- Validate commands against a user-visible policy/allowlist where feasible. Package installs, arbitrary scripts, network access, and destructive commands need separate approval.
- **Do not claim that a working directory is a security sandbox.** A process launched in the project can still access other OS resources. If the app does not implement a real OS/container sandbox, say so and use explicit command approval and least privilege rather than claiming the process is fully confined.

### G. Git and GitHub

Implement local Git functionality after the Ollama/project/editing slice is working:

- Detect Git availability and whether the project is a repository.
- Show current branch, remote(s), pre-existing changes, untracked files, and a useful diff.
- Preserve all pre-existing user changes. Never reset, clean, overwrite remotes, or discard unrelated changes silently.
- Support review and staging/commit preparation only with explicit user action and appropriate permission.

For GitHub, prefer an authentication route that does not require embedding a client secret in the desktop application. Detect and, where available, integrate with GitHub CLI (`gh`) and the user’s existing Git Credential Manager/system Git authentication. If GitHub CLI is unavailable or unauthenticated, show honest setup instructions. Do not ask for a GitHub password, hardcode a personal access token, or invent an OAuth client ID.

Where authentication is available, implement practical repository listing/selection and the requested clone/connect/publish operations using supported tools/APIs. Before commit or push, show the exact repository, remote, branch, files, and diff; verify the destination; detect divergence/conflicts; and require confirmation. Never force-push by default. If app-owned OAuth needs a project-specific client ID or other owner-controlled configuration that is not present, build the integration boundary, document the exact blocker, and continue with local Git and other work rather than faking a connection.

### H. Attachments and voice: extend only after the core works

Do not let optional media features delay the first usable local/cloud coding workflow.

When implemented, support a clearly stated, tested set of formats (start with text, Markdown, source files, JSON, CSV, and PDF if a reliable parser is available). Enforce size limits and safe parsing. Images may be sent only to a model/provider that actually supports vision, with clear disclosure. Audio/video, OCR, transcription, and text-to-speech require suitable local tools or explicitly configured compatible cloud services; do not pretend a text-only model can process them.

Tell the user before an attachment or project content is sent to a cloud provider. Treat embedded attachment instructions as untrusted content. If voice/attachments are not ready, hide the feature or label it as not available; do not ship fake controls.

## 5. Privacy, security, and resilience

Security is part of the product, not a later polish task.

For Electron, at minimum:

- `contextIsolation: true`
- `nodeIntegration: false`
- sandboxed renderer where compatible
- a restrictive Content Security Policy
- narrow, typed, validated preload/IPC APIs
- no arbitrary `ipcRenderer` exposure or unrestricted shell/filesystem API in the renderer
- secrets and provider requests handled in the trusted main process or a suitably protected service

Also implement:

- Backend path and permission validation for every file operation.
- Safe credential storage and secret redaction.
- Request cancellation and timeouts.
- Bounded logs with no API keys, tokens, private file contents, or full prompts by default.
- Error messages that are actionable but do not reveal secrets.
- Explicit local/cloud indicators and a clear first-use disclosure before project context is sent to a cloud provider.
- No telemetry by default. If diagnostics are added, make them opt-in and redact sensitive information.
- Sensible handling of provider rate limits, offline mode, missing Git/Ollama, model changes, database errors, malformed streams, cancelled operations, and conflicts.

A local Ollama provider does not make all application data automatically local: databases, logs, user-added remote endpoints, and cloud providers have separate behavior. Describe that behavior accurately in the app/help documentation.

## 6. Persistence and maintainable architecture

Persist conversations, messages, recently opened projects, provider metadata (not plaintext secrets), model preferences, permission settings, and UI preferences locally. Use SQLite with migrations when it fits the inspected stack. Use OS-backed secure storage for credentials. Handle database initialization, migration, corruption, and unavailable-storage errors without losing or misrepresenting user work.

Suggested architecture (adapt to the existing repository; do not force a rewrite to match this exact tree):

```text
src/
  main/          desktop lifecycle, IPC, secure services
  preload/       narrow typed bridge
  renderer/      React UI and interaction state
  shared/        schemas, types, permission contracts
  services/      providers, projects, tools, Git, persistence
  tests/         unit and integration tests
```

Keep provider adapters behind a common interface for model listing, chat streaming, cancellation, and reported capabilities. Keep project/file/Git/command services independent of UI components. Validate public inputs with a schema library or equivalent. Avoid monolithic components and needless dependencies.

## 7. Implementation order and release gates

Proceed in this order. After each gate, run relevant tests/build checks and fix failures before expanding scope. Do not stop at the gate plan.

### Gate 0 — Inspect and establish baseline

- Inspect repository, operating system, available runtimes, package manager, build tools, and existing tests.
- Record the current state and any constraints.
- Choose the stack based on evidence and document concise architecture decisions.

### Gate 1 — Desktop shell and real local chat

- Create or adapt the desktop window, secure process boundary, navigation, theme tokens, conversation view, and composer.
- Implement Ollama health check, model discovery, selection, real streaming chat, cancellation, and useful errors.
- Verify the installed Qwen model appears if Ollama reports it. If Ollama is unavailable in the build environment, verify with HTTP mocks and state that live inference was not verified.

### Gate 2 — Persistence and provider management

- Persist chats/settings.
- Add secure credential storage and the OpenAI-compatible provider adapter.
- Test one real cloud response only if credentials are provided; otherwise test the adapter with mocks and report that live credentials were unavailable.

### Gate 3 — Real project workflow

- Add native folder selection, recent projects, tree/search/read, root/path validation, context selection, and secret protection.
- Add structured patch proposals, diff review, conflict detection, checkpoint/backup, and safe apply.
- Demonstrate on a temporary fixture project without touching unrelated user files.

### Gate 4 — Permissions, commands, and local Git

- Enforce Chat/Assist/Agent permissions in the trusted backend.
- Add approved command execution with output, cancellation, timeouts, and limits.
- Add local Git status/diff and safe commit preparation.

### Gate 5 — GitHub and optional product extensions

- Add GitHub repository discovery/publishing through a supported, honestly configured authentication path.
- Add attachments/voice only after core gates pass and only for real supported processing paths.
- Add further provider adapters as separate modules, not as hardcoded UI-only entries.

### Gate 6 — Polish, verification, and Windows packaging

- Finish loading/error/empty/approval states, accessibility, keyboard behavior, diagnostics, documentation, icons/metadata, and packaging configuration.
- Run the test suite and production build. Produce the Windows installer/package if the current host/toolchain permits.
- If the environment is not Windows and a Windows installer cannot be produced or executed there, build what is possible, verify the packaging configuration, and explicitly state what still needs verification on Windows. Never call an unbuilt installer complete.

## 8. Testing and acceptance criteria

Write meaningful automated tests for the highest-risk behavior. The normal test suite must not require internet, live API keys, GitHub credentials, or a running Ollama instance.

At minimum, test:

- Ollama model discovery, empty/unavailable service states, streaming parsing, cancellation, and errors using a mock server.
- Provider configuration, model selection, cloud stream parsing, invalid credentials, and secret redaction.
- Conversation persistence and migrations.
- Folder/path containment, symlink escape cases, ignored and sensitive files, and project-root changes.
- Safe file edits, diff generation, checkpointing, stale-file conflicts, and permission denial.
- Tool schema validation, tool-call limits, untrusted model output, and permission enforcement.
- Command approval, argument handling, timeouts, cancellation, output bounds, and exit-code reporting.
- Git status/diff handling and safeguards that prevent unintended reset/force-push or remote replacement.
- Attachment parsing only for formats actually implemented.

Use temporary test fixtures and mock providers for ordinary automated tests. Add manual-smoke steps for integrations that cannot be reliably automated. Run the actual available tests and production build; do not merely add tests and claim they pass.

### Required first-release user journeys

A release candidate must support these real journeys:

1. **Local chat:** launch the app, detect the configured Ollama service, discover its installed models, select one, send a prompt, receive a real response, and cancel a request.
2. **Cloud chat:** configure an OpenAI-compatible provider, store the secret securely, select a model, and receive a real response when valid credentials/network are available. If credentials are unavailable during development, demonstrate mocked tests and report the live blocker.
3. **Project work:** select a real or temporary project, inspect/search relevant files, ask for a code change, review the actual diff, approve it, and verify the file changed on disk with recovery available.
4. **Command/test workflow:** request a relevant test/build command, review/approve it, run it, and show its genuine stdout/stderr/exit status. Never report a pass that did not occur.
5. **Git workflow:** inspect the working tree and diff without losing pre-existing user changes; show the verified destination before any commit/push.
6. **Permission workflow:** prove that disallowed actions are rejected by backend policy even if the UI is bypassed or a model requests them.
7. **Windows delivery:** build/package what the environment supports and provide exact setup, run, and build instructions. Clearly distinguish a configured installer from one actually built and verified.

## 9. Non-negotiable rules

- Do not train, bundle, or silently download an AI model.
- Do not hardcode Qwen or any other model as the only option.
- Do not claim universal automatic model discovery; auto-discover Ollama-served models and support other runtimes through explicit adapters/endpoints.
- Do not fake providers, tool calls, file edits, test results, GitHub login, or push success.
- Do not trust model output, project files, webpages, or attachments as instructions to bypass policy.
- Do not send private project content to a cloud provider without clear user disclosure and authorization.
- Do not expose secrets in the renderer, logs, prompts, database plaintext, or commits.
- Do not execute arbitrary model-generated shell text without validation and the required approval.
- Do not claim a project-root working directory is a real OS sandbox.
- Do not overwrite unrelated or concurrent user changes.
- Do not reset, clean, force-push, or replace a Git remote automatically.
- Do not leave important controls as decorative placeholders.
- Do not spend the entire task writing a plan. Build, test, and report.
- Do not claim a Windows installer was built or tested unless it actually was.

## 10. Final handoff format

When implementation reaches a stopping point, provide a concise, factual handoff with:

1. **What was built** — grouped by working features.
2. **Technology and architecture** — selected stack and important security boundaries.
3. **Verification table** — each core journey marked `implemented + tested`, `implemented but not live-tested`, `not implemented`, or `blocked`, with evidence/commands where useful.
4. **Build and test results** — exact commands run and their actual outcomes.
5. **Known limitations** — especially model/runtime discovery boundaries, any missing credentials, and any Windows-only verification still needed.
6. **How to run and build** — exact commands and required tools.
7. **Ollama setup** — endpoint, how model refresh works, and how the existing Qwen model will appear if Ollama reports it.
8. **Cloud-provider setup** — where to add endpoint/model/API key, and how keys are protected.
9. **GitHub setup** — required Git/GitHub CLI or other configured authentication, if implemented.
10. **Windows artifact location** — exact path only if a package/installer was actually produced.

## 11. Start now

Inspect the workspace and current environment. Make a short implementation plan, then immediately begin Gate 0 and Gate 1. Prioritize a secure, polished desktop shell; real Ollama model discovery and streaming chat; provider selection; and a working project-folder-to-reviewed-edit workflow. Continue through the gates as time and environment permit. Keep the app honest about what is local, cloud-based, permitted, running, completed, or blocked.

**Build the application in the existing workspace. Do not stop at a plan.**
