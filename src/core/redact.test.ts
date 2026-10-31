import { describe, expect, it } from 'vitest'
import { REDACTED, redactText, redactValue } from './redact.js'

describe('redactText', () => {
  it('AC-001 redacts secrets, sk- keys and bearer tokens', () => {
    const text = 'key sk-abcdefgh1234 and Authorization: Bearer abc.def-123456 and pass=hunter22'
    expect(redactText(text, ['hunter22'])).toBe(
      'key [REDACTED] and Authorization: Bearer [REDACTED] and pass=[REDACTED]',
    )
  })

  it('replaces longer secrets first so overlapping values disappear entirely', () => {
    expect(redactText('token=abcdefgh1234', ['abcdefgh', 'abcdefgh1234'])).toBe(`token=${REDACTED}`)
  })

  it('also redacts the JSON-escaped form of a secret, for text redacted after encoding', () => {
    const pem = '-----BEGIN KEY-----\nabc"def\\ghi\n-----END KEY-----'
    const encoded = JSON.stringify({ env: { KEY: pem } })
    expect(encoded).not.toContain(pem)
    const out = redactText(encoded, [pem])
    expect(out).not.toContain('abc\\"def')
    expect(JSON.parse(out)).toEqual({ env: { KEY: REDACTED } })
  })

  it('treats secrets literally rather than as patterns', () => {
    expect(redactText('a.b.c.d.e.f and axbxcxdxe', ['a.b.c.d.e'])).toBe(
      `${REDACTED}.f and axbxcxdxe`,
    )
  })

  it.each([
    ['ignores secrets shorter than 8 characters', 'test a test', ['test', 'a test'], 'test a test'],
    ['leaves short bearer values alone', 'bearer short', [], 'bearer short'],
    ['leaves short sk- prefixes alone', 'task-sk-1', [], 'task-sk-1'],
  ])('%s', (_name, text, secrets, expected) => {
    expect(redactText(text, secrets)).toBe(expected)
  })
})

describe('redactValue', () => {
  it('AC-002 redacts nested strings without mutating the input', () => {
    const value = { a: ['sk-abcdefgh1234'], b: { c: 1 } }
    const copy = structuredClone(value)
    expect(redactValue(value)).toEqual({ a: [REDACTED], b: { c: 1 } })
    expect(value).toEqual(copy)
  })

  it('never rewrites blob refs or id and hash fields', () => {
    const ref = `sha256:${'deadbeef'.padEnd(64, '0')}`
    const event = {
      t: 'tool_finished',
      callId: 'deadbeef_call',
      childRunIds: ['deadbeef_child_1', 'deadbeef_child_2'],
      shown: ref,
      response: { toolCalls: [{ id: 'deadbeef_1', name: 'login', input: { pin: 'deadbeef' } }] },
      agent: { fingerprint: 'deadbeef'.padEnd(64, 'a') },
      block: { inputHash: 'deadbeef'.padEnd(64, 'b') },
      messages: [ref],
    }
    expect(redactValue(event, ['deadbeef'])).toEqual({
      ...event,
      response: { toolCalls: [{ id: 'deadbeef_1', name: 'login', input: { pin: REDACTED } }] },
    })
  })

  it('copies id arrays, so freezing the result leaves the caller free to keep appending', () => {
    const childRunIds = ['run_1', 'run_2']
    const out = Object.freeze(redactValue({ childRunIds }).childRunIds)
    expect(out).toEqual(['run_1', 'run_2'])
    expect(out).not.toBe(childRunIds)
    childRunIds.push('run_3')
    expect(out).toEqual(['run_1', 'run_2'])
  })

  it('freezes every object and array it builds when asked, leaving the input and class instances alone', () => {
    const bytes = new Uint8Array([1])
    const input = { a: [{ b: 'sk-abcdefgh1234' }], childRunIds: ['r1', 'r2'], bytes }
    const out = redactValue(input, [], { freeze: true })
    expect(out).toEqual({ a: [{ b: REDACTED }], childRunIds: ['r1', 'r2'], bytes })
    for (const v of [out, out.a, out.a[0], out.childRunIds]) expect(Object.isFrozen(v)).toBe(true)
    expect(out.bytes).toBe(bytes)
    expect(
      Object.isFrozen(input) || Object.isFrozen(input.a) || Object.isFrozen(input.childRunIds),
    ).toBe(false)
    expect(Object.isFrozen(redactValue({ a: [1] }))).toBe(false)
  })

  it('returns non-string primitives unchanged', () => {
    expect(redactValue(42)).toBe(42)
    expect(redactValue(null)).toBeNull()
  })
})
