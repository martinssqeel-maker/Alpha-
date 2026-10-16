import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain ESM script, deliberately shared with the deploy script
import { callbackUrlProblems } from '../scripts/envRules.mjs'

/**
 * This is the rule that would have caught a real outage: `.env.local` carried
 * `GOOGLE_REDIRECT_URI=https://alpha-website-lime.vercel.app` (the site origin,
 * with no callback path), it was pushed to the live Function, and *both* Google
 * and GitHub sign-in stopped working — Google answered `redirect_uri_mismatch`
 * and the code GitHub sent came back to the site root, where no page exchanges
 * it. Nothing in the API logs named the cause.
 */
describe('deploy-time provider callback rules', () => {
  it('refuses the exact bare-origin pair that broke sign-in', () => {
    const problems = callbackUrlProblems({
      GOOGLE_REDIRECT_URI: 'https://alpha-website-lime.vercel.app',
      GITHUB_REDIRECT_URI: 'https://alpha-website-lime.vercel.app'
    })

    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('GOOGLE_REDIRECT_URI')
    expect(problems[0]).toContain('/auth/google/callback')
    expect(problems[1]).toContain('GITHUB_REDIRECT_URI')
    expect(problems[1]).toContain('/auth/github/callback')
  })

  it('accepts the callback route for each provider', () => {
    expect(
      callbackUrlProblems({
        GOOGLE_REDIRECT_URI: 'https://alpha-website-lime.vercel.app/auth/google/callback',
        GITHUB_REDIRECT_URI: 'https://alpha-website-lime.vercel.app/auth/github/callback'
      })
    ).toEqual([])
  })

  it('accepts an unset callback, since the API derives it from the request URL', () => {
    expect(callbackUrlProblems({})).toEqual([])
    expect(callbackUrlProblems({ GOOGLE_REDIRECT_URI: '', GITHUB_REDIRECT_URI: '   ' })).toEqual([])
  })

  it('tolerates a trailing slash', () => {
    expect(callbackUrlProblems({ GOOGLE_REDIRECT_URI: 'https://x.test/auth/google/callback/' })).toEqual([])
  })

  it('rejects a callback that points at some other page', () => {
    const problems = callbackUrlProblems({ GOOGLE_REDIRECT_URI: 'https://x.test/account' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('/account')
  })

  it("rejects one provider's callback on the other provider's key", () => {
    const problems = callbackUrlProblems({ GOOGLE_REDIRECT_URI: 'https://x.test/auth/github/callback' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('/auth/google/callback')
  })

  it('rejects a value that is not an absolute URL', () => {
    const problems = callbackUrlProblems({ GITHUB_REDIRECT_URI: '/auth/github/callback' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('not a valid absolute URL')
  })

  it('rejects plain http for a real host but allows it on localhost', () => {
    expect(callbackUrlProblems({ GOOGLE_REDIRECT_URI: 'http://x.test/auth/google/callback' })).toHaveLength(1)
    expect(callbackUrlProblems({ GOOGLE_REDIRECT_URI: 'http://localhost:8787/auth/google/callback' })).toEqual([])
    expect(callbackUrlProblems({ GOOGLE_REDIRECT_URI: 'http://127.0.0.1:8787/auth/google/callback' })).toEqual([])
  })

  it('reports a missing callback path once, not once per rule', () => {
    const problems = callbackUrlProblems({ GOOGLE_REDIRECT_URI: 'http://x.test' })
    expect(problems).toHaveLength(2)
  })
})
