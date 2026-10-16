import { createHash } from 'node:crypto'

/**
 * Pure guards for the shared-AI path.
 *
 * Kept free of database, Hono and environment imports on purpose: these are the
 * functions that decide how much allowance a request reserves, what a failure is
 * allowed to say, and what an operator is allowed to see about a credential.
 * All three are worth testing directly rather than through a live request.
 */

/** Request bodies are bounded before anything else looks at them. */
export const MAX_REQUEST_BYTES = 512 * 1024
export const MAX_OUTPUT_TOKENS = 8192
export const DEFAULT_OUTPUT_RESERVE = 1024
export const MIN_RESERVE = 256

/**
 * Provider error text can quote back a request header or a token. Nothing that
 * looks like a credential is ever forwarded to a client, and the string is
 * bounded so a provider cannot flood a response with junk.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|pk|gsk|xai|or)-[A-Za-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .slice(0, 300)
}

export function upstreamErrorMessage(detail: string): string {
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: unknown } }
    if (parsed?.error && typeof parsed.error.message === 'string' && parsed.error.message.trim()) {
      return redact(parsed.error.message.trim())
    }
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return redact(detail.trim()) || 'The provider rejected the request.'
}

/**
 * Map a provider failure onto something the product can act on, and never onto
 * "retry" when retrying cannot help: a rejected credential is a configuration
 * fault, not a transient one.
 */
export function upstreamFailure(status: number, detail: string): { http: number; code: string; message: string } {
  const message = upstreamErrorMessage(detail)
  if (status === 401 || status === 403) return { http: 502, code: 'provider_unauthorized', message }
  if (status === 402) return { http: 502, code: 'provider_credits_exhausted', message }
  if (status === 404) return { http: 502, code: 'provider_model_unavailable', message }
  if (status === 429) return { http: 429, code: 'provider_rate_limited', message }
  if (status >= 500) return { http: 502, code: 'provider_unavailable', message }
  return { http: 502, code: 'provider_error', message }
}

/**
 * ~4 characters per token, applied to the whole payload.
 *
 * Deliberately an over-estimate rather than a model-specific tokeniser: the
 * reservation is settled to the provider's real figure when the stream ends, so
 * over-estimating costs a user nothing, while under-estimating would let a
 * request slip past the cap before the real number is known.
 */
export function estimateInputTokens(value: unknown, byteCeiling = MAX_REQUEST_BYTES): number {
  let chars = 0
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || chars > byteCeiling) return
    if (typeof node === 'string') {
      chars += node.length
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (node && typeof node === 'object') {
      for (const item of Object.values(node)) walk(item, depth + 1)
    }
  }
  walk(value, 0)
  return Math.ceil(chars / 4)
}

/** Tokens to reserve for one request: the prompt estimate plus room for output. */
export function reservationFor(messages: unknown, maxTokens: unknown): number {
  const requested =
    typeof maxTokens === 'number' && Number.isFinite(maxTokens)
      ? Math.min(Math.max(Math.trunc(maxTokens), 0), MAX_OUTPUT_TOKENS)
      : DEFAULT_OUTPUT_RESERVE
  return Math.min(Math.max(estimateInputTokens(messages) + requested, MIN_RESERVE), MAX_REQUEST_BYTES)
}

// ── provider credentials ───────────────────────────────────────────────────

/** One row of the operator's view of a provider. Carries no secret, ever. */
export interface ProviderCredentialSummary {
  code: string
  label: string
  kind: string
  baseUrl: string | null
  apiKeyEnv: string
  active: boolean
  configured: boolean
  viaGateway: boolean
  keyFingerprint: string | null
  spendLimitUsd: number | null
  docsUrl: string | null
}

export interface ProviderRow {
  code: string
  label: string
  kind: string
  base_url: string | null
  api_key_env: string | null
  active: boolean
  spend_limit_usd: string | null
  docs_url: string | null
}

/**
 * A stable, non-reversible marker for a configured secret.
 *
 * It exists so an operator can confirm that a rotation *happened* without any
 * part of the key being sent to a browser. Eight hex characters of a SHA-256
 * digest cannot be turned back into a key.
 */
export function fingerprint(secret: string | null): string | null {
  if (!secret) return null
  return createHash('sha256').update(secret).digest('hex').slice(0, 8)
}

/**
 * Describe a provider for the administration API.
 *
 * `secret` is read only to answer two questions — is a credential present, and
 * does its fingerprint match what the operator last saw. It is never copied into
 * the result, so a response cannot leak it: the returned object has no field that
 * can hold a key.
 */
export function credentialSummary(
  row: ProviderRow,
  secret: string | null,
  viaGateway: boolean
): ProviderCredentialSummary {
  return {
    code: row.code,
    label: row.label,
    kind: row.kind,
    baseUrl: row.base_url,
    apiKeyEnv: row.api_key_env || `PROVIDER_API_KEY_${row.code.toUpperCase()}`,
    active: row.active,
    configured: viaGateway || Boolean(secret),
    viaGateway,
    keyFingerprint: fingerprint(secret),
    spendLimitUsd: row.spend_limit_usd === null ? null : Number(row.spend_limit_usd),
    docsUrl: row.docs_url
  }
}

/** A cost from tokens, using published list prices. Labelled an estimate by callers. */
export function estimateCostUsd(
  price: { input: number; output: number },
  promptTokens: number,
  completionTokens: number
): number {
  return (promptTokens / 1_000_000) * price.input + (completionTokens / 1_000_000) * price.output
}
