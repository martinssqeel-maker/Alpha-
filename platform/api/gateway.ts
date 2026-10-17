import { Hono } from 'hono'
import type { Context } from 'hono'
import { waitUntil } from '@neon/functions'
import type { AppEnv } from './types'
import { withContext } from './db'
import { getEnv } from './env'
import { requireAuth } from './middleware'
import { requireLiveSession } from './sessions'
import { loadPlatformConfig } from './platform'
import { MAX_REQUEST_BYTES, MAX_OUTPUT_TOKENS, DEFAULT_OUTPUT_RESERVE, redact, reservationFor, upstreamFailure, estimateCostUsd } from './aiGuard'

/**
 * Shared cloud inference.
 *
 * Everything a user's request depends on is decided here, on the server:
 * who they are, what their plan allows, whether they have allowance left, and
 * which upstream credential answers. The browser sends a model id and messages;
 * it never sends a provider key, a user id, or a cost.
 *
 * The allowance is not read-then-trusted. `claim_ai_request` checks and reserves
 * inside one transaction, so two simultaneous requests cannot both pass an
 * exhausted quota, and `finish_ai_request` settles the reservation to what the
 * provider actually billed.
 */
export const gatewayRoutes = new Hono<AppEnv>()

// This router used to be mounted with no middleware while still calling
// `c.get('userId')`. The result: `userId` was always undefined, the config lookup
// always returned null, and every request — signed in or not — was answered with
// 402 `plan_required`. Shared inference could not have worked for anybody.
gatewayRoutes.use('*', requireAuth, requireLiveSession)

/** Guards that exist to protect the company credential and the user's allowance. */
const MAX_MESSAGES = 400
const MAX_CONCURRENT = 4

const APP_TITLE = 'Alpha AI Workspace'

interface PlatformConfigLite {
  features?: Record<string, unknown>
  limits?: Record<string, number | null>
  usage?: { resource: string; used: number; limit: number | null; unlimited: boolean }[]
  models?: {
    modelId: string
    providerId: string
    providerLabel: string
    label: string
    allowed: boolean
    capabilities?: { streaming?: boolean; tools?: boolean; vision?: boolean }
    contextLength?: number
  }[]
}

interface Upstream {
  baseUrl: string
  apiKey: string
  providerCode: string
  extraHeaders: Record<string, string>
  /** OpenAI honours this; OpenRouter deprecated it and ignores it. */
  supportsStreamUsageOption: boolean
}

interface ClaimResult {
  allowed: boolean
  code?: string
  message?: string
  requestId?: number
  reservedTokens?: number
  limit?: number | null
  used?: number
  dailyLimit?: number
  dailyUsed?: number
  inflight?: number
}

interface ChunkUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  /** OpenRouter reports the billed cost here; OpenAI-compatible peers do not. */
  cost?: number
}

function jsonErr(c: Context<AppEnv>, status: number, code: string, message: string, extra?: Record<string, unknown>): Response {
  return c.json({ ok: false, error: { code, message, ...(extra ?? {}) } }, status as 400)
}

/**
 * Resolve the upstream for a provider code. Prefers the Neon AI Gateway when
 * NEON_AI_GATEWAY_* is configured (one credential for every provider); otherwise
 * uses the provider's own OpenAI-compatible base_url plus the deployment secret
 * named by `ai_providers.api_key_env`.
 *
 * The secret itself is only ever read here, in the Function's own environment.
 */
