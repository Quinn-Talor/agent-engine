import { describe, expect, it } from 'vitest'
import {
  DefinitionError,
  MODEL_ERROR_CODES,
  ModelCallError,
  TOOL_ERROR_CODES,
  isModelCallError,
  isToolError,
  toolError,
} from './errors.js'

describe('tool error envelope', () => {
  it('AC-001 toolError builds an envelope that isToolError recognises', () => {
    const envelope = toolError('TOOL_TIMEOUT', 'timed out', 'retry later')
    expect(envelope).toEqual({
      __agent_error: true,
      code: 'TOOL_TIMEOUT',
      message: 'timed out',
      hint: 'retry later',
    })
    expect(isToolError(envelope)).toBe(true)
  })

  it('omits the hint key when no hint is given', () => {
    expect('hint' in toolError('X', 'm')).toBe(false)
  })

  it.each([
    ['plain object without marker', { code: 'X', message: 'm' }],
    ['string prefix', 'Tool execution failed: x'],
    ['null', null],
    ['marker that is not boolean true', { __agent_error: 'true', code: 'X', message: 'm' }],
  ])('AC-002 rejects %s', (_name, value) => {
    expect(isToolError(value)).toBe(false)
  })

  it('rejects a marker without string code or message', () => {
    expect(isToolError({ __agent_error: true, code: 1, message: 'm' })).toBe(false)
    expect(isToolError({ __agent_error: true, code: 'X' })).toBe(false)
  })
})

describe('error codes', () => {
  it('lists the tool and model error codes from the design', () => {
    expect(TOOL_ERROR_CODES).toEqual([
      'TOOL_NOT_AVAILABLE',
      'TOOL_BLOCKED',
      'INVALID_INPUT',
      'PERMISSION_DENIED',
      'USER_DENIED',
      'TOOL_UNAVAILABLE',
      'TOOL_TIMEOUT',
      'TOOL_ABORTED',
      'TOOL_EXCEPTION',
      'TOOL_MISSING_RESULT',
      'TOOL_INTERRUPTED',
      'OUTPUT_INVALID',
      'INTENT_NOT_ALONE',
      'SPAWN_DEPTH_EXCEEDED',
      'SPAWN_CYCLE',
      'SPAWN_BUDGET',
      'SPAWN_LIMIT',
    ])
    expect(MODEL_ERROR_CODES).toEqual([
      'MODEL_TIMEOUT',
      'MODEL_CONNECTION',
      'RATE_LIMITED',
      'AUTH_FAILED',
      'CONTEXT_TOO_LONG',
      'CONTENT_FILTER',
      'MODEL_ERROR',
      'MODEL_UNAVAILABLE',
    ])
  })
})

describe('ModelCallError', () => {
  it('carries the classified model error', () => {
    const detail = {
      code: 'RATE_LIMITED' as const,
      message: 'slow down',
      retryable: true,
      attempts: [],
    }
    const error = new ModelCallError(detail)
    expect(error.name).toBe('ModelCallError')
    expect(error.message).toBe('RATE_LIMITED: slow down')
    expect(error.detail).toBe(detail)
    expect(isModelCallError(error)).toBe(true)
    expect(isModelCallError(new Error('x'))).toBe(false)
  })
})

describe('DefinitionError', () => {
  it('carries the code and every issue', () => {
    const error = new DefinitionError('invalid_agent', ['id 不合法', 'instructions 不能为空'])
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('DefinitionError')
    expect(error.code).toBe('invalid_agent')
    expect(error.issues).toEqual(['id 不合法', 'instructions 不能为空'])
    expect(error.message).toBe('invalid_agent: id 不合法; instructions 不能为空')
  })
})
