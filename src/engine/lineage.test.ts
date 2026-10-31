import { describe, expect, it } from 'vitest'
import { agentOf, taskOf } from './engine.fixture.js'
import { checkSpawn, rootLineage, type Lineage } from './lineage.js'

const child = agentOf({ id: 'researcher' })
const timed = taskOf({ budget: { maxTotalMs: 60_000, finalizeReserveMs: 0 } })

const deeper = (l: Lineage, agentId: string): Lineage => ({
  ...l,
  depth: l.depth + 1,
  agentIds: [...l.agentIds, agentId],
})

const codeOf = (r: ReturnType<typeof checkSpawn>) => (r.ok ? 'ok' : r.error.code)

describe('checkSpawn', () => {
  it('AC-015 limits the depth', () => {
    let lineage = rootLineage('root', 'lead', 10)
    lineage = deeper(deeper(lineage, 'a'), 'b')
    expect(
      codeOf(checkSpawn({ lineage, delegation: {}, agent: child, task: timed, remaining: {} })),
    ).toBe('ok')
    lineage = deeper(lineage, 'c')
    expect(
      codeOf(checkSpawn({ lineage, delegation: {}, agent: child, task: timed, remaining: {} })),
    ).toBe('SPAWN_DEPTH_EXCEEDED')
    expect(
      codeOf(
        checkSpawn({ lineage, delegation: { depth: 4 }, agent: child, task: timed, remaining: {} }),
      ),
    ).toBe('ok')
  })

  it('AC-015 refuses to delegate to itself or an ancestor', () => {
    const lineage = deeper(rootLineage('root', 'lead', 10), 'researcher')
    const r = checkSpawn({ lineage, delegation: {}, agent: child, task: timed, remaining: {} })
    expect(r).toMatchObject({ ok: false, error: { code: 'SPAWN_CYCLE' } })
    const self = checkSpawn({
      lineage: rootLineage('root', 'researcher', 10),
      delegation: {},
      agent: child,
      task: timed,
      remaining: {},
    })
    expect(codeOf(self)).toBe('SPAWN_CYCLE')
  })

  it('AC-015 counts delegations per agent across the root run', () => {
    const lineage = rootLineage('root', 'lead', 10)
    const once = () =>
      codeOf(
        checkSpawn({
          lineage,
          delegation: { perAgent: 2 },
          agent: child,
          task: timed,
          remaining: {},
        }),
      )
    expect([once(), once(), once()]).toEqual(['ok', 'ok', 'SPAWN_LIMIT'])
    expect(lineage.root.spawned.get('researcher')).toBe(2)
    const other = checkSpawn({
      lineage: deeper(lineage, 'x'),
      delegation: { perAgent: 2 },
      agent: agentOf({ id: 'writer' }),
      task: timed,
      remaining: {},
    })
    expect(codeOf(other)).toBe('ok')
  })

  it('AC-015 keeps the child inside the remaining budget', () => {
    const lineage = () => rootLineage('root', 'lead', 10)
    const check = (task = timed, remaining: { timeMs?: number; cost?: number } = {}) =>
      checkSpawn({ lineage: lineage(), delegation: {}, agent: child, task, remaining })
    const untimed = taskOf()
    expect(check(untimed)).toMatchObject({
      ok: false,
      error: { code: 'SPAWN_BUDGET', message: '子运行必须设置 maxTotalMs' },
    })
    expect(check(untimed, { timeMs: 30_000 })).toEqual({
      ok: true,
      ceiling: { maxTotalMs: 30_000 },
    })
    expect(codeOf(check(timed, { timeMs: 30_000 }))).toBe('SPAWN_BUDGET')
    expect(codeOf(check(timed, { timeMs: 0 }))).toBe('SPAWN_BUDGET')
    const costly = taskOf({ budget: { maxTotalMs: 60_000, maxCost: 2, finalizeReserveMs: 0 } })
    expect(codeOf(check(costly, { cost: 1 }))).toBe('SPAWN_BUDGET')
    expect(codeOf(check(timed, { cost: 0 }))).toBe('SPAWN_BUDGET')
    expect(check(costly, { timeMs: 90_000, cost: 5 })).toEqual({
      ok: true,
      ceiling: { maxTotalMs: 90_000, maxCost: 5 },
    })
  })
})

describe('rootLineage', () => {
  it('limits concurrent children of the root run in arrival order', async () => {
    const { root } = rootLineage('root', 'lead', 1)
    const order: string[] = []
    let release!: () => void
    const first = root.limiter(1).run(
      () =>
        new Promise<void>((resolve) => {
          order.push('first')
          release = resolve
        }),
    )
    const second = root.limiter(1).run(async () => {
      order.push('second')
    })
    await Promise.resolve()
    expect(order).toEqual(['first'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })

  it('§5.3 gives each depth its own limiter, so a waiting run never blocks its own children', async () => {
    const { root } = rootLineage('root', 'lead', 1)
    expect(root.limiter(1)).toBe(root.limiter(1))
    const order: string[] = []
    await root.limiter(1).run(async () => {
      order.push('child')
      await root.limiter(2).run(async () => {
        order.push('grandchild')
      })
    })
    expect(order).toEqual(['child', 'grandchild'])
  })
})
