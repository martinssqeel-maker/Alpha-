// Alpha AI gateway — the single server-side chokepoint for cloud model traffic.
// Verifies the caller, resolves the model, enforces plan/entitlement + usage
// limits, calls the upstream provider with a server-held key, streams the reply
// back (OpenAI-compatible SSE) and records usage.
import {
  admin,
  corsHeaders,
  errorPayload,
  json,
  modelAllowed,
  activePlanId,
  providerKey,
  recordUsage,
  resolveModel,
  usageFor,
  entitlement,
  verifyUser,
  toOpenAIMessages,
  toOpenAITools,
  toAnthropicMessages,
  toAnthropicTools,
  type ModelRow,
  type WireMessage,
  type WireTool
} from '../_shared/platform.ts'

interface ChatBody {
  action: 'chat' | 'models' | 'status'
  model?: string
  messages?: WireMessage[]
  tools?: WireTool[]
  stream?: boolean
  temperature?: number
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return errorPayload('method_not_allowed', 'Use POST.', 405)

  let body: ChatBody
  try {
    body = (await req.json()) as ChatBody
  } catch {
    return errorPayload('bad_request', 'Invalid JSON body.', 400)
  }
  const action = body.action ?? 'chat'

  const user = await verifyUser(req)
  if (!user) return errorPayload('unauthorized', 'Sign in required.', 401)

  try {
    if (action === 'models') return await listModels(user.id)
    if (action === 'status') {
      const res = await listModels(user.id)
      const parsed = (await res.json()) as { models?: unknown[] }
      return json({ ok: true, models: parsed.models?.length ?? 0 })
    }
    return await chat(user.id, body)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return errorPayload('internal', message, 500)
  }
})

async function listModels(userId: string): Promise<Response> {
  const { data } = await admin()
    .from('ai_models')
    .select('id, model_id, label, capabilities, context_length, parameter_size, family, default_allowed, ai_providers(code, label, active)')
    .eq('active', true)
    .order('label')
  const planId = await activePlanId(userId)
  const out: unknown[] = []
  for (const m of data ?? []) {
    const provider = (m as Record<string, unknown>).ai_providers as { active?: boolean } | null
    if (!provider?.active) continue
    const model: ModelRow = {
      id: m.id,
      model_id: m.model_id,
      label: m.label,
      capabilities: m.capabilities ?? {},
      context_length: m.context_length,
      default_allowed: m.default_allowed,
      provider: provider as ModelRow['provider']
    }
    const allowed = await modelAllowed(userId, model, planId)
    if (!allowed) continue
    out.push({
      id: m.model_id,
      name: m.label,
      capabilities: model.capabilities,
      contextLength: m.context_length,
      parameterSize: m.parameter_size,
      family: m.family
    })
  }
  return json({ models: out })
}

async function chat(userId: string, body: ChatBody): Promise<Response> {
  const modelId = body.model
  if (!modelId) return errorPayload('bad_request', 'Missing model.', 400)
  const messages = body.messages ?? []
  if (!messages.length) return errorPayload('bad_request', 'Missing messages.', 400)

  const model = await resolveModel(modelId)
  if (!model) return errorPayload('model_not_found', `Model "${modelId}" is not available.`, 404)

  const planId = await activePlanId(userId)
  const allowed = await modelAllowed(userId, model, planId)
  if (!allowed) return errorPayload('plan_required', 'This model is not included in your plan.', 403)

  const feature = await entitlement(userId, 'cloud_models')
  if (feature === false) return errorPayload('plan_required', 'Cloud models are not enabled for your account.', 403)

  const usage = await usageFor(userId, 'tokens')
  if (usage.limit !== null && usage.limit > 0 && usage.used >= usage.limit) {
    return errorPayload('quota_exceeded', 'You have reached your token limit for this period.', 402)
  }
  if (usage.limit === 0) {
    return errorPayload('plan_required', 'Cloud model usage is not included in your plan.', 403)
  }

  const key = providerKey(model.provider.api_key_env)
  if (!key) {
    return errorPayload('provider_unconfigured', `Provider "${model.provider.label}" is not configured on the server.`, 503)
  }

  const kind = model.provider.kind
  if (kind === 'openai' || kind === 'openai-compatible') {
    return streamOpenAI(userId, model, key, body)
  }
  if (kind === 'anthropic') {
    return streamAnthropic(userId, model, key, body)
  }
  return errorPayload('provider_unsupported', `Provider kind "${kind}" is not supported yet.`, 501)
}

