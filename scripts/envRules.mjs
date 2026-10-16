/**
 * Rules `deploy.mjs` enforces on the environment file before it pushes anything
 * to the live Function.
 *
 * Why these live apart from the deploy script: that script runs a deploy the
 * moment it is imported, so nothing inside it can be exercised by a test. Every
 * function here is pure — it takes the parsed environment and returns the
 * problems it found — which is what lets the rules be tested directly.
 *
 * Rule in this file, and the reason it exists:
 *   A provider only ever sends the authorization code to the *exact* URL
 *   registered in its own console. The API derives that URL from
 *   `GOOGLE_REDIRECT_URI` / `GITHUB_REDIRECT_URI` when they are set, so a value
 *   that is merely the site origin (no `/auth/<provider>/callback` path) makes
 *   Google answer `redirect_uri_mismatch` and makes GitHub return the code to
 *   the site root, where no page can exchange it — both providers look equally
 *   "broken" and nothing in the logs says why. That happened once; this refuses
 *   to deploy it again.
 */

/** Callback keys we know how to check, and the path each one must end with. */
const CALLBACK_KEYS = {
  GOOGLE_REDIRECT_URI: 'google',
  GITHUB_REDIRECT_URI: 'github'
}

/** Hostnames where a plain-http callback is legitimate (local development). */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Problems with the configured provider callback URLs.
 *
 * An unset key is not a problem: the API then derives the callback from the
 * request URL, which is correct for local runs. A set key must name the
 * callback route over https.
 *
 * @param {Record<string, string>} env parsed environment (see `parseEnvFile`)
 * @returns {string[]} human-readable problems, empty when the env is fine
 */
export function callbackUrlProblems(env) {
  const problems = []
  for (const [key, provider] of Object.entries(CALLBACK_KEYS)) {
    const value = (env[key] ?? '').trim()
    if (!value) continue

    const expectedPath = `/auth/${provider}/callback`
    let url
    try {
      url = new URL(value)
    } catch {
      problems.push(`${key} is not a valid absolute URL: ${value}`)
      continue
    }

    // Compare the path without a trailing slash, so `.../callback/` is accepted.
    const normalised = url.pathname.replace(/\/+$/, '') || '/'
    if (normalised !== expectedPath) {
      problems.push(
        `${key} must be the callback route, but is "${value}" (path "${normalised}"). ` +
          `A provider only sends the code to the URL registered in its own console, so this ` +
          `makes sign-in fail as redirect_uri_mismatch or returns the code to a page that ` +
          `cannot exchange it. Set it to https://<your-site>${expectedPath}.`
      )
    }

    if (url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) {
      problems.push(
        `${key} uses ${url.protocol}// — providers only return to https (localhost excepted). ` +
          `Set it to https://<your-site>${expectedPath}.`
      )
    }
  }
  return problems
}
