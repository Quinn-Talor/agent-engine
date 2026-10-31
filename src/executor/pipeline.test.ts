import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { inputHash } from '../core/hash.js'
import { matchBlock } from '../core/facts.js'
import { fakeTool } from '../testing/fake-tool.js'
import { blockedError, lookupTool, suggest, validateInput } from './pipeline.js'
import { prepareTool, type PreparedTool } from './tools.js'

const toolset = new Map<string, PreparedTool>(
  ['search', 'fetch'].map((name) => [name, prepareTool(fakeTool({ name }), 'web')]),
)

describe('lookupTool', () => {
  it('finds a visible tool', () => {
    expect(lookupTool('search', toolset, new Set(['search']))).toEqual({
      tool: toolset.get('search'),
    })
  })

  it.each([
    [
      'AC-002 hidden tool',
      'fetch',
      '工具 fetch 本步不可见',
      '先调用 search_tool 查找并展开需要的工具',
    ],
    ['AC-002 misspelled tool', 'serch', '工具 serch 不存在', '你是不是想用 "search"'],
    [
      'unknown tool without a close match',
      'xyzzy',
      '工具 xyzzy 不存在',
      '先调用 search_tool 查找可用的工具',
    ],
  ])('%s', (_name, tool, message, hint) => {
    expect(lookupTool(tool, toolset, new Set(['search', 'search_tool']))).toEqual({
      error: { __agent_error: true, code: 'TOOL_NOT_AVAILABLE', message, hint },
    })
  })

  it('does not point to search_tool when the run has none', () => {
    const visible = new Set(['search'])
    expect(lookupTool('fetch', toolset, visible)).toMatchObject({
      error: { hint: '本步只能调用列出的工具' },
    })
    expect(lookupTool('xyzzy', toolset, visible)).toMatchObject({
      error: { hint: '本步只能调用列出的工具' },
    })
  })
})

describe('blocks', () => {
  it('AC-003 matches a call-level block and explains why', () => {
    const input = { q: 'same' }
    const block = {
      tool: 'search',
      inputHash: inputHash(input),
      code: 'repeat',
      reason: '重复调用',
      source: 'engine:roadblock',
      since: 2,
      until: Infinity,
    }
    const found = matchBlock([block], 3, 'search', inputHash({ q: '  same ' }))
    expect(found).toBe(block)
    expect(blockedError(found!)).toMatchObject({
      code: 'TOOL_BLOCKED',
      message: '该调用已被封住：重复调用（第 2 步）',
    })
    expect(matchBlock([block], 3, 'search', inputHash({ q: 'other' }))).toBeUndefined()
  })

  it('AC-018 tells the model why the call is blocked, what to do instead and what happens next', () => {
    const base = {
      tool: 'fetch',
      inputHash: 'h',
      code: 'failure_streak',
      source: 'engine:roadblock',
      since: 4,
      until: Infinity,
    }
    expect(
      blockedError({
        ...base,
        reason: '已失败 2 次（TOOL_TIMEOUT）',
        suggest: '换一种做法，或改用其他工具',
      }),
    ).toEqual({
      __agent_error: true,
      code: 'TOOL_BLOCKED',
      message: '该调用已被封住：已失败 2 次（TOOL_TIMEOUT）（第 4 步）',
      hint: '换一种做法，或改用其他工具。再调用将收尾',
    })
    expect(blockedError({ ...base, reason: '连续 2 次返回相同结果' }).hint).toBe(
      '换一种做法，或改用其他工具。再调用将收尾',
    )
  })
})

describe('validateInput', () => {
  const search = prepareTool(
    fakeTool({
      name: 'search',
      inputSchema: z.object({ query: z.string(), limit: z.number().default(5) }),
    }),
    'web',
  )

  it('returns the parsed value with defaults', () => {
    expect(validateInput(search, { query: 'x' })).toEqual({ value: { query: 'x', limit: 5 } })
  })

  it('AC-004 explains missing fields and suggests the intended name', () => {
    const result = validateInput(search, { querry: 'x' })
    expect('error' in result).toBe(true)
    const error = (result as { error: { code: string; message: string; hint: string } }).error
    expect(error.code).toBe('INVALID_INPUT')
    expect(error.message).toContain('参数校验失败')
    expect(error.message).toContain('- query:')
    expect(error.message).toContain('缺少：query')
    expect(error.message).toContain('已提供：querry')
    expect(error.hint).toContain('期望的 schema：')
    expect(error.hint).toContain('你是不是想用 "query"（而不是 "querry"）')
  })

  it('describes non-object input', () => {
    const error = (validateInput(search, 'oops') as { error: { message: string } }).error
    expect(error.message).toContain('- (根):')
    expect(error.message).toContain('已提供：无')
  })

  it('AC-005 uses the tool-specific code for submit', () => {
    const submit = prepareTool(
      fakeTool({ name: 'submit', inputSchema: z.object({ answer: z.number() }) }),
      'deliverable',
      { invalidInputCode: 'OUTPUT_INVALID' },
    )
    expect(validateInput(submit, { answer: 'x' })).toMatchObject({
      error: { code: 'OUTPUT_INVALID' },
    })
  })
})

describe('suggest', () => {
  it.each([
    ['closest within two edits', 'serch', ['fetch', 'search'], 'search'],
    ['first among equals', 'ab', ['ac', 'ad'], 'ac'],
    ['nothing close', 'xyzzy', ['search'], undefined],
    ['identical names', 'abc', ['abc'], undefined],
    ['no candidates', 'x', [], undefined],
  ])('%s', (_name, target, candidates, expected) => {
    expect(suggest(target, candidates)).toBe(expected)
  })
})
