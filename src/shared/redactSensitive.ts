const SENSITIVE_KEYS = [
  'apikey',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'authtoken',
  'token',
  'secret',
  'clientsecret',
  'password',
  'passwd',
  'credential',
  'authorization',
  'cookie',
  'privatekey',
  'otp',
  'magictoken'
]

const STRING_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, '[REDACTED TOKEN]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}={0,2}/gi, '$1[REDACTED]'],
  [/\b((?:[A-Z0-9_.-]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|AUTHORIZATION|SESSION[_-]?TOKEN))\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]'],
  [/\b((?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/)[^:\s/]+:[^@\s/]+@/gi, '$1[REDACTED]@'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED TOKEN]'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]']
]

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return SENSITIVE_KEYS.some((sensitive) => normalized === sensitive || normalized.endsWith(sensitive))
}

export function redactSensitiveText(value: string): string {
  return STRING_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
}

/** Return a display-only copy with common secret fields and token formats redacted. */
export function redactSensitiveValue(value: unknown, parentKey = ''): unknown {
  if (isSensitiveKey(parentKey) && value !== null && value !== undefined && value !== '') {
    return '[REDACTED]'
  }
  if (typeof value === 'string') return redactSensitiveText(value)
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactSensitiveValue(nested, key)])
    )
  }
  return value
}
