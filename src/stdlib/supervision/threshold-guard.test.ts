import { describe, expect, it } from 'vitest'
import type { GuardOpinion, StepFacts } from '../../contracts/component.js'
import { checkAll, factSteps } from './observations.fixture.js'
import { thresholdGuard } from './threshold-guard.js'

/** 按步号依次给出增量的计数守卫。 */
const scripted = (deltas: Array<number | 'reset'>, warn: number, end?: number) =>
  thresholdGuard({
    id: 'scripted',
    warn,
    ...(end !== undefined ? { end } : {}),
    count: () => (facts: StepFacts) => deltas[facts.step - 1] ?? 0,
    problem: (_facts, n) => `出现 ${n} 次`,
    suggest: '换个做法',
  })

const kinds = (opinions: Array<GuardOpinion | undefined>) =>
  opinions.map((o) => (o === undefined ? '-' : 'warn' in o ? 'warn' : 'end' in o ? 'end' : 'await'))

describe('thresholdGuard', () => {
  it('AC-005 warns at the warn threshold, ends at the end threshold and starts over after a reset', async () => {
    const deltas: Array<number | 'reset'> = [1, 1, 1, 'reset', 1, 1]
    const opinions = await checkAll(scripted(deltas, 2, 3), factSteps(...deltas.map(() => ({}))))
    expect(kinds(opinions)).toEqual(['-', 'warn', 'end', '-', '-', 'warn'])
    const warn = opinions[1] as Extract<GuardOpinion, { warn: unknown }>
    expect(warn.warn.problem).toBe('出现 2 次（2/3，再出现 1 次将收尾）')
    expect(warn.warn.suggest).toBe('换个做法')
    expect(warn.detail).toBe('计数 2')
    expect(opinions[2]).toEqual({ end: { as: 'finalize', code: 'scripted' }, detail: '计数 3' })
  })

  it('AC-006 warns first when one count jumps past the end threshold', async () => {
    const deltas = [2, 2, 2]
    const opinions = await checkAll(scripted(deltas, 3, 4), factSteps({}, {}, {}))
    expect(kinds(opinions)).toEqual(['-', 'warn', 'end'])
    const warn = opinions[1] as Extract<GuardOpinion, { warn: unknown }>
    expect(warn.warn.problem).toContain('再出现 1 次')
  })

  it('AC-006 without an end threshold warns once and never ends', async () => {
    const deltas = Array.from({ length: 20 }, () => 1)
    const opinions = await checkAll(scripted(deltas, 3), factSteps(...deltas.map(() => ({}))))
    expect(kinds(opinions).filter((k) => k === 'warn')).toHaveLength(1)
    expect(kinds(opinions)).not.toContain('end')
    const warn = opinions[2] as Extract<GuardOpinion, { warn: unknown }>
    expect(warn.warn.problem).toBe('出现 3 次')
  })

  it('says it will stop when endAs is stop, and uses the code function', async () => {
    const guard = thresholdGuard({
      id: 't',
      warn: 1,
      end: 2,
      endAs: 'stop',
      count: () => () => 1,
      code: (f) => `c${f.step}`,
      problem: () => 'p',
    })
    const opinions = await checkAll(guard, factSteps({}, {}))
    expect((opinions[0] as Extract<GuardOpinion, { warn: unknown }>).warn.problem).toBe(
      'p（1/2，再出现 1 次将停止）',
    )
    expect(opinions[1]).toEqual({ end: { as: 'stop', code: 'c2' }, detail: '计数 2' })
    expect(guard.version).toBe('1')
    expect(guard.config).toEqual({ warn: 1, end: 2, endAs: 'stop' })
  })

  it('keeps state per start: a new run starts from zero', async () => {
    const guard = scripted([1, 1], 2, 3)
    expect(kinds(await checkAll(guard, factSteps({}, {})))).toEqual(['-', 'warn'])
    expect(kinds(await checkAll(guard, factSteps({}, {})))).toEqual(['-', 'warn'])
  })
})
