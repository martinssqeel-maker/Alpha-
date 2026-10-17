import { describe, expect, it } from 'vitest'

process.env.AUTH_JWT_SECRET = 'test-only-secret-please-never-deploy-this-value'

/**
 * `admin` routes turn a database refusal into a status and a sentence. Two
 * classes of refusal share SQLSTATE 42501: the generic "no administrator role"
 * from `require_admin`, and specific business rules raised by the same code —
 * "you cannot remove your own rights", "that is the last owner". Getting the
 * order wrong hides the real reason behind "administrator access is required",
 * which is what the portal used to show.
 */
async function describeAdminError() {
  const mod = await import('../platform/api/admin')
  return mod.describeAdminError
}

function pgError(message: string, code: string) {
  return Object.assign(new Error(message), { code })
}

describe('admin error mapping', () => {
  it('reports a missing session as 401', async () => {
    const map = await describeAdminError()
    expect(map(pgError('not_authenticated', '42501'))).toMatchObject({
      status: 401,
      body: { error: { code: 'unauthorized' } }
    })
  })

  it('keeps a plain missing-role refusal generic at 403', async () => {
    const map = await describeAdminError()
    expect(map(pgError('forbidden', '42501'))).toMatchObject({
      status: 403,
      body: { error: { code: 'forbidden' } }
    })
  })

  it('surfaces "cannot remove your own admin rights" instead of the generic 403', async () => {
    const map = await describeAdminError()
    const result = map(pgError('cannot_remove_own_admin', '42501'))
    expect(result.status).toBe(409)
    expect(result.body.error.code).toBe('cannot_remove_own_admin')
    expect(result.body.error.message).toMatch(/your own administrator access/i)
  })

  it('surfaces the last-owner refusal instead of the generic 403', async () => {
    const map = await describeAdminError()
    const result = map(pgError('cannot_remove_last_owner', '42501'))
    expect(result.status).toBe(409)
    expect(result.body.error.code).toBe('cannot_remove_last_owner')
    expect(result.body.error.message).toMatch(/last owner/i)
  })

  it('maps a vanished record and a rejected value to 404 and 400', async () => {
    const map = await describeAdminError()
    expect(map(pgError('no rows', 'P0002')).status).toBe(404)
    for (const code of ['22P02', '22023', '23503', '23505', '23514']) {
      expect(map(pgError('bad value', code))).toMatchObject({
        status: 400,
        body: { error: { code: 'invalid_input' } }
      })
    }
  })

  it('never leaks an unrecognised error to the caller', async () => {
    const map = await describeAdminError()
    const result = map(new Error('connection to database "alpha" failed at 10.0.0.4'))
    expect(result.status).toBe(500)
    expect(result.body.error.message).toBe('The change could not be completed.')
    expect(JSON.stringify(result.body)).not.toContain('10.0.0.4')
  })
})
