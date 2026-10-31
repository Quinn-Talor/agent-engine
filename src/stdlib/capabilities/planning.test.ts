import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../../contracts/tool.js'
import type { GuardOpinion } from '../../contracts/component.js'
import { checkAll, facts, tool } from '../supervision/observations.fixture.js'
import { PLAN_PROGRESS, planning, progressGuard } from './planning.js'
import { prepareCtx } from './prepare.fixture.js'

const plan = (hash: string, ok = true) => tool({ name: 'update_plan', inputHash: hash, ok })

describe('planning', () => {
  it('AC-006 AC-033 provides update_plan, the progress guard and usage notes', async () => {
    const cap = planning()
    expect(cap).toMatchObject({
      id: 'planning',
      version: '1',
      kind: 'planning',
      config: { thresholds: [6, 12] },
    })
    const prepared = await cap.prepare(prepareCtx())
    expect(prepared.tools.map((t) => [t.name, t.execution?.effect])).toEqual([
      ['update_plan', 'none'],
    ])
    expect(prepared.guards?.map((g) => g.id)).toEqual(['progress'])
    expect(prepared.description).toHaveLength(1)
    const items = [
      { id: '1', text: 'collect data', status: 'done' },
      { id: '2', text: 'analyse', status: 'in_progress' },
      { id: '3', text: 'report', status: 'pending' },
    ]
    const out = await prepared.tools[0]!.execute({ items }, {} as ToolCtx)
    expect(out).toBe('计划已更新：已完成 1/3 项')
    expect(PLAN_PROGRESS.exec(out as string)?.slice(1)).toEqual(['1', '3'])
  })
})

describe('progressGuard', () => {
  const quiet = (step: number) => facts(step, { toolCalls: [tool({ name: 'search' })] })
  const planned = (step: number, hash: string, ok = true) =>
    facts(step, { toolCalls: [plan(hash, ok)] })
  const kinds = (opinions: Array<GuardOpinion | undefined>) =>
    opinions.map((o) => (o === undefined ? '-' : 'warn' in o ? 'warn' : 'end' in o ? 'end' : '?'))

  it('AC-015 does not count before a plan exists', async () => {
    const opinions = await checkAll(
      progressGuard([6, 12]),
      Array.from({ length: 14 }, (_, i) => quiet(i + 1)),
    )
    expect(kinds(opinions).every((k) => k === '-')).toBe(true)
  })

  it('AC-015 warns after 6 and finalizes with no_progress after 12 steps without plan progress', async () => {
    const sequence = [planned(1, 'p1'), ...Array.from({ length: 12 }, (_, i) => quiet(i + 2))]
    const opinions = await checkAll(progressGuard([6, 12]), sequence)
    expect(kinds(opinions)).toEqual(
      Array.from({ length: 13 }, (_, i) => (i === 6 ? 'warn' : i === 12 ? 'end' : '-')),
    )
    const warn = opinions[6] as Extract<GuardOpinion, { warn: unknown }>
    expect(warn.warn.problem).toBe('计划已经 6 步没有推进（6/12，再出现 6 次将收尾）')
    expect(warn.warn.suggest).toBe('先用 update_plan 更新计划，再继续')
    expect(opinions[12]).toMatchObject({ end: { as: 'finalize', code: 'no_progress' } })
  })

  it('AC-015 resets on a new plan but not on a repeated or failed one', async () => {
    const sequence = [
      planned(1, 'p1'),
      ...[2, 3, 4, 5].map(quiet),
      planned(6, 'p1'),
      planned(7, 'p2', false),
      planned(8, 'p3'),
      ...[9, 10, 11, 12, 13].map(quiet),
      quiet(14),
    ]
    const opinions = await checkAll(progressGuard([6, 12]), sequence)
    expect(kinds(opinions)).toEqual(
      Array.from({ length: 14 }, (_, i) => (i === 6 || i === 13 ? 'warn' : '-')),
    )
    expect(progressGuard([6, 12]).config).toEqual({ thresholds: [6, 12] })
  })
})