async function resolveUpstream(providerCode: string, referer: string): Promise<Upstream | null> {
  const gatewayBase = getEnv('NEON_AI_GATEWAY_BASE_URL')
  const gatewayToken = getEnv('NEON_AI_GATEWAY_TOKEN')
  if (gatewayBase && gatewayToken) {
    return {
      baseUrl: `${gatewayBase.replace(/\/+$/, '')}/v1`,
      apiKey: gatewayToken,
      providerCode,
      extraHeaders: {},
      supportsStreamUsageOption: true
    }
  }

  const provider = await withContext(null, 'anon', async (q) => {
    const res = await q.query<{ code: string; kind: string; base_url: string | null; api_key_env: string | null }>(
      'select code, kind, base_url, api_key_env from public.ai_providers where code = $1 and active limit 1',
      [providerCode]
    )
    return res.rows[0]
  })
  if (!provider || !provider.base_url) return null
  if (provider.kind !== 'openai' && provider.kind !== 'openai-compatible') return null

  const keyName = provider.api_key_env || `PROVIDER_API_KEY_${provider.code.toUpperCase()}`
  const apiKey = getEnv(keyName)
  if (!apiKey) return null

  // OpenRouter asks integrators to identify themselves. Both headers are
  // optional, and neither carries a secret.
  const extraHeaders: Record<string, string> = {}
  if (provider.code === 'openrouter') {
    if (referer) extraHeaders['HTTP-Referer'] = referer
    extraHeaders['X-OpenRouter-Title'] = APP_TITLE
  }

  return {
    baseUrl: provider.base_url.replace(/\/+$/, ''),
    apiKey,
    providerCode: provider.code,
    extraHeaders,
    supportsStreamUsageOption: provider.code !== 'openrouter'
  }
}

/** Published list price for a model, when the catalog carries one. */
async function lookupPrice(providerCode: string, modelId: string): Promise<{ input: number; output: number } | null> {
  try {
    const price = await withContext(null, 'anon', async (q) => {
      const res = await q.query<{ cost_input_per_mtok: string | null; cost_output_per_mtok: string | null }>(
        `select m.cost_input_per_mtok, m.cost_output_per_mtok
           from public.ai_models m join public.ai_providers p on p.id = m.provider_id
          where p.code = $1 and m.model_id = $2 limit 1`,
        [providerCode, modelId]
      )
      return res.rows[0]
    })
    if (!price || price.cost_input_per_mtok === null || price.cost_output_per_mtok === null) return null
    return { input: Number(price.cost_input_per_mtok), output: Number(price.cost_output_per_mtok) }
  } catch {
    return null
  }
}

/** Settle a claim. Never throws into a streaming response. */
async function settle(
  userId: string,
  requestId: number,
  outcome: {
    status: 'ok' | 'error' | 'cancelled'
    prompt?: number | null
    completion?: number | null
    total?: number | null
    costUsd?: number | null
    costBasis?: string | null
    errorCode?: string | null
    durationMs?: number | null
    generationId?: string | null
  }
): Promise<void> {
  try {
    await withContext(userId, 'authenticated', async (q) => {
      await q.query('select public.finish_ai_request($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [
        requestId,
        outcome.status,
        outcome.prompt ?? null,
        outcome.completion ?? null,
        outcome.total ?? null,
        outcome.costUsd ?? null,
        outcome.errorCode ?? null,
        outcome.durationMs ?? null,
        outcome.generationId ?? null,
        outcome.costBasis ?? null
      ])
    })
  } catch (error) {
    console.error('[gateway:settle]', error)
  }
}

/**
 * Pass the upstream bytes through unchanged — parsing costs nothing in latency
 * because the original chunk is what gets enqueued — while reading the SSE
 * frames for usage, the generation id, and mid-stream provider errors.
 */
function meterStream(
  source: ReadableStream<Uint8Array>,
  onFrame: (frame: Record<string, unknown>) => void,
  onCancel: () => void
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          onFrame(JSON.parse(data) as Record<string, unknown>)
        } catch {
          /* keepalive or a comment line */
        }
      }
      controller.enqueue(value)
    },
    cancel(reason) {
      onCancel()
      return reader.cancel(reason)
    }
  })
}

gatewayRoutes.get('/models', async (c) => {
  const cfg = (await loadPlatformConfig(c.get('userId'))) as PlatformConfigLite | null
  return c.json({ models: cfg?.models ?? [] })
})

/**
 * What this account can run right now, and whether the company credential for
 * each provider is present. Presence only — never the value, never a prefix.
 */
