import { describe, expect, it } from 'vitest'
import {
  checkResultIssue,
  guardOpinionIssue,
  memoryViewIssue,
  noticeResultIssue,
  permitResultIssue,
  visibleToolsIssue,
} from './component-results.js'

const block = { tool: 't', inputHash: 'h', code: 'failure_streak', reason: '连续失败' }

describe('guardOpinionIssue', () => {
  it.each([
    [{ warn: { problem: '连续失败' } }],
    [{ warn: { problem: '连续失败', suggest: '换个工具', block: [block] }, detail: '2/3' }],
    [{ warn: { problem: 'p', block: [{ ...block, suggest: '换个参数' }] } }],
    [{ awaitInput: { code: 'need_approval' } }],
    [{ end: { as: 'finalize', code: 'stall' } }],
    [{ end: { as: 'stop', code: 'blocked' }, detail: '依赖不可用' }],
  ])('accepts %j', (opinion) => {
    expect(guardOpinionIssue(opinion)).toBeUndefined()
  })

  it.each([
    [null, '对象'],
    ['warn', '对象'],
    [{}, '之一'],
    [{ warn: { problem: 'p' }, end: { as: 'stop', code: 'x' } }, '之一'],
    [{ warn: { problem: 'p' }, detail: 1 }, 'detail'],
    [{ warn: {} }, 'problem'],
    [{ warn: { problem: '' } }, 'problem'],
    [{ warn: { problem: 'p', suggest: 1 } }, 'suggest'],
    [{ warn: { problem: 'p', block: 'x' } }, 'block'],
    [{ warn: { problem: 'p', block: [{ tool: 't' }] } }, '封路'],
    [{ warn: { problem: 'p', block: [{ ...block, suggest: 1 }] } }, '封路'],
    [{ awaitInput: {} }, 'awaitInput'],
    [{ end: { as: 'stop' } }, 'end'],
    [{ end: { as: 'pause', code: 'x' } }, 'end'],
    [{ continue: {} }, '未知'],
  ])('rejects %j', (opinion, hint) => {
    expect(guardOpinionIssue(opinion)).toContain(hint)
  })
})

describe('checkResultIssue', () => {
  it.each([[{ pass: true }], [{ pass: false, issues: ['缺少引用'], hint: '补上来源' }]])(
    'accepts %j',
    (result) => {
      expect(checkResultIssue(result)).toBeUndefined()
    },
  )

  it.each([
    [null, '对象'],
    [{}, 'pass'],
    [{ pass: 'yes' }, 'pass'],
    [{ pass: false, issues: 'x' }, 'issues'],
    [{ pass: false, issues: [1] }, 'issues'],
    [{ pass: false, hint: 1 }, 'hint'],
  ])('rejects %j', (result, hint) => {
    expect(checkResultIssue(result)).toContain(hint)
  })
})

describe('memoryViewIssue', () => {
  it.each([
    [{}],
    [{ compaction: { upTo: 2, summary: '摘要' } }],
    [{ notice: '压缩暂时不可用' }],
    [{ compaction: { upTo: 1, summary: 's' }, notice: 'n' }],
  ])('accepts %j', (view) => {
    expect(memoryViewIssue(view)).toBeUndefined()
  })

  it.each([
    [null, '对象'],
    [{ compaction: { upTo: 0, summary: 's' } }, 'upTo'],
    [{ compaction: { upTo: 1.5, summary: 's' } }, 'upTo'],
    [{ compaction: { upTo: 2, summary: '' } }, 'summary'],
    [{ compaction: { replaced: [0, 2], summary: 's', anchorsKept: 1 } }, 'upTo'],
    [{ notice: 1 }, 'notice'],
  ])('rejects %j', (view, hint) => {
    expect(memoryViewIssue(view)).toContain(hint)
  })
})

describe('visibleToolsIssue', () => {
  it('accepts a list of tool names', () => {
    expect(visibleToolsIssue([])).toBeUndefined()
    expect(visibleToolsIssue(['search_tool', 'lookup'])).toBeUndefined()
  })

  it.each([[null], ['t'], [[1]], [['a', undefined]]])('rejects %j', (visible) => {
    expect(visibleToolsIssue(visible)).toContain('字符串数组')
  })
})

describe('noticeResultIssue', () => {
  it.each([
    [[]],
    [[{ role: 'system', parts: [{ type: 'text', text: '今天是周五' }] }]],
    [{ block: '不允许' }],
  ])('accepts %j', (result) => {
    expect(noticeResultIssue(result)).toBeUndefined()
  })

  it.each([
    [null],
    ['x'],
    [[{ role: 'user' }]],
    [[{ role: 'assistant', parts: [] }]],
    [{ block: 1 }],
  ])('rejects %j', (result) => {
    expect(noticeResultIssue(result)).toContain('Segment')
  })
})

describe('permitResultIssue', () => {
  it.each([
    ['allow'],
    [{ deny: '不行' }],
    [{ deny: 'hook 超时', unavailable: true }],
    [{ ask: { summary: '写文件', risk: 'high' } }],
    [
      {
        ask: { summary: '写文件', risk: 'low', detail: { paths: ['/a'], reason: 'r', input: 'i' } },
      },
    ],
  ])('accepts %j', (result) => {
    expect(permitResultIssue(result)).toBeUndefined()
  })

  it.each([
    [undefined, '只能是'],
    ['deny', '只能是'],
    [{}, '只能是'],
    [{ deny: 1 }, 'deny'],
    [{ deny: 'x', unavailable: false }, 'unavailable'],
    [{ ask: { risk: 'low' } }, 'summary'],
    [{ ask: { summary: 's', risk: 'medium' } }, 'risk'],
    [{ ask: { summary: 's', risk: 'low', detail: { paths: '/a' } } }, 'detail'],
  ])('rejects %j', (result, hint) => {
    expect(permitResultIssue(result)).toContain(hint)
  })
})
