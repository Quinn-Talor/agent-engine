import { describe, expect, it } from 'vitest'
import { classifyError } from './error-class.js'

describe('classifyError', () => {
  it.each([
    ['INVALID_INPUT', 'deterministic'],
    ['PERMISSION_DENIED', 'deterministic'],
    ['USER_DENIED', 'deterministic'],
    ['SPAWN_DEPTH_EXCEEDED', 'deterministic'],
    ['TOOL_TIMEOUT', 'transient'],
    ['TOOL_UNAVAILABLE', 'transient'],
    ['TOOL_EXCEPTION', 'transient'],
    ['TOOL_NOT_AVAILABLE', 'transient'],
    ['SUBAGENT_FAILED', 'transient'],
    ['MY_CODE', 'transient'],
    ['', 'transient'],
  ])('AC-001 classifies %s as %s', (code, expected) => {
    expect(classifyError(code)).toBe(expected)
  })
})
