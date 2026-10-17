// Desktop release metadata + the access rules for the download surface.

export interface ReleaseInfo {
  version: string
  channel: string
  platform: string
  notes: string | null
  url: string
  size: number | null
  sha512: string | null
  minimumSupportedVersion: string | null
  releasedAt: string | null
}

// Installers are served from the GitHub release assets, so only those hosts may
// ever be handed back to a client — an admin-supplied URL must not turn this
// endpoint into an open redirect.
const ASSET_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'api.github.com'
])

export function assetHostAllowed(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && ASSET_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** Shape a `public.releases` row for clients, or null when it is unusable. */
export function normalizeRelease(row: Record<string, unknown> | null | undefined): ReleaseInfo | null {
  if (!row) return null
  const url = text(row.installer_url) ?? text(row.url)
  const version = text(row.version)
  if (!url || !version) return null
  if (!assetHostAllowed(url)) return null
  const size = Number.parseInt(String(row.installer_size ?? row.size ?? ''), 10)
  return {
    version,
    channel: text(row.channel) ?? 'stable',
    platform: text(row.platform) ?? 'win',
    notes: text(row.notes),
    url,
    size: Number.isFinite(size) ? size : null,
    sha512: text(row.sha512),
    minimumSupportedVersion: text(row.minimum_supported_version),
    releasedAt: text(row.released_at ?? row.created_at)
  }
}

export interface DownloadGatingProblem {
  status: number
  code: string
  message: string
}

/**
 * Who may download: a signed-in user whose account is active. Suspended and
 * disabled accounts are refused server-side, not merely hidden in the UI.
 */
export function gatingProblem(user: { status?: string } | null | undefined): DownloadGatingProblem | null {
  if (!user) return { status: 401, code: 'unauthorized', message: 'Sign in to download Alpha AI Workspace.' }
  if (user.status !== 'active') {
    return { status: 403, code: 'account_inactive', message: 'This account is not active.' }
  }
  return null
}

/**
 * A password proves knowledge of a secret; it does not prove the address exists.
 * Accounts created with a password are therefore usable immediately — they can
 * sign in, see their plan and manage sessions — but the installer is withheld
 * until the emailed code has been redeemed once. Accounts from a provider are
 * marked verified by the provider's own confirmation (and accounts that predate
 * this rule are backfilled by migration 0005), so this only ever asks a person to
 * finish something they started.
 */
export function verificationProblem(
  user: { email_verified_at?: string | null } | null | undefined
): DownloadGatingProblem | null {
  if (!user) return null
  if (user.email_verified_at) return null
  return {
    status: 403,
    code: 'email_unverified',
    message: 'Confirm your email address to download. Enter the six-digit code we emailed you, or request a new one.'
  }
}
