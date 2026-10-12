# PROJECT OVERVIEW

## Purpose
Alpha AI Workspace is an Electron desktop application (Windows) paired with a website (Vercel) providing a unified AI workspace experience with accounts, plans/entitlements, and cloud model access.

## Current Status
- Desktop app: Opens but workspace appears frozen/controls not clickable (issue reported after new build)
- Website: Configured for Neon Function API
- Admin Dashboard: Present, built to use Neon Function API (/admin/rpc)
- Backend: Neon Postgres + Neon Function (Hono) API as source of truth (migrated from Supabase)
- Git: main branch, commit 4c4321a (Neon migration), working tree clean

## Technology Stack
- Desktop: Electron 44, React 19, TypeScript, Vite (electron-vite), Tailwind CSS
- Main process: Node/Electron IPC, platform service (Neon REST API)
- Renderer: React 19 with Zustand store
- Backend: Hono on Neon Function, pg client, JWT auth (HS256)
- DB: Neon Postgres (schema in database/migrations/0001_platform.sql)
- Website: Static HTML/JS (Vercel), uses Neon API
- Admin: Vite + React, uses Neon API (/admin/rpc)
- Build: electron-vite, electron-builder (alpha:// protocol)
- Testing: Vitest (43 tests passing)
