// Environment helpers. Values are injected at runtime by Neon Functions
// (Neon-managed vars) and by `functions.api.env` in neon.ts (our secrets).

export function getEnv(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

export function requireEnv(name: string): string {
  const value = getEnv(name)
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export function intEnv(name: string, fallback: number): number {
  const value = getEnv(name)
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function boolEnv(name: string, fallback = false): boolean {
  const value = getEnv(name)
  if (value === undefined) return fallback
  return value === '1' || value.toLowerCase() === 'true'
}

/** Allowed browser origins, or '*' when unset/wildcard (Bearer auth only; no cookies). */
export function allowedOrigins(): string[] | '*' {
  const value = getEnv('ALLOWED_ORIGINS')
  if (!value || value.trim() === '*') return '*'
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}
