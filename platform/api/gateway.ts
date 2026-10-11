import { Hono } from 'hono'
import type { Context } from 'hono'
import { waitUntil } from '@neon/functions'
import type { AppEnv } from './types'
import { withContext } from './db'
import { getEnv } from './env'
import { requireAuth } from './middleware'
import { loadPlatformConfig } from './platform'

export const gatewayRoutes = new Hono<AppEnv>()

gatewayRoutes.use('*', requireAuth)

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
}

function jsonErr(c: Context<AppEnv>, status: number, code: string, message: string): Response {
  return c.json({ ok: false, error: { code, message } }, status as 400)
}

/**
 * Resolve the upstream for a provider code. Prefers the Neon AI Gateway when
 * NEON_AI_GATEWAY_* is configured (one credential for every provider); otherwise
 * falls back to the provider's own OpenAI-compatible base_url + api_key_env.
 */
async function resolveUpstream(providerCode: string): Promise<Upstream | null> {
  const gatewayBase = getEnv('NEON_AI_GATEWAY_BASE_URL')
  const gatewayToken = getEnv('NEON_AI_GATEWAY_TOKEN')
  if (gatewayBase && gatewayToken) {
    return { baseUrl: `${gatewayBase.replace(/\/+$/, '')}/v1`, apiKey: gatewayToken }
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
  return { baseUrl: provider.base_url.replace(/\/+$/, ''), apiKey }
}

/** Drain the upstream stream to capture token usage, then record it (after response). */
async function tapUsage(stream: ReadableStream<Uint8Array>, userId: string): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const chunk = JSON.parse(data) as {
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
          }
          if (chunk.usage) {
            total = chunk.usage.total_tokens ?? (chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0)
          }
        } catch {
          /* ignore non-JSON keepalive lines */
        }
      }
    }
  } catch {
    /* stream aborted */
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
  if (total > 0) {
    try {
      await withContext(userId, 'authenticated', async (q) => {
        await q.query('select public.record_usage($1, $2, $3)', [userId, 'tokens', total])
      })
    } catch (error) {
      console.error('[gateway:usage]', error)
    }
  }
}

gatewayRoutes.get('/models', async (c) => {
  const cfg = (await loadPlatformConfig(c.get('userId'))) as PlatformConfigLite | null
  return c.json({ models: cfg?.models ?? [] })
})

gatewayRoutes.post('/chat/completions', async (c) => {
  const userId = c.get('userId')
  const payload = (await c.req.json().catch(() => null)) as {
    model?: string
    messages?: unknown
    tools?: unknown
    temperature?: number
  } | null
  if (!payload || typeof payload.model !== 'string' || !Array.isArray(payload.messages)) {
    return jsonErr(c, 400, 'invalid_request', 'model and messages are required.')
  }

  const cfg = (await loadPlatformConfig(userId)) as PlatformConfigLite | null
  const features = cfg?.features ?? {}
  if (!features.cloud_models) {
    return jsonErr(c, 402, 'plan_required', 'Cloud models require an upgraded plan.')
  }

  const model = (cfg?.models ?? []).find((entry) => entry.modelId === payload.model)
  if (!model) return jsonErr(c, 404, 'unknown_model', `Model "${payload.model}" is not available.`)
  if (!model.allowed) return jsonErr(c, 403, 'model_not_allowed', `Your plan does not include ${model.label}.`)

  const limit = typeof cfg?.limits?.tokens === 'number' ? cfg.limits.tokens : null
  const used = (cfg?.usage ?? []).find((entry) => entry.resource === 'tokens')?.used ?? 0
  if (limit !== null && used >= limit) {
    return jsonErr(c, 429, 'quota_exceeded', 'Your monthly token quota is used up. Upgrade to continue.')
  }

  const upstream = await resolveUpstream(model.providerId)
  if (!upstream) {
    return jsonErr(
      c,
      502,
      'provider_unavailable',
      'No upstream is configured for this model. Add a provider key, or enable the Neon AI Gateway.'
    )
  }

  const upstreamBody: Record<string, unknown> = {
    model: payload.model,
    messages: payload.messages,
    stream: true,
    stream_options: { include_usage: true }
  }
  if (payload.tools) upstreamBody.tools = payload.tools
  if (typeof payload.temperature === 'number') upstreamBody.temperature = payload.temperature

  let upstreamRes: Response
  try {
    upstreamRes = await fetch(`${upstream.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${upstream.apiKey}` },
      body: JSON.stringify(upstreamBody),
      signal: c.req.raw.signal
    })
  } catch (error) {
    return jsonErr(c, 502, 'upstream_unreachable', `Upstream request failed: ${(error as Error).message}`)
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    const detail = await upstreamRes.text().catch(() => '')
    return jsonErr(c, upstreamRes.status || 502, 'upstream_error', detail.slice(0, 300) || 'Upstream request failed.')
  }

  const [toClient, toTap] = upstreamRes.body.tee()
  try {
    waitUntil(tapUsage(toTap, userId))
  } catch {
    void tapUsage(toTap, userId)
  }

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
