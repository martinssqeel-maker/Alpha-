import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto'
import { getEnv, requireEnv } from './env'

/** 6-digit numeric one-time passcode. */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** URL-safe opaque token (magic link, refresh token). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

function pepper(): string {
  return getEnv('AUTH_PEPPER') ?? requireEnv('AUTH_JWT_SECRET')
}

/** One-way hash for OTP codes, magic links and refresh tokens (only hashes are stored). */
export function hashSecret(value: string): string {
  return createHash('sha256').update(`${pepper()}:${value}`).digest('hex')
}

/** Constant-time comparison of two hex hashes. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
