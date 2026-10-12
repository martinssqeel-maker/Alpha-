# Handover documents

> This file used to be a two-line UTF-16 stub that most tools could not read. It is now
> a normal UTF-8 index. If you are picking this project up, read the files in the order
> below.

| Document | Read it for |
| --- | --- |
| [`RECOVERY_REPORT.md`](RECOVERY_REPORT.md) | **Start here.** The authoritative state of the migration: what was verified, what failed, what was fixed, and what still needs a human. Every claim is marked verified / failed / NOT RUN. |
| [`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md) | One-page summary of purpose, stack and current status. |
| [`HANDOVER_SUMMARY.md`](HANDOVER_SUMMARY.md) | Quick facts, the reported "frozen desktop" issue and the fixes applied. |
| [`../platform/architecture.md`](../platform/architecture.md) | How the three surfaces and the Neon backend fit together, and the security model. |
| [`../platform/environment.md`](../platform/environment.md) | Deploying the Function, env vars, website/admin/desktop configuration. |
| [`../platform/verification.md`](../platform/verification.md) | How to verify a change locally and against the live API. |
| [`../platform/MANUAL-TODO.md`](../platform/MANUAL-TODO.md) | The ordered go-live runbook — everything that needs an account or secret holder. |

## Where the project actually is

- **Backend:** Neon Postgres + one Neon Function (`platform/api`, Hono) as the single
  source of truth. The Supabase era is over; `supabase/` is dead code kept only as
  history (see the *Legacy* section of the architecture doc).
- **Desktop:** Electron 44 + React 19, talking to the Function over REST with a bearer
  token. Local Ollama stays fully offline.
- **Website:** static, on Vercel, `API_BASE_URL` → the Function.
- **Admin:** separate Vite/React app, `VITE_API_BASE_URL` → the Function.

## Verify a change before trusting it

```bash
npm run typecheck && npm test && npm run build
npm run deploy -- --check     # validate .env.local without deploying
npm run smoke                 # read-only live API check
```

CI runs the first line on every push and pull request.

## Cautions

- The GitHub `v1.0.3` release artifacts are **pre-migration** and cannot work with the
  current platform contract. Build from source (`npm run dist`) instead —
  see `RECOVERY_REPORT.md` §3.
- Never delete a key from `.env.local` to disable it; `neon.ts` only forwards keys that
  are present, so the live value survives. Set it to `0` instead.
