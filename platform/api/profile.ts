/**
 * Profile fields collected at sign-up: a name, and a phone number.
 *
 * The rules live here rather than inside the route so they can be unit tested
 * without a database, and so the account page can state the same requirement the
 * server enforces instead of inventing a stricter one of its own.
 */

export const MAX_NAME_LENGTH = 80
const MIN_PHONE_DIGITS = 7
const MAX_PHONE_DIGITS = 15

/** Collapse whitespace and drop control characters; never trims a name to nothing. */
export function normalizeFullName(input: unknown): string {
  if (typeof input !== 'string') return ''
  // Tabs and newlines are word separators in a pasted name, so they become a
  // space; dropping them outright turned "Ada\nLovelace" into "AdaLovelace".
  return input
    .replace(/[\t\n\r\f\v]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Human-readable reason a name is unacceptable, or null when it passes. */
export function fullNameProblem(name: string): string | null {
  if (name.length < 2) return 'Enter your full name.'
  if (name.length > MAX_NAME_LENGTH) {
    return `Use ${MAX_NAME_LENGTH} characters or fewer for your name.`
  }
  if (!/\p{L}/u.test(name)) return 'Enter your full name.'
  return null
}

/**
 * Reduce a typed number to an E.164-ish string: an optional leading `+` and the
 * digits. People paste `+1 (555) 010-2030`, `+1.555.010.2030` or `5550102030`,
 * and all three should land in one shape.
 */
export function normalizePhone(input: unknown): string {
  if (typeof input !== 'string') return ''
  const trimmed = input.trim()
  if (!trimmed) return ''
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return ''
  return `${trimmed.startsWith('+') ? '+' : ''}${digits}`
}

/** Human-readable reason a phone number is unacceptable, or null when it passes. */
export function phoneProblem(phone: string): string | null {
  if (!phone) return 'Enter your phone number.'
  const digits = phone.replace(/\D/g, '')
  if (digits.length < MIN_PHONE_DIGITS) {
    return 'Enter a phone number with at least 7 digits, including the country code.'
  }
  if (digits.length > MAX_PHONE_DIGITS) {
    return `Enter a phone number with at most ${MAX_PHONE_DIGITS} digits.`
  }
  return null
}
