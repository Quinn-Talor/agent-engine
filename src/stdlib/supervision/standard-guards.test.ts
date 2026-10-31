import { describe, expect, it } from 'vitest'
import type { GuardOpinion, StepFacts } from '../../contracts/component.js'
import { checkAll, failed, facts, tool } from './observations.fixture.js'
import {
  DEFAULT_GUARD_THRESHOLDS,
  failureStreak,
  noNewInfo,
  silentProgress,
  standardGuards,
  truncation,
} from './standard-guards.js'

type Warn = Extract<GuardOpinion, { warn: unknown }>

const kinds = (opinions: Array<GuardOpinion | undefined>) =>
  opinions.map((o) => (o === undefined ? '-' : 'warn' in o ? 'warn' : 'end' in o ? 'end' : 'await'))

const repeat = (n: number, patch: Partial<StepFacts>): StepFacts[] =>
  Array.from({ length: n }, (_, i) => facts(i + 1, patch))

const renumber = (sequence: StepFacts[]): StepFacts[] =>
  sequence.map((f, i) => ({ ...f, step: i + 1 }))

describe('failureStreak', () => {
  const allFailed = { toolCalls: [failed({ name: 'fetch', errorCode: 'TOOL_TIMEOUT' })] }

  it('AC-007 warns at 2 and finalizes at 3 consecutive all-failed steps', async () => {
    const opinions = await checkAll(failureStreak(), repeat(3, allFailed))
    expect(kinds(opinions)).toEqual(['-', 'warn', 'end'])
    const warn = opinions[1] as Warn
    expect(warn.warn.problem).toBe(
      '连续 2 步工具调用全部失败（fetch: TOOL_TIMEOUT）（2/3，再出现 1 次将收尾）',
    )
    expect(warn.warn.suggest).toBe(
      '依赖暂时不可用：不要用相同输入反复重试，改用其他工具，或基于已有信息作答',
    )
    expect(opinions[2]).toEqual({
      end: { as: 'finalize', code: 'failure_streak' },
      detail: '计数 3',
    })
  })

  it('suggests fixing the input when a failure is deterministic', async () => {
    const invalid = failed({
      name: 'order',
      errorCode: 'INVALID_INPUT',
      errorClass: 'deterministic',
    })
    const opinions = await checkAll(failureStreak(), repeat(2, { toolCalls: [invalid] }))
    expect((opinions[1] as Warn).warn.suggest).toBe(
      '按错误信息修正参数或前提条件后再调用，或改用其他工具',
    )
  })

  it('AC-007 counts a failed subagent as 2 and resets on a step with a success', async () => {
    const sub = { toolCalls: [failed({ name: 'delegate', errorCode: 'SUBAGENT_FAILED' })] }
    expect(kinds(await checkAll(failureStreak(), renumber([facts(1, sub)])))).toEqual(['warn'])
    const mixed = { toolCalls: [failed(), tool({ name: 'other' })] }
    const sequence = renumber([
      facts(0, allFailed),
      facts(0, mixed),
      facts(0, allFailed),
      facts(0, allFailed),
    ])
    expect(kinds(await checkAll(failureStreak(), sequence))).toEqual(['-', '-', '-', 'warn'])
  })

  it('AC-007 ends with external_failure when most failures are TOOL_UNAVAILABLE', async () => {
    const unavailable = {
      toolCalls: [
        failed({ name: 'a', errorCode: 'TOOL_UNAVAILABLE' }),
        failed({ name: 'b', errorCode: 'TOOL_UNAVAILABLE' }),
        failed({ name: 'c', errorCode: 'TOOL_TIMEOUT' }),
      ],
    }
    const opinions = await checkAll(failureStreak(), repeat(3, unavailable))
    expect(opinions[2]).toMatchObject({ end: { as: 'finalize', code: 'external_failure' } })
  })

  it('does not count a step without tool calls', async () => {
    const sequence = renumber([
      facts(0, allFailed),
      facts(0, { text: '想一想' }),
      facts(0, allFailed),
    ])
    expect(kinds(await checkAll(failureStreak(), sequence))).toEqual(['-', '-', 'warn'])
  })
})

