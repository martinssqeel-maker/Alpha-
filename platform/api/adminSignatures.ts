/**
 * Allow-list of the `admin_*` SECURITY DEFINER functions exposed over
 * POST /admin/rpc, together with their exact Postgres parameter names, casts and
 * defaults — mirrored from `database/migrations/0001_platform.sql`.
 *
 * The names matter: callers send **named** parameters (`{ p_limit: 200 }`) and the
 * SQL is built with Postgres named-argument notation
 * (`public.admin_audit_log(p_limit => $1::integer)`). That means the caller's key
 * order no longer has to match the function signature, and parameters that declare
 * a default can be omitted instead of being padded with `null`.
 *
 * Casts are kept even though they mirror the signature, so explicit SQL `null`
 * binds do not become ambiguous.
 *
 * This module is intentionally dependency-free so it can be unit-tested without
 * booting Neon, Hono or the database pool.
 */

export interface AdminParam {
  /** Exact Postgres parameter name, e.g. `p_limit`. */
  name: string
  /** Postgres cast applied to the bound placeholder, e.g. `integer`. */
  cast: string
  /** True when the function declares a default for this parameter. */
  hasDefault?: boolean
}

export const ADMIN_SIGNATURES: Record<string, AdminParam[]> = {
  admin_overview: [],
  admin_list_users: [
    { name: 'p_query', cast: 'text', hasDefault: true },
    { name: 'p_limit', cast: 'integer', hasDefault: true }
  ],
  admin_set_user_status: [
    { name: 'p_user', cast: 'uuid' },
    { name: 'p_status', cast: 'text' }
  ],
  admin_grant_override: [
    { name: 'p_user', cast: 'uuid' },
    { name: 'p_feature', cast: 'text' },
    { name: 'p_value', cast: 'jsonb' },
    { name: 'p_ends_at', cast: 'timestamptz', hasDefault: true },
    { name: 'p_reason', cast: 'text', hasDefault: true }
  ],
  admin_revoke_override: [{ name: 'p_id', cast: 'uuid' }],
  admin_set_user_plan: [
    { name: 'p_user', cast: 'uuid' },
    { name: 'p_plan_code', cast: 'text' },
    { name: 'p_interval', cast: 'text', hasDefault: true },
    { name: 'p_period_end', cast: 'timestamptz', hasDefault: true }
  ],
  admin_upsert_plan: [{ name: 'p', cast: 'jsonb' }],
  admin_set_plan_feature: [
    { name: 'p_plan', cast: 'uuid' },
    { name: 'p_feature', cast: 'text' },
    { name: 'p_value', cast: 'jsonb' }
  ],
  admin_upsert_provider: [{ name: 'p', cast: 'jsonb' }],
  admin_upsert_model: [{ name: 'p', cast: 'jsonb' }],
  admin_set_model_plan_access: [
    { name: 'p_model', cast: 'uuid' },
    { name: 'p_plan', cast: 'uuid' },
    { name: 'p_allowed', cast: 'boolean' }
  ],
  admin_upsert_flag: [
    { name: 'p_key', cast: 'text' },
    { name: 'p_enabled', cast: 'boolean' },
    { name: 'p_description', cast: 'text', hasDefault: true },
    { name: 'p_rollout', cast: 'integer', hasDefault: true }
  ],
  admin_set_setting: [
    { name: 'p_key', cast: 'text' },
    { name: 'p_value', cast: 'jsonb' }
  ],
  admin_upsert_announcement: [{ name: 'p', cast: 'jsonb' }],
  admin_audit_log: [{ name: 'p_limit', cast: 'integer', hasDefault: true }],
  admin_list_catalog: [],
  admin_list_releases: [],
  admin_upsert_release: [{ name: 'p', cast: 'jsonb' }]
}

export type AdminCallErrorCode = 'unknown_function' | 'unknown_param' | 'missing_param' | 'bad_args'

export interface AdminCallSuccess {
  ok: true
  /** `select public.<fn>(...) as result`, using named-argument notation. */
  sql: string
  /** Bound values, in placeholder order. */
  values: unknown[]
}

export interface AdminCallFailure {
  ok: false
  code: AdminCallErrorCode
  message: string
}

export type AdminCallResult = AdminCallSuccess | AdminCallFailure

export interface AdminCallInput {
  /** Named parameters, keyed by the Postgres parameter name. */
  params?: Record<string, unknown>
  /** Legacy positional arguments; must match the signature exactly. */
  args?: unknown[]
}

/** `public.fn(p_x => $1::cast, ...)` for the given params, in signature order. */
function callSql(fn: string, params: AdminParam[]): string {
  if (!params.length) return `select public.${fn}() as result`
  const parts = params.map((param, index) => `${param.name} => $${index + 1}::${param.cast}`)
  return `select public.${fn}(${parts.join(', ')}) as result`
}

/**
 * Build the SQL + bound values for an allow-listed admin function.
 *
 * Prefer `params` (named): keys may come in any order, and parameters with a
 * default may be omitted. `args` is still accepted for positional callers and must
 * match the full signature length, because a short positional list would silently
 * shift later arguments.
 */
export function buildAdminCall(fn: string, input: AdminCallInput = {}): AdminCallResult {
  const signature = ADMIN_SIGNATURES[fn]
  if (!signature) {
    return { ok: false, code: 'unknown_function', message: `Unknown admin function "${fn}".` }
  }

  if (Array.isArray(input.args)) {
    if (input.args.length !== signature.length) {
      return {
        ok: false,
        code: 'bad_args',
        message: `${fn} expects ${signature.length} argument(s), received ${input.args.length}.`
      }
    }
    return { ok: true, sql: callSql(fn, signature), values: input.args }
  }

  const params = input.params ?? {}

  for (const key of Object.keys(params)) {
    if (!signature.some((param) => param.name === key)) {
      return { ok: false, code: 'unknown_param', message: `${fn} has no parameter named "${key}".` }
    }
  }

  const supplied: AdminParam[] = []
  const values: unknown[] = []
  for (const param of signature) {
    // `undefined` counts as "not supplied" so JSON round-trips stay clean.
    if (params[param.name] === undefined) {
      if (!param.hasDefault) {
        return { ok: false, code: 'missing_param', message: `${fn} requires parameter "${param.name}".` }
      }
      continue
    }
    supplied.push(param)
    values.push(params[param.name])
  }

  return { ok: true, sql: callSql(fn, supplied), values }
}
