// Shared helpers for Alpha platform edge functions.
// Runs on Deno (Supabase Edge Functions). Uses the service role key to read
// the authoritative entitlement/usage tables; the caller is always re-verified
// from their bearer token.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

export function errorPayload(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status)
}

let adminClient: SupabaseClient | null = null
export function admin(): SupabaseClient {
  if (adminClient) return adminClient
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('Supabase env vars are not configured for this function.')
  adminClient = createClient(url, key, { auth: { persistSession: false } })
  return adminClient
}

export interface AuthedUser {
  id: string
  email?: string
}

export async function verifyUser(req: Request): Promise<AuthedUser | null> {
  const header = req.headers.get('Authorization') ?? ''
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const { data, error } = await admin().auth.getUser(token)
  if (error || !data.user) return null
  return { id: data.user.id, email: data.user.email ?? undefined }
}

// ---------------------------------------------------------------------------
// catalog + access + entitlement + usage
// ---------------------------------------------------------------------------
export interface ModelRow {
  id: string
  model_id: string
  label: string
  capabilities: { streaming?: boolean; tools?: boolean; vision?: boolean }
  context_length: number | null
  default_allowed: boolean
  provider: {
    id: string
    code: string
    label: string
    kind: string
    base_url: string | null
    api_key_env: string | null
    active: boolean
  }
}

export async function resolveModel(modelId: string): Promise<ModelRow | null> {
  const { data } = await admin()
    .from('ai_models')
    .select('id, model_id, label, capabilities, context_length, default_allowed, active, ai_providers(id, code, label, kind, base_url, api_key_env, active)')
    .eq('model_id', modelId)
    .eq('active', true)
    .maybeSingle()
  if (!data) return null
  const provider = (data as Record<string, unknown>).ai_providers as ModelRow['provider']
  if (!provider || !provider.active) return null
  return {
    id: data.id,
    model_id: data.model_id,
    label: data.label,
    capabilities: data.capabilities ?? {},
    context_length: data.context_length,
    default_allowed: data.default_allowed,
    provider
  }
}

export async function activePlanId(userId: string): Promise<string | null> {
  const { data } = await admin()
    .from('subscriptions')
    .select('plan_id')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data?.plan_id as string) ?? null
}

export async function modelAllowed(userId: string, model: ModelRow, planId: string | null): Promise<boolean> {
  const { data: override } = await admin()
    .from('model_user_access')
    .select('allowed, ends_at')
    .eq('model_id', model.id)
    .eq('user_id', userId)
    .maybeSingle()
  if (override && (!override.ends_at || new Date(override.ends_at as string) > new Date())) {
    return Boolean(override.allowed)
  }
  if (planId) {
    const { data: access } = await admin()
      .from('model_plan_access')
      .select('allowed')
      .eq('model_id', model.id)
      .eq('plan_id', planId)
      .maybeSingle()
    if (access) return Boolean(access.allowed)
  }
  return model.default_allowed
}

export async function entitlement(userId: string, feature: string): Promise<unknown> {
  const { data } = await admin().rpc('check_entitlement', { p_user: userId, p_feature: feature })
  return data
}

export interface UsageCheck {
  resource: string
  used: number
  limit: number | null
}

export async function usageFor(userId: string, resource: string): Promise<UsageCheck> {
  const periodStart = new Date()
  periodStart.setUTCDate(1)
  const key = periodStart.toISOString().slice(0, 10)
  const { data } = await admin()
    .from('usage_counters')
    .select('used')
    .eq('user_id', userId)
    .eq('resource', resource)
    .eq('period_start', key)
    .maybeSingle()
  const limitRaw = await entitlement(userId, `limit.${resource}`)
  const limit = typeof limitRaw === 'number' ? limitRaw : null
  return { resource, used: Number(data?.used ?? 0), limit }
}

export async function recordUsage(userId: string, resource: string, amount: number): Promise<void> {
  if (amount <= 0) return
  await admin().rpc('record_usage', { p_user: userId, p_resource: resource, p_amount: amount })
}

export async function recordAudit(userId: string, action: string, detail: unknown): Promise<void> {
  try {
    await admin().from('audit_logs').insert({ actor_id: userId, action, detail })
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// provider key resolution
// ---------------------------------------------------------------------------
export function providerKey(envName: string | null): string | null {
  if (!envName) return null
  return Deno.env.get(envName) ?? null
}

// ---------------------------------------------------------------------------
// message/tool conversion (our shape -> provider wire shapes)
// ---------------------------------------------------------------------------
export interface WireMessage {
  role: string
  content: unknown
  name?: string
  toolCalls?: { id: string; name: string; arguments: unknown }[]
  toolCallId?: string
  images?: string[]
}

export interface WireTool {
  name: string
  description?: string
  parameters?: unknown
}

export function toOpenAIMessages(messages: WireMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments ?? {}) }
        }))
      }
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    }
    if (m.images?.length) {
      const parts: unknown[] = []
      if (m.content) parts.push({ type: 'text', text: m.content })
      for (const img of m.images) parts.push({ type: 'image_url', image_url: { url: img } })
      return { role: m.role, content: parts.length === 1 && !m.content ? parts : parts }
    }
    return { role: m.role, content: m.content }
  })
}

export function toOpenAITools(tools?: WireTool[]): unknown[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } }
  }))
}

function dataUrlToImage(value: string): { media_type: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/.exec(value)
  if (m) return { media_type: m[1], data: m[2] }
  return null
}

export function toAnthropicMessages(messages: WireMessage[]): { system?: string; messages: unknown[] } {
  let system: string | undefined
  const out: unknown[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      system = system ? system + '\n\n' + m.content : m.content
      continue
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
      })
      continue
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: unknown[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const t of m.toolCalls) {
        content.push({
          type: 'tool_use',
          id: t.id,
          name: t.name,
          input: typeof t.arguments === 'string' ? safeParse(t.arguments) : (t.arguments ?? {})
        })
      }
      out.push({ role: 'assistant', content })
      continue
    }
    if (m.images?.length) {
      const content: unknown[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const img of m.images) {
        const parsed = dataUrlToImage(img)
        if (parsed) content.push({ type: 'image', source: { type: 'base64', media_type: parsed.media_type, data: parsed.data } })
      }
      out.push({ role: 'user', content })
      continue
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })
  }
  return { system, messages: out }
}

export function toAnthropicTools(tools?: WireTool[]): unknown[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters ?? { type: 'object', properties: {} }
  }))
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

export function readModelList(messages: WireMessage[]): string {
  // rough prompt size estimate for pre-flight logging
  return messages.map((m) => m.content ?? '').join('\n')
}