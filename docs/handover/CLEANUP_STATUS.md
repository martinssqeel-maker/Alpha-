# CLEANUP STATUS (Admin/SaaS removal)

## Completed
- Removed admin/ directory
- Removed platform/api/admin.ts, adminSignatures.ts
- Removed /admin routes from API
- Removed supabase/ (legacy)
- Removed website/account.html, website/assets/account.js
- Preserved website/index.html (landing), download.html
- Preserved AI Workspace (src/, platform/api/* core)
- Preserved database/migrations/, neon.ts, scripts

## Auth decision
- Auth is required for cloud features (gateway/platform). 
- API has Google OAuth + OTP + password. Desktop uses OTP.
- Converting to Google OAuth only requires changing desktop sign-in flow + potentially API surface. This is a functional change beyond just removal.
- To avoid breaking workspace, keeping existing auth working but removed admin/SaaS-specific auth complexity. OTP remains as working path for personal use case.
- Marked as DEFERRED: full Google OAuth-only switch needs coordinated changes across API, desktop, website. Can be done separately without breaking workspace.

## Tests
- Ran tests: 46/46 passing
- Typecheck/build pass
