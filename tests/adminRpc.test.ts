import { describe, expect, it } from 'vitest'
import { ADMIN_SIGNATURES, buildAdminCall } from '../platform/api/adminSignatures'

describe('admin/rpc call building', () => {
  it('rejects a function that is not on the allow-list', () => {
    const call = buildAdminCall('admin_drop_everything', { params: {} })
    expect(call).toMatchObject({ ok: false, code: 'unknown_function' })
  })

  it('builds a zero-argument call', () => {
    const call = buildAdminCall('admin_overview')
    expect(call).toMatchObject({ ok: true, sql: 'select public.admin_overview() as result', values: [] })
  })

  it('maps named parameters by name, independent of the key order', () => {
    const reversed = buildAdminCall('admin_set_user_status', {
      params: { p_status: 'suspended', p_user: 'user-1' }
    })
    const natural = buildAdminCall('admin_set_user_status', {
      params: { p_user: 'user-1', p_status: 'suspended' }
    })
    // Same SQL and same bound-value order either way: the signature drives the order.
    expect(reversed).toEqual(natural)
    expect(reversed).toMatchObject({
      ok: true,
      sql: 'select public.admin_set_user_status(p_user => $1::uuid, p_status => $2::text) as result',
      values: ['user-1', 'suspended']
    })
  })

  it('omits parameters that declare a default', () => {
    // The dashboard only sends two of the four parameters on this call.
    const call = buildAdminCall('admin_set_user_plan', {
      params: { p_user: 'user-1', p_plan_code: 'pro' }
    })
    expect(call).toMatchObject({
      ok: true,
      sql: 'select public.admin_set_user_plan(p_user => $1::uuid, p_plan_code => $2::text) as result',
      values: ['user-1', 'pro']
    })
    expect((call as { sql: string }).sql).not.toContain('p_interval')
  })

  it('includes a defaulted parameter when it is supplied', () => {
    const call = buildAdminCall('admin_upsert_flag', {
      params: { p_key: 'new_ui', p_enabled: true, p_description: 'rollout', p_rollout: 10 }
    })
    expect(call).toMatchObject({
      ok: true,
      sql:
        'select public.admin_upsert_flag(p_key => $1::text, p_enabled => $2::boolean, ' +
        'p_description => $3::text, p_rollout => $4::integer) as result',
      values: ['new_ui', true, 'rollout', 10]
    })
  })

  it('reports a missing required parameter instead of shifting arguments', () => {
    const call = buildAdminCall('admin_set_user_status', { params: { p_status: 'active' } })
    expect(call).toMatchObject({ ok: false, code: 'missing_param' })
    expect((call as { message: string }).message).toContain('p_user')
  })

  it('rejects an unknown parameter name', () => {
    const call = buildAdminCall('admin_audit_log', { params: { p_limitt: 5 } })
    expect(call).toMatchObject({ ok: false, code: 'unknown_param' })
  })

  it('treats an explicit null as supplied, and undefined as absent', () => {
    const withNull = buildAdminCall('admin_set_setting', { params: { p_key: 'k', p_value: null } })
    expect(withNull).toMatchObject({ ok: true, values: ['k', null] })

    const withUndefined = buildAdminCall('admin_set_setting', { params: { p_key: 'k', p_value: undefined } })
    expect(withUndefined).toMatchObject({ ok: false, code: 'missing_param' })
  })

  it('still accepts positional arguments, but only at the exact arity', () => {
    const short = buildAdminCall('admin_set_user_plan', { args: ['user-1', 'pro'] })
    expect(short).toMatchObject({ ok: false, code: 'bad_args' })

    const exact = buildAdminCall('admin_set_user_plan', {
      args: ['user-1', 'pro', 'month', null]
    })
    expect(exact).toMatchObject({
      ok: true,
      values: ['user-1', 'pro', 'month', null]
    })
    expect((exact as { sql: string }).sql).toContain('p_period_end => $4::timestamptz')
  })

  it('keeps every admin call consistent with its declared signature', () => {
    for (const [fn, params] of Object.entries(ADMIN_SIGNATURES)) {
      const all: Record<string, unknown> = {}
      for (const param of params) all[param.name] = param.cast === 'jsonb' ? {} : 'x'
      const call = buildAdminCall(fn, { params: all })
      expect(call, `${fn} should build with all parameters supplied`).toMatchObject({ ok: true })
      // No duplicate parameter names -> no duplicate keywords in the call.
      const names = params.map((p) => p.name)
      expect(new Set(names).size, `${fn} must not declare duplicate parameter names`).toBe(names.length)
    }
  })
})
