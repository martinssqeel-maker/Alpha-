# ADMIN/SAAS CLEANUP HANDOVER

## Goal
Remove Admin Dashboard, SaaS infrastructure, unnecessary auth per new direction. Keep Website landing + AI Workspace. Use Google OAuth only if auth required.

## Current state (verified)
- Repo: main @ 4c4321a, working tree has uncommitted files from recovery (notably HANDOVER_NOTE.md, docs/handover/* added)
- Admin: admin/ exists (built to call Neon API /admin/rpc)
- Backend: platform/api/admin.ts exists; platform/api/adminSignatures.ts exists
- DB/migrations: supabase/migrations/20240101000000_platform.sql has admin tables, roles, SaaS tables (plans, subscriptions, etc.)
- Website: has account.html (account portal), index.html (landing)
- Desktop: AI Workspace code intact; platform service uses Neon API
- Tests: 46/46 passing after recovery fixes

## Candidates for removal (admin/SaaS)
- admin/ (entire dashboard)
- platform/api/admin.ts, platform/api/adminSignatures.ts, admin routes mounted in index.ts?
- supabase/ (legacy, superseded by Neon but contains migrations/schema for SaaS/admin)
- website/account.html and related account.js? Check if workspace requires
- Any auth UI beyond Google-only if needed

## Approach
1. Inspect dependencies: does AI Workspace require platform/config, auth for itself? Desktop platform service authenticates user to access cloud models via API. But prompt says "if auth not required by workspace, remove completely; if required, use Google OAuth only".
2. Check platform/api/auth.ts - it's email OTP auth (current). Need to see if workspace needs it.
3. If workspace needs cloud models via API, it needs auth token. Can we simplify to Google OAuth? Need to understand API's auth model.
4. But safer: identify actual usage, don't break working features.
5. Remove admin/, admin routes, admin signatures, website/account.html if not needed by landing+workspace flow.
