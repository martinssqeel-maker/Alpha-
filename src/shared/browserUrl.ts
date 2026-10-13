const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase()
  return LOOPBACK_HOSTS.has(normalized) || normalized.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

/** Normalize an address-bar value while limiting embedded navigation to HTTP(S). */
export function normalizePreviewUrl(input: string): string {
  const value = input.trim()
  if (!value) throw new Error('Enter a website or local preview address.')

  const explicitScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(value)
  let candidate = value
  if (!explicitScheme) {
    const authority = value.split(/[/?#]/, 1)[0].split('@').at(-1) ?? ''
    const host = authority.startsWith('[')
      ? authority.slice(0, authority.indexOf(']') + 1)
      : authority === '::1'
        ? authority
        : authority.split(':')[0]
    candidate = `${isLoopbackHost(host) ? 'http' : 'https'}://${value}`
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('That address is not valid. Enter a URL such as http://localhost:3000.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Preview only supports HTTP and HTTPS addresses.')
  }
  if (!url.hostname || url.username || url.password) {
    throw new Error('Preview addresses cannot contain credentials and must include a host.')
  }
  return url.toString()
}