gatewayRoutes.get('/status', async (c) => {
  const userId = c.get('userId')
  const cfg = (await loadPlatformConfig(userId)) as PlatformConfigLite | null

  const providers = await withContext(null, 'anon', async (q) => {
    const res = await q.query<{ code: string; label: string; api_key_env: string | null; active: boolean }>(
      'select code, label, api_key_env, active from public.ai_providers order by sort, code'
    )
    return res.rows
  })

  const recent = await withContext(userId, 'authenticated', async (q) => {
    const res = await q.query<{ provider_code: string; requests: string; failed: string; last_at: string | null }>(
      `select provider_code, count(*)::text as requests,
              count(*) filter (where status <> 'ok')::text as failed, max(created_at)::text as last_at
         from public.ai_requests
        where user_id = $1 and created_at > now() - interval '7 days'
        group by provider_code`,
      [userId]
    )
    return res.rows
  })

  const stats = new Map(recent.map((row) => [row.provider_code, row]))
  return c.json({
    ok: true,
    providers: providers.map((provider) => {
      const keyName = provider.api_key_env || `PROVIDER_API_KEY_${provider.code.toUpperCase()}`
      const stat = stats.get(provider.code)
      return {
        code: provider.code,
        label: provider.label,
        active: provider.active,
        configured:
          Boolean(getEnv('NEON_AI_GATEWAY_BASE_URL') && getEnv('NEON_AI_GATEWAY_TOKEN')) || Boolean(getEnv(keyName)),
        requests7d: stat ? Number(stat.requests) : 0,
        failed7d: stat ? Number(stat.failed) : 0,
        lastRequestAt: stat?.last_at ?? null
      }
    }),
    sharedEnabled: (await withContext(userId, 'authenticated', async (q) => {
      const res = await q.query<{ s: { enabled: boolean; message: string | null } }>('select public.ai_shared_state() as s')
      return res.rows[0]?.s
    })) ?? null,
    budget: await withContext(userId, 'authenticated', async (q) => {
      const res = await q.query<{ b: Record<string, unknown> }>('select public.ai_budget_state() as b')
      return res.rows[0]?.b ?? null
    }),
    usage: cfg?.usage ?? []
  })
})

/**
 * This account's own inference history, for the website dashboard.
 *
 * Read-only and scoped by the token's user id, so it can only ever describe the
 * caller. Cost is what the gateway recorded when each request settled — an
 * estimate from catalog pricing, not a provider invoice — and the response says
 * so through `costBasis` rather than letting a UI present it as billing.
 */
gatewayRoutes.get('/activity', async (c) => {
  const userId = c.get('userId')
  const requested = Number.parseInt(c.req.query('days') ?? '30', 10)
  const days = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 90) : 30

  return withContext(userId, 'authenticated', async (q) => {
    const totals = (
      await q.query<{ requests: number; tokens: number; failed: number; cost: string | null }>(
        `select count(*)::int as requests,
                coalesce(sum(total_tokens), 0)::int as tokens,
                count(*) filter (where status <> 'ok')::int as failed,
                sum(cost_usd)::text as cost
           from public.ai_requests
          where user_id = $1 and created_at > now() - make_interval(days => $2::int)`,
        [userId, days]
      )
    ).rows[0]

    const daily = (
      await q.query<{ day: string; requests: number; tokens: number; failed: number }>(
        `select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
                count(*)::int as requests,
                coalesce(sum(total_tokens), 0)::int as tokens,
                count(*) filter (where status <> 'ok')::int as failed
           from public.ai_requests
          where user_id = $1 and created_at > now() - make_interval(days => $2::int)
          group by 1 order by 1`,
        [userId, days]
      )
    ).rows

    const models = (
      await q.query<{ modelId: string; providerId: string; requests: number; tokens: number }>(
        `select model_id as "modelId", provider_code as "providerId",
                count(*)::int as requests,
                coalesce(sum(total_tokens), 0)::int as tokens
           from public.ai_requests
          where user_id = $1 and created_at > now() - make_interval(days => $2::int)
          group by 1, 2 order by requests desc, tokens desc limit 10`,
        [userId, days]
      )
    ).rows

    const recent = (
      await q.query<{
        modelId: string
        providerId: string
        status: string
        tokens: number | null
        createdAt: string
        durationMs: number | null
        errorCode: string | null
      }>(
        `select model_id as "modelId", provider_code as "providerId", status,
                total_tokens as tokens, created_at as "createdAt",
                duration_ms as "durationMs", error_code as "errorCode"
           from public.ai_requests
          where user_id = $1
          order by created_at desc limit 12`,
        [userId]
      )
    ).rows

    const cost = totals?.cost === null || totals?.cost === undefined ? null : Number(totals.cost)
    return c.json({
      ok: true,
      days,
      totals: {
        requests: totals?.requests ?? 0,
        tokens: totals?.tokens ?? 0,
        failed: totals?.failed ?? 0,
        estimatedCostUsd: cost === null || Number.isNaN(cost) ? null : cost,
        costBasis: 'estimate'
      },
      daily,
      models,
      recent
    })
  })
})

