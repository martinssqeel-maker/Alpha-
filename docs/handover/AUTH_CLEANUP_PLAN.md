# AUTH CLEANUP PLAN

## Decision
Workspace needs auth for cloud features (gateway/platform config). So auth is required. Use Google OAuth only. Remove OTP/email/password paths for user auth where not needed. Keep minimal auth that works with existing API contract or adapt desktop.

## Remove (Admin/SaaS specific)
- Admin dashboard (admin/)
- platform/api/admin.ts, platform/api/adminSignatures.ts, admin routes mounted
- website/account.html (SaaS account portal) - keep landing index.html
- supabase/ (legacy) - contains admin/SaaS schema; but Neon is source of truth now. Need to be careful not to break DB.
- Admin-specific UI/routes

## Preserve
- Website landing (index.html, download.html)
- AI Workspace (src/, desktop app)
- Core platform API (platform/api/platform.ts, gateway.ts, auth with Google OAuth)
- Database schema needed for workspace (users, sessions, plans if needed for entitlements)

But auth.ts currently has OTP + Google + password. Simplify to Google OAuth only for user sign-in.
