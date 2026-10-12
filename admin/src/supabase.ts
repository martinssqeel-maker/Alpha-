const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined || '').trim().replace(/\/+$/, '')

export const configured = Boolean(apiBase)

/**
 * Sessions written by the OTP era stored `email`, while the UI reads
 * `session.user.email`. Normalise on read so both shapes work.
 */
function normalise(s: any) {
  if (!s || !s.accessToken) return null
  const email = s.email || s.user?.email || ''
  return { ...s, email, user: { email } }
}

function getSession() {
  try {
    const raw = localStorage.getItem('alpha-admin-session')
    if (!raw) return null
    return normalise(JSON.parse(raw))
  } catch (e) {
    /* ignore */
  }
  return null
}

function setSession(s: any) {
  try {
    localStorage.setItem('alpha-admin-session', JSON.stringify(s))
  } catch (e) {
    /* ignore */
  }
}

function clearSession() {
  try {
    localStorage.removeItem('alpha-admin-session')
  } catch (e) {
    /* ignore */
  }
}

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: getSession() } }),
    onAuthStateChange: (cb: (event: string, session: any) => void) => {
      let current = getSession()
      const id = setInterval(() => {
        const s = getSession()
        if (JSON.stringify(s) !== JSON.stringify(current)) {
          current = s
          cb('SIGNED_IN', current)
        }
      }, 500)
      return { data: { subscription: { unsubscribe: () => clearInterval(id) } } }
    },
    /**
     * Administrator sign-in: email + password. The server decides whether the
     * account may administer anything — a non-admin gets the same generic
     * failure as a wrong password.
     */
    signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
      try {
        const res = await fetch(`${apiBase}/auth/password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || body?.ok === false) {
          return { error: { message: body?.error?.message || 'Sign-in failed' } }
        }
        if (body.accessToken && body.refreshToken) {
          setSession({ accessToken: body.accessToken, refreshToken: body.refreshToken, email: body.email })
        }
        return { error: null }
      } catch (e: any) {
        return { error: { message: e.message || 'Sign-in failed' } }
      }
    },
    signOut: async () => {
      const s = getSession()
      if (s) {
        fetch(`${apiBase}/auth/signout`, { method: 'POST', headers: { Authorization: `Bearer ${s.accessToken}` } }).catch(() => {})
      }
      clearSession()
      return { error: null }
    }
  }
}

export async function rpc<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T> {
  const s = getSession()
  if (!s) throw new Error('Not authenticated')
  // Parameters are sent by name; the server maps them onto the function signature
  // with Postgres named-argument notation, so key order here is irrelevant and
  // parameters with a server-side default can simply be omitted.
  const res = await fetch(`${apiBase}/admin/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.accessToken}` },
    body: JSON.stringify({ fn: name, params: params ?? {} })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) {
    const msg = body?.error?.message || 'Admin call failed'
    throw new Error(msg)
  }
  return body.result as T
}
