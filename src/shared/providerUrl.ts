import type { ProviderKind } from './types'

/**
 * Validate a user-supplied provider endpoint.
 *
 * Returns a human-readable problem, or null when the value is acceptable.
 *
 * What this is for: `baseUrl` is typed by the user and every request for that
 * provider is sent to it, so it must at least be a plain http(s) URL. Two things
 * are deliberately *not* blocked:
 *
 *  - private and loopback addresses. This is a desktop app whose core feature is
 *    talking to servers the user runs (`127.0.0.1:11434` for Ollama, `:1234` for
 *    LM Studio), so blocking them would break the product. The request is made
 *    from the user's own machine for the user's own benefit.
 *  - paths under the host: proxies and gateways legitimately live at
 *    `https://host/openai/v1`.
 *
 * Credentials in the URL *are* refused: `https://user:key@host` would write an
 * API key into settings, logs and error messages in plain text, where the OS
 * credential store is the only place a key belongs.
 */
export function providerEndpointProblem(raw: string, kind: ProviderKind): string | null {
  const value = (raw ?? '').trim()
  if (!value) return 'Enter a base URL.'

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'That is not a valid URL. Include the scheme, for example http://127.0.0.1:11434 or https://api.example.com/v1.'
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Only http:// and https:// endpoints are supported.'
  }
  if (url.username || url.password) {
    return 'Remove the credentials from the URL — put the API key in the API key field so it is stored encrypted instead of in plain text.'
  }
  if (url.search || url.hash) {
    return 'Remove the query string and fragment from the base URL.'
  }
  if (kind === 'ollama' && url.pathname.replace(/\/+$/, '') !== '') {
    return 'An Ollama endpoint is the server root, for example http://127.0.0.1:11434 — do not add a path.'
  }
  return null
}

/** True when the endpoint is safe to save and call. */
export function isProviderEndpointValid(raw: string, kind: ProviderKind): boolean {
  return providerEndpointProblem(raw, kind) === null
}
