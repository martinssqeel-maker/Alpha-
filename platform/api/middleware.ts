import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './types'
import { verifyAccessToken } from './jwt'

function unauthorized(message: string): Response {
  return Response.json({ ok: false, error: { code: 'unauthorized', message } }, { status: 401 })
}

/** Verify the bearer session token and expose the caller on the context. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (!token) return unauthorized('Missing bearer token.')
  const claims = await verifyAccessToken(token)
  if (!claims) return unauthorized('Invalid or expired session.')
  c.set('userId', claims.userId)
  c.set('email', claims.email)
  c.set('sid', claims.sid)
  await next()
}
