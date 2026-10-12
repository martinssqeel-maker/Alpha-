import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

// Administrator passwords are stored as scrypt digests with a per-credential salt:
//
//   scrypt$<N>$<r>$<p>$<salt-b64url>$<digest-b64url>
//
// The format is self-describing so the cost parameters can be raised later
// without invalidating credentials that already exist.
const N = 16_384
const R = 8
const P = 1
const KEY_LEN = 64
const MAX_MEM = 64 * 1024 * 1024

export const MIN_PASSWORD_LENGTH = 12

/** Human-readable reason a password is unacceptable, or null when it passes. */
export function passwordProblem(password: string): string | null {
  if (typeof password !== 'string' || password.length === 0) return 'Enter a password.'
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  if (password.trim() !== password) return 'Remove leading or trailing spaces.'
  const lower = password.toLowerCase()
  const weak = ['password', 'letmein', 'changeme', 'qwerty', '123456', 'alpha123']
  if (weak.some((entry) => lower.includes(entry))) {
    return 'That password contains a well-known weak phrase.'
  }
  return null
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const digest = scryptSync(password, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAX_MEM })
  return ['scrypt', N, R, P, salt.toString('base64url'), digest.toString('base64url')].join('$')
}

/**
 * Constant-time verification against a stored digest. Returns false — never
 * throws — on malformed input, so a corrupted row cannot lock the API up.
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nRaw, rRaw, pRaw, saltRaw, digestRaw] = parts
  const n = Number.parseInt(nRaw, 10)
  const r = Number.parseInt(rRaw, 10)
  const p = Number.parseInt(pRaw, 10)
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  if (n < 2 || r < 1 || p < 1) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltRaw, 'base64url')
    expected = Buffer.from(digestRaw, 'base64url')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  let actual: Buffer
  try {
    actual = scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: MAX_MEM })
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** True when a stored digest was produced with weaker parameters than today's. */
export function passwordNeedsRehash(stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true
  const n = Number.parseInt(parts[1], 10)
  const r = Number.parseInt(parts[2], 10)
  const p = Number.parseInt(parts[3], 10)
  return n !== N || r !== R || p !== P
}
