# HANDOVER NOTE

> **CORRECTIONS — this note predates the recovery pass. Do not act on it as written.**
> See [docs/handover/RECOVERY_REPORT.md](docs/handover/RECOVERY_REPORT.md), which tests
> every claim below and marks it verified / failed / NOT RUN.
>
> - The working tree is **not** clean, and the "frozen desktop" cause described below was
>   **not reproduced**. The real defect was a cached `PlatformStatus`; it is fixed, with
>   regression tests.
> - Do **not** install the GitHub `v1.0.3` release. Those assets are pre-migration and
>   cannot work with the current platform contract. Build from source: `npm run dist`.
> - `px electron out/main/index.js` is not a valid command, and running unpackaged uses a
>   different userData directory than the installed app. Use `npm run dev` or the packaged
>   build.
> - The listed manual TODO is out of date: the sign-in-token leak is closed and deployed,
>   but no provider credentials are configured, so cloud chat returns 502. For the current
>   list use [docs/platform/MANUAL-TODO.md](docs/platform/MANUAL-TODO.md).
> - Deploy with `npm run deploy`, **not** `neon deploy --env .env.local`, which is broken on
>   CLI 8.3.5.

## Status
- Migrated desktop/website/admin to Neon Function API (REST). Platform contract changed to { enabled, apiBaseUrl, authRedirectScheme }.
- Backend: Neon Postgres + Hono Function at https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech
- Git: main @ 4c4321a (pushed). Working tree clean. Tests 43/43 passing, typecheck/build pass.
- Website/configs/admin built. New unpacked build in out/.

## Root Cause of "frozen" desktop
Running the old packaged build (v1.0.2) with the new migrated codebase causes IPC/platform contract mismatch (old renderer expects old platform shape). The UI appears unresponsive. Fix: run the new build.

## Quick Fix
1. Run unpacked with new build: 
px electron out/main/index.js from project root (ALPHA)
2. Or build new installer: 
px electron-vite build && npx electron-builder --win --publish never
3. Configure Settings ? Alpha Cloud (platform): enable + API base URL https://br-flat-morning-b41hcfhc-api.compute.c-6.us-east-2.aws.neon.tech
4. Sign in via Account (OTP/magic link)

## MANUAL-TODO done/remaining
- Done: Neon MCP key revoked, GH_TOKEN set, API auth verified
- Remaining: install v1.0.3 or new build, configure API, sign in, smoke tests

## Files changed (key)
- src/main/services/platform.ts (Neon REST)
- src/main/services/providers/gateway.ts (REST to /gateway/*)
- src/shared/types.ts (platform shape)
- src/renderer/src/pages/SettingsPage.tsx, src/renderer/src/components/AccountModal.tsx
- website/assets/account.js, website/gen-config.mjs
- admin/src/supabase.ts (API client)
- platform/api/* deployed
