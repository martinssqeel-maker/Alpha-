import { SignJWT, jwtVerify } from 'jose'
import { intEnv, requireEnv } from './env'

const ISSUER = 'alpha-platform'
const AUDIENCE = 'alpha-clients'

export interface AccessClaims {
  userId: string
  email: string
  sid: string
  role: string
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(requireEnv('AUTH_JWT_SECRET'))
}

export function accessTtlMs(): number {
  return intEnv('AUTH_ACCESS_TTL_MIN', 60) * 60_000
}

export function refreshTtlMs(): number {
  return intEnv('AUTH_SESSION_TTL_DAYS', 30) * 86_400_000
}

/** Sign a short-lived HS256 session access token. */
export async function signAccessToken(claims: AccessClaims): Promise<string> {
  const minutes = intEnv('AUTH_ACCESS_TTL_MIN', 60)
  return new SignJWT({ email: claims.email, sid: claims.sid, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${minutes}m`)
    .sign(secretKey())
}

/** Verify a session access token. Returns null on any failure. */
export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: ISSUER, audience: AUDIENCE })
    if (typeof payload.sub !== 'string') return null
    return {
      userId: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      sid: typeof payload.sid === 'string' ? payload.sid : '',
      role: typeof payload.role === 'string' ? payload.role : 'authenticated'
    }
  } catch {
    return null
  }
}
