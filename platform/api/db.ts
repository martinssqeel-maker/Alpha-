import pg from 'pg'
import { attachDatabasePool } from '@neon/functions'

// Persistent pool created once per isolate and reused across requests.
// max kept small: each isolate owns its pool, so total connections scale with isolates.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5
})

attachDatabasePool(pool)

export type Queryable = Pick<pg.PoolClient, 'query'>

/**
 * Run `fn` inside a transaction with the request-scoped auth context set via
 * set_config(..., true) so public.current_user_id() / current_request_role()
 * resolve the caller for SECURITY DEFINER functions and RLS (defense-in-depth).
 * `is_local = true` scopes the setting to the transaction, safe under pooling.
 */
export async function withContext<T>(
  userId: string | null,
  role: string,
  fn: (q: Queryable) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('app.user_id', $1, true)", [userId ?? ''])
    await client.query("select set_config('app.role', $1, true)", [role])
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    try {
      await client.query('rollback')
    } catch {
      /* ignore */
    }
    throw error
  } finally {
    client.release()
  }
}
