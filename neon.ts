import { defineConfig } from '@neon/config/v1'

// Collect only the env keys that are actually present, so defineConfig never
// receives `undefined` (which would throw on deploy) or `""` (which would delete
// a live key). Secrets live in the gitignored .env.local, loaded via
// `neon deploy --env .env.local`.
function pickEnv(names: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value !== '') out[name] = value
  }
  return out
}

const apiEnv = pickEnv([
  'AUTH_JWT_SECRET',
  'AUTH_PEPPER',
  'AUTH_ACCESS_TTL_MIN',
  'AUTH_SESSION_TTL_DAYS',
  'AUTH_OTP_TTL_MIN',
  'AUTH_MAX_ATTEMPTS',
  'AUTH_DEV_ECHO_OTP',
  'EMAIL_PROVIDER',
  'EMAIL_FROM',
  'RESEND_API_KEY',
  'WEB_ACCOUNT_URL',
  'ALLOWED_ORIGINS',
  // Enable these once the Neon AI Gateway is provisioned (paid plan):
  'NEON_AI_GATEWAY_BASE_URL',
  'NEON_AI_GATEWAY_TOKEN',
  // Or run on your own provider keys:
  'PROVIDER_API_KEY_OPENAI',
  'PROVIDER_API_KEY_ANTHROPIC',
  'PROVIDER_API_KEY_GROQ'
])

if (!apiEnv.AUTH_JWT_SECRET) {
  throw new Error('AUTH_JWT_SECRET is required. Add it to .env.local, then run: neon deploy --env .env.local')
}

export default defineConfig({
  functions: {
    api: {
      name: 'alpha-platform-api',
      source: 'platform/api/index.ts',
      env: apiEnv
    }
  }
})