describe('noNewInfo', () => {
  const stale = { toolCalls: [tool({ outputHash: 'same' })], newInformation: false }

  it('AC-008 warns at 3 and finalizes with stall at 8 steps without new information', async () => {
    const opinions = await checkAll(noNewInfo(), repeat(8, stale))
    expect(kinds(opinions)).toEqual(['-', '-', 'warn', '-', '-', '-', '-', 'end'])
    expect((opinions[2] as Warn).warn.problem).toContain('连续 3 步没有获得新信息')
    expect((opinions[2] as Warn).warn.suggest).toBe(
      '换一种查询方式、用 search_tool 找其他工具，或基于已有信息作答',
    )
    expect(opinions[7]).toMatchObject({ end: { as: 'finalize', code: 'stall' } })
  })

  it('AC-008 ignores repeatable-only steps and resets on new information', async () => {
    const polling = { toolCalls: [tool({ repeatable: true })], newInformation: false }
    const fresh = { toolCalls: [tool()], newInformation: true }
    const sequence = renumber([
      facts(0, stale),
      facts(0, polling),
      facts(0, polling),
      facts(0, stale),
      facts(0, fresh),
      facts(0, stale),
      facts(0, stale),
    ])
    expect(kinds(await checkAll(noNewInfo(), sequence))).toEqual([
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
    ])
  })
})

describe('noNewInfo with writes', () => {
  it('counts a successful side effect as progress, so a batch of writes is not a stall', async () => {
    const write = {
      toolCalls: [tool({ name: 'write_file', effect: 'side_effect', outputHash: 'ok' })],
      newInformation: false,
    }
    const opinions = await checkAll(noNewInfo(), repeat(12, write))
    expect(kinds(opinions).every((k) => k === '-')).toBe(true)
  })

  it('still counts failed writes', async () => {
    const failing = {
      toolCalls: [failed({ name: 'write_file', effect: 'side_effect', outputHash: 'err' })],
      newInformation: false,
    }
    expect(kinds(await checkAll(noNewInfo(), repeat(3, failing)))).toEqual(['-', '-', 'warn'])
  })
})

describe('truncation', () => {
  it('AC-009 warns at the first truncation, ends through the fallback at the third and resets otherwise', async () => {
    const cut = { finishReason: 'length' as const }
    const opinions = await checkAll(truncation(), repeat(3, cut))
    expect(kinds(opinions)).toEqual(['warn', '-', 'end'])
    expect((opinions[0] as Warn).warn.problem).toBe('输出连续 1 次被截断（1/3，再出现 2 次将收尾）')
    expect((opinions[0] as Warn).warn.suggest).toBe(
      '大段内容改用写文件的工具输出；精简推理过程；把任务拆成几步完成',
    )
    expect(opinions[2]).toEqual({ end: { as: 'finalize', code: 'truncated' }, detail: '计数 3' })
    const sequence = renumber([facts(0, cut), facts(0, {}), facts(0, cut)])
    expect(kinds(await checkAll(truncation(), sequence))).toEqual(['warn', '-', 'warn'])
  })
})

describe('silentProgress', () => {
  const silent = { toolCalls: [tool()], text: '  ' }

  it('AC-010 warns once at 5 silent steps and never ends', async () => {
    const opinions = await checkAll(silentProgress(), repeat(20, silent))
    expect(kinds(opinions)).toEqual(Array.from({ length: 20 }, (_, i) => (i === 4 ? 'warn' : '-')))
    expect((opinions[4] as Warn).warn.problem).toBe('连续 5 步只调用工具、没有说明进展')
    expect((opinions[4] as Warn).warn.suggest).toBe(
      '先用一两句话说明目前掌握的情况；互不依赖的调用在一次回复里并行发出；信息已经足够就直接作答',
    )
  })

  it('AC-010 resets when the model explains its progress', async () => {
    const said = { toolCalls: [tool()], text: '已经查到两家' }
    const sequence = renumber([
      ...repeat(4, silent),
      facts(0, said),
      ...repeat(4, silent),
      facts(0, { text: '' }),
      facts(0, silent),
    ])
    expect(kinds(await checkAll(silentProgress(), sequence))).toEqual(
      Array.from({ length: 11 }, (_, i) => (i === 10 ? 'warn' : '-')),
    )
  })
})

describe('standardGuards', () => {
  it('AC-010 returns the five standard guards and can turn silentProgress off', () => {
    expect(standardGuards().map((g) => g.id)).toEqual([
      'roadblock',
      'failure-streak',
      'no-new-info',
      'truncation',
      'silent-progress',
    ])
    expect(
      standardGuards({ thresholds: { silentProgress: false } }).map((g) => g.id),
    ).not.toContain('silent-progress')
  })

  it('applies custom thresholds and keeps the defaults', async () => {
    expect(DEFAULT_GUARD_THRESHOLDS).toEqual({
      failureStreak: [2, 3],
      noNewInfo: [3, 8],
      truncation: [1, 3],
      silentProgress: 5,
    })
    const guards = standardGuards({ thresholds: { failureStreak: [1, 2] } })
    const streak = guards.find((g) => g.id === 'failure-streak')!
    expect(streak.config).toEqual({ warn: 1, end: 2, endAs: 'finalize' })
    const allFailed = { toolCalls: [failed()] }
    expect(kinds(await checkAll(streak, repeat(2, allFailed)))).toEqual(['warn', 'end'])
  })
})