// ---------------------------------------------------------------------------
// OpenAI-compatible upstream (passthrough stream + usage capture)
// ---------------------------------------------------------------------------
async function streamOpenAI(userId: string, model: ModelRow, key: string, body: ChatBody): Promise<Response> {
  const base = (model.provider.base_url ?? '').replace(/\/+$/, '')
  const url = `${base}/chat/completions`
  const payload = {
    model: model.model_id,
    messages: toOpenAIMessages(body.messages ?? []),
    tools: toOpenAITools(body.tools),
    stream: true,
    stream_options: { include_usage: true },
    temperature: body.temperature
  }
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload)
  })
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    return errorPayload('upstream_error', text || `Upstream returned ${upstream.status}.`, upstream.status || 502)
  }
  return sseResponse(async (send) => {
    const reader = upstream.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          send('data: [DONE]\n\n')
          continue
        }
        try {
          const obj = JSON.parse(data) as { usage?: { total_tokens?: number } }
          if (obj.usage?.total_tokens) total = obj.usage.total_tokens
        } catch {
          /* keep streaming */
        }
        send(`data: ${data}\n\n`)
      }
    }
    if (total > 0) await recordUsage(userId, 'tokens', total)
    await recordUsage(userId, 'requests', 1)
  })
}

// ---------------------------------------------------------------------------
// Anthropic upstream (translated to OpenAI-compatible SSE)
// ---------------------------------------------------------------------------
async function streamAnthropic(userId: string, model: ModelRow, key: string, body: ChatBody): Promise<Response> {
  const base = (model.provider.base_url ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '')
  const url = `${base}/messages`
  const { system, messages } = toAnthropicMessages(body.messages ?? [])
  const payload: Record<string, unknown> = {
    model: model.model_id,
    max_tokens: 4096,
    stream: true,
    messages,
    temperature: body.temperature
  }
  if (system) payload.system = system
  const tools = toAnthropicTools(body.tools)
  if (tools) payload.tools = tools

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload)
  })
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    return errorPayload('upstream_error', text || `Upstream returned ${upstream.status}.`, upstream.status || 502)
  }

  return sseResponse(async (send) => {
    const reader = upstream.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let event = ''
    let inputTokens = 0
    let outputTokens = 0
    const blockToTool = new Map<number, number>()
    let toolCount = 0

    const handleEvent = (ev: string, data: string) => {
      if (!data) return
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(data)
      } catch {
        return
      }
      const type = (obj.type as string) ?? ev
      if (type === 'message_start') {
        const usage = (obj.message as { usage?: { input_tokens?: number } })?.usage
        inputTokens = usage?.input_tokens ?? 0
      } else if (type === 'content_block_start') {
        const block = obj.content_block as { type?: string; id?: string; name?: string }
        const index = obj.index as number
        if (block?.type === 'tool_use') {
          const toolIndex = toolCount++
          blockToTool.set(index, toolIndex)
          send(openAiChunk({
            tool_calls: [{ index: toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }]
          }))
        }
      } else if (type === 'content_block_delta') {
        const delta = obj.delta as { type?: string; text?: string; partial_json?: string }
        const index = obj.index as number
        if (delta?.type === 'text_delta' && delta.text) {
          send(openAiChunk({ content: delta.text }))
        } else if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined) {
          const toolIndex = blockToTool.get(index)
          if (toolIndex !== undefined) {
            send(openAiChunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] }))
          }
        }
      } else if (type === 'message_delta') {
        const usage = obj.usage as { output_tokens?: number }
        outputTokens = usage?.output_tokens ?? outputTokens
        const stop = (obj.delta as { stop_reason?: string })?.stop_reason
        if (stop) send(openAiChunk({}, stop === 'end_turn' ? 'stop' : stop))
      } else if (type === 'message_stop') {
        send('data: [DONE]\n\n')
      }
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        const trimmed = line.trimEnd()
        if (trimmed === '') {
          if (event || buffer === '') {
            // blank line terminates an event block (data already handled below)
          }
          event = ''
          continue
        }
        if (trimmed.startsWith('event:')) {
          event = trimmed.slice(6).trim()
        } else if (trimmed.startsWith('data:')) {
          handleEvent(event, trimmed.slice(5).trim())
        }
      }
    }
    const total = inputTokens + outputTokens
    if (total > 0) await recordUsage(userId, 'tokens', total)
    await recordUsage(userId, 'requests', 1)
  })
}

// ---------------------------------------------------------------------------
// streaming helpers
// ---------------------------------------------------------------------------
function openAiChunk(delta: Record<string, unknown>, finishReason?: string): string {
  const choice: Record<string, unknown> = { delta, index: 0 }
  if (finishReason) choice.finish_reason = finishReason
  return `data: ${JSON.stringify({ choices: [choice] })}\n\n`
}

function sseResponse(run: (send: (chunk: string) => void) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string): void => {
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          /* client disconnected */
        }
      }
      try {
        await run(send)
      } catch (e) {
        send(openAiChunk({ content: `\n[gateway error] ${e instanceof Error ? e.message : String(e)}` }))
      } finally {
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
    }
  })
  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    }
  })
}