gatewayRoutes.post('/chat/completions', async (c) => {
  const userId = c.get('userId')
  const started = Date.now()

  const raw = await c.req.text()
  if (raw.length > MAX_REQUEST_BYTES) {
    return jsonErr(c, 413, 'request_too_large', 'That conversation is too large to send in one request.')
  }
  let payload: {
    model?: string
    messages?: unknown
    tools?: unknown
    temperature?: number
    max_tokens?: number
  } | null = null
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = null
  }
  if (!payload || typeof payload.model !== 'string' || !Array.isArray(payload.messages)) {
    return jsonErr(c, 400, 'invalid_request', 'model and messages are required.')
  }
  if (payload.messages.length === 0) {
    return jsonErr(c, 400, 'empty_conversation', 'Send at least one message.')
  }
  if (payload.messages.length > MAX_MESSAGES) {
    return jsonErr(c, 413, 'too_many_messages', `Send at most ${MAX_MESSAGES} messages per request.`)
  }

  const cfg = (await loadPlatformConfig(userId)) as PlatformConfigLite | null
  if (!cfg) {
    return jsonErr(c, 503, 'platform_unavailable', 'Your account configuration could not be loaded. Try again.')
  }
  if (!cfg.features?.cloud_models) {
    return jsonErr(c, 402, 'plan_required', 'Cloud models are not included in your current plan.')
  }

  const model = (cfg.models ?? []).find((entry) => entry.modelId === payload.model)
  if (!model) return jsonErr(c, 404, 'unknown_model', `Model "${payload.model}" is not available.`)
  if (!model.allowed) {
    return jsonErr(c, 403, 'model_not_allowed', `Your plan does not include ${model.label}.`)
  }

  const upstream = await resolveUpstream(model.providerId, c.req.header('origin') ?? '')
  if (!upstream) {
    return jsonErr(
      c,
      503,
      'provider_unconfigured',
      `${model.providerLabel} is not configured on the server yet. A local model still works.`
    )
  }

  // Reserve before calling: input estimate plus the output the request may produce.
  const requestedOutput = typeof payload.max_tokens === 'number' && Number.isFinite(payload.max_tokens)
    ? Math.min(Math.max(Math.trunc(payload.max_tokens), 0), MAX_OUTPUT_TOKENS)
    : DEFAULT_OUTPUT_RESERVE
  const reserve = reservationFor(payload.messages, payload.max_tokens)

  const claim = await withContext(userId, 'authenticated', async (q) => {
    const res = await q.query<{ c: ClaimResult }>('select public.claim_ai_request($1, $2, $3, $4, $5) as c', [
      userId,
      model.providerId,
      payload.model,
      reserve,
      MAX_CONCURRENT
    ])
    return res.rows[0]?.c ?? { allowed: false, code: 'claim_failed', message: 'The request could not be started.' }
  })

  if (!claim.allowed || typeof claim.requestId !== 'number') {
    const code = claim.code ?? 'claim_failed'
    const http = code === 'quota_exceeded' ? 402 : code === 'daily_limit_reached' || code === 'too_many_requests' ? 429 : 403
    return jsonErr(c, http, code, claim.message ?? 'This request was not allowed.', {
      limit: claim.limit ?? null,
      used: claim.used ?? null,
      dailyLimit: claim.dailyLimit ?? null,
      dailyUsed: claim.dailyUsed ?? null
    })
  }

  const requestId = claim.requestId
  const price = await lookupPrice(model.providerId, payload.model)

  const upstreamBody: Record<string, unknown> = {
    model: payload.model,
    messages: payload.messages,
    stream: true
  }
  if (upstream.supportsStreamUsageOption) upstreamBody.stream_options = { include_usage: true }
  if (payload.tools) upstreamBody.tools = payload.tools
  if (typeof payload.temperature === 'number') upstreamBody.temperature = payload.temperature
  if (typeof payload.max_tokens === 'number') upstreamBody.max_tokens = requestedOutput

  let upstreamRes: Response
  try {
    upstreamRes = await fetch(`${upstream.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${upstream.apiKey}`,
        ...upstream.extraHeaders
      },
      body: JSON.stringify(upstreamBody),
      signal: c.req.raw.signal
    })
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError'
    await settle(userId, requestId, {
      status: aborted ? 'cancelled' : 'error',
      errorCode: aborted ? 'client_cancelled' : 'upstream_unreachable',
      durationMs: Date.now() - started
    })
    if (aborted) return jsonErr(c, 499, 'cancelled', 'The request was cancelled.')
    return jsonErr(c, 502, 'upstream_unreachable', 'The provider could not be reached. Try again.')
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    const detail = await upstreamRes.text().catch(() => '')
    const failure = upstreamFailure(upstreamRes.status || 502, detail)
    await settle(userId, requestId, {
      status: 'error',
      errorCode: failure.code,
      durationMs: Date.now() - started
    })
    const retryAfter = upstreamRes.headers.get('retry-after')
    return jsonErr(c, failure.http, failure.code, failure.message, retryAfter ? { retryAfter } : undefined)
  }

  // Usage and the generation id only ever arrive inside the stream, so the tap
  // settles the claim once the stream actually ends.
  // Held in one object rather than three `let`s: the tap below runs in a separate
  // closure, and TypeScript's control-flow analysis cannot see those writes, so
  // standalone variables would be narrowed to `null` and then to `never`.
  const tap: {
    usage: ChunkUsage | null
    generationId: string | null
    error: { code: string; message: string } | null
  } = { usage: null, generationId: null, error: null }
  let settled = false

  const finish = async (status: 'ok' | 'error' | 'cancelled', errorCode?: string): Promise<void> => {
    if (settled) return
    settled = true
    const seen = tap.usage
    const total = seen?.total_tokens ?? null
    // A cost the provider reported is authoritative. A cost derived from the
    // published list price is an estimate, and is recorded as one.
    const costBasis = seen?.cost != null ? 'provider' : price ? 'estimate' : null
    let costUsd: number | null = null
    if (seen?.cost != null) costUsd = seen.cost
    else if (price && total != null) {
      const prompt = seen?.prompt_tokens ?? 0
      const completion = seen?.completion_tokens ?? 0
      costUsd = estimateCostUsd(price, prompt, completion)
    }
    await settle(userId, requestId, {
      status,
      prompt: seen?.prompt_tokens ?? null,
      completion: seen?.completion_tokens ?? null,
      total,
      costUsd,
      costBasis,
      errorCode: errorCode ?? null,
      durationMs: Date.now() - started,
      generationId: tap.generationId
    })
  }

  const [toClient, toTap] = upstreamRes.body.tee()

  const metered = meterStream(
    toTap,
    (frame) => {
      if (typeof frame.id === 'string') tap.generationId = frame.id
      const rawUsage = (frame.usage ?? null) as ChunkUsage | null
      if (rawUsage && typeof rawUsage === 'object') tap.usage = rawUsage
      const err = frame.error as { code?: unknown; message?: unknown } | undefined
      if (err) {
        tap.error = {
          code: typeof err.code === 'string' ? err.code : 'provider_error',
          message: typeof err.message === 'string' ? redact(err.message) : 'The provider stopped mid-response.'
        }
      }
      // A provider that fails after the first byte cannot answer with an HTTP
      // status any more, so the failure arrives as a finish_reason instead.
      const choices = frame.choices as { finish_reason?: unknown }[] | undefined
      if (Array.isArray(choices) && choices.some((choice) => choice?.finish_reason === 'error') && !tap.error) {
        tap.error = { code: 'provider_error', message: 'The provider stopped mid-response.' }
      }
    },
    () => {
      // The client stopped reading — a cancel in the UI, or a closed window.
      // Give the allowance back rather than charging for what was not delivered.
      waitUntil(finish('cancelled', 'client_cancelled'))
    }
  )

  waitUntil(
    (async () => {
      try {
        const reader = metered.getReader()
        for (;;) {
          const { done } = await reader.read()
          if (done) break
        }
      } catch {
        /* aborted */
      }
      if (tap.error) await finish('error', tap.error.code)
      else await finish('ok')
    })()
  )

  return new Response(toClient, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    }
  })
})
