import { describe, expect, it } from 'vitest'

process.env.AUTH_JWT_SECRET = 'test-only-secret-please-never-deploy-this-value'

/**
 * `admin` routes turn a database refusal into a status and a sentence. Two
 * classes of refusal share SQLSTATE 42501: the generic "no administrator role"
 * from `require_admin`, and specific business rules raised by the same code —
 * "you cannot remove your own rights", "that is the last owner". Getting the
 * order wrong hides the real reason behind "administrator access is required",
 * which is what the portal used to show.
 *
 * The module is imported once, at collection time. Importing it inside each test
 * instead cost every test the compilation of the whole API module graph (~2.5s
 * alone, and past the 5s per-test budget when the other 27 files are compiling
 * in parallel), so a loaded machine failed `reports a missing session as 401` for
 * a reason that had nothing to do with error mapping. The secret above is set
 * first because the API's env layer reads it during import.
 */
const { describeAdminError } = await import('../platform/api/admin')

function pgError(message: string, code: string) {
  return Object.assign(new Error(message), { code })
}

describe('admin error mapping', () => {
  it('reports a missing session as 401', () => {
    expect(describeAdminError(pgError('not_authenticated', '42501'))).toMatchObject({
      status: 401,
      body: { error: { code: 'unauthorized' } }
    })
  })

  it('keeps a plain missing-role refusal generic at 403', () => {
    expect(describeAdminError(pgError('forbidden', '42501'))).toMatchObject({
      status: 403,
      body: { error: { code: 'forbidden' } }
    })
  })

  it('surfaces "cannot remove your own admin rights" instead of the generic 403', () => {
    const result = describeAdminError(pgError('cannot_remove_own_admin', '42501'))
    expect(result.status).toBe(409)
    expect(result.body.error.code).toBe('cannot_remove_own_admin')
    expect(result.body.error.message).toMatch(/your own administrator access/i)
  })

  it('surfaces the last-owner refusal instead of the generic 403', () => {
    const result = describeAdminError(pgError('cannot_remove_last_owner', '42501'))
    expect(result.status).toBe(409)
    expect(result.body.error.code).toBe('cannot_remove_last_owner')
    expect(result.body.error.message).toMatch(/last owner/i)
  })

  it('maps a vanished record and a rejected value to 404 and 400', () => {
    expect(describeAdminError(pgError('no rows', 'P0002')).status).toBe(404)
    for (const code of ['22P02', '22023', '23503', '23505', '23514']) {
      expect(describeAdminError(pgError('bad value', code))).toMatchObject({
        status: 400,
        body: { error: { code: 'invalid_input' } }
      })
    }
  })

  it('never leaks an unrecognised error to the caller', () => {
    const result = describeAdminError(new Error('connection to database "alpha" failed at 10.0.0.4'))
    expect(result.status).toBe(500)
    expect(result.body.error.message).toBe('The change could not be completed.')
    expect(JSON.stringify(result.body)).not.toContain('10.0.0.4')
  })
})
