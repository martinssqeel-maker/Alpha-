import { describe, expect, it } from 'vitest'
import {
  MAX_NAME_LENGTH,
  fullNameProblem,
  normalizeFullName,
  normalizePhone,
  phoneProblem,
  readProfileUpdate
} from '../platform/api/profile'

// These are the rules the sign-up form repeats in its own words; both sides are
// asserted here so a change to one cannot silently loosen the other.

describe('full name', () => {
  it('collapses whitespace and drops control characters', () => {
    expect(normalizeFullName('  Ada\n\tLovelace  ')).toBe('Ada Lovelace')
    expect(normalizeFullName('Ada\u0000Lovelace')).toBe('AdaLovelace')
  })

  it('ignores anything that is not a string', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      expect(normalizeFullName(value)).toBe('')
    }
  })

  it('accepts a name in any script', () => {
    for (const name of ['Ada Lovelace', 'Renée Dubois', 'Ada', 'محمد علي', '李小龙']) {
      expect(fullNameProblem(name), name).toBeNull()
    }
  })

  it('refuses an empty, one-character or non-alphabetic name', () => {
    expect(fullNameProblem('')).toMatch(/full name/i)
    expect(fullNameProblem('A')).toMatch(/full name/i)
    expect(fullNameProblem('12345')).toMatch(/full name/i)
  })

  it('caps the length at the same number the form allows', () => {
    expect(fullNameProblem('a'.repeat(MAX_NAME_LENGTH))).toBeNull()
    expect(fullNameProblem('a'.repeat(MAX_NAME_LENGTH + 1))).toMatch(/80 characters/)
  })
})

describe('phone number', () => {
  it('reduces the ways people type a number to plus and digits', () => {
    const expected = '+15550102030'
    for (const input of ['+1 (555) 010-2030', '+1.555.010.2030', '+1 555 010 2030', ' +15550102030 ']) {
      expect(normalizePhone(input), input).toBe(expected)
    }
  })

  it('keeps a national number without a country code as typed', () => {
    expect(normalizePhone('555 010 2030')).toBe('5550102030')
  })

  it('returns an empty string when there are no digits at all', () => {
    expect(normalizePhone('')).toBe('')
    expect(normalizePhone('not a number')).toBe('')
    expect(normalizePhone(undefined)).toBe('')
  })

  it('checks the digit count, not the punctuation', () => {
    expect(phoneProblem('+15550102030')).toBeNull()
    expect(phoneProblem('5550102')).toBeNull()
    expect(phoneProblem('555010')).toMatch(/at least 7 digits/)
    expect(phoneProblem('+1234567890123456')).toMatch(/at most 15 digits/)
  })

  it('requires something to be entered', () => {
    expect(phoneProblem('')).toMatch(/phone number/i)
  })
})

// `PATCH /auth/me` is read by the same module that gates sign-up, so what an
// account can be saved with cannot drift from what it can be created with.
describe('a profile update', () => {
  it('refuses a body that changes nothing', () => {
    expect(readProfileUpdate({})).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(readProfileUpdate(undefined)).toMatchObject({ ok: false, code: 'invalid_request' })
    // Right shape, wrong types: they are not fields to write.
    expect(readProfileUpdate({ fullName: 42, phone: null })).toMatchObject({
      ok: false,
      code: 'invalid_request'
    })
  })

  it('writes only the fields that were sent', () => {
    const nameOnly = readProfileUpdate({ fullName: 'Ada Lovelace' })
    expect(nameOnly).toEqual({
      ok: true,
      sendsName: true,
      fullName: 'Ada Lovelace',
      sendsPhone: false,
      phone: null
    })

    const phoneOnly = readProfileUpdate({ phone: '+1 (555) 010-2030' })
    expect(phoneOnly).toEqual({
      ok: true,
      sendsName: false,
      fullName: null,
      sendsPhone: true,
      phone: '+15550102030'
    })
  })

  it('holds a saved name to the rule sign-up enforces', () => {
    expect(readProfileUpdate({ fullName: 'Ada Lovelace' })).toMatchObject({ ok: true })
    expect(readProfileUpdate({ fullName: 'A' })).toMatchObject({ ok: false, code: 'invalid_name' })
    expect(readProfileUpdate({ fullName: '  ' })).toMatchObject({ ok: false, code: 'invalid_name' })
    expect(readProfileUpdate({ fullName: 'a'.repeat(MAX_NAME_LENGTH + 1) })).toMatchObject({
      ok: false,
      code: 'invalid_name'
    })
  })

  it('refuses a number that cannot be dialled, but accepts clearing one', () => {
    expect(readProfileUpdate({ phone: '555' })).toMatchObject({ ok: false, code: 'invalid_phone' })
    expect(readProfileUpdate({ phone: '+1234567890123456' })).toMatchObject({
      ok: false,
      code: 'invalid_phone'
    })
    // An empty number is how a person removes contact details, not a mistake.
    expect(readProfileUpdate({ phone: '' })).toEqual({
      ok: true,
      sendsName: false,
      fullName: null,
      sendsPhone: true,
      phone: null
    })
    expect(readProfileUpdate({ phone: '   ' })).toMatchObject({ ok: true, phone: null })
  })

  it('refuses a bad field even when the other one is fine', () => {
    expect(readProfileUpdate({ fullName: 'Ada Lovelace', phone: 'nope' })).toMatchObject({
      ok: false,
      code: 'invalid_phone'
    })
    expect(readProfileUpdate({ fullName: '', phone: '+15550102030' })).toMatchObject({
      ok: false,
      code: 'invalid_name'
    })
  })
})
