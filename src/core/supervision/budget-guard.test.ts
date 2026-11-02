import { describe, expect, it } from 'vitest'
import type { ComponentCtx, GuardOpinion, RunInfo } from '../../contracts/component.js'
import { budgetGuard } from './budget-guard.js'
import { observation } from '../log/events.fixture.js'

const RUN = {} as RunInfo
const CTX = {} as ComponentCtx
const pressure = (patch: Partial<ReturnType<typeof observation>['pressure']>) => ({
  context: 0,
  steps: 0,
  time: 0,
  tokens: 0,
  cost: 0,
  ...patch,
})

describe('budgetGuard', () => {
  it('AC-022 warns once per dimension when resources run low', async () => {
    const guard = budgetGuard().start(RUN, CTX)
    const first = (await guard.check(observation({ stepsLeft: 1 }))) as Extract<
      GuardOpinion,
      { warn: unknown }
    >
    expect(first).toEqual({
      warn: { problem: '资源即将用完：步数', suggest: '尽快收束：基于已有信息给出结果' },
      detail: '剩余 1 步',
    })
    expect(await guard.check(observation({ step: 2, stepsLeft: 1 }))).toBeUndefined()
    expect(await guard.check(observation({ pressure: pressure({ time: 0.92 }) }))).toEqual({
      warn: { problem: '资源即将用完：时间', suggest: '尽快收束：基于已有信息给出结果' },
      detail: '时间 92%',
    })
    expect(
      await guard.check(
        observation({ pressure: pressure({ time: 0.95, tokens: 0.9, cost: 0.95, context: 0.9 }) }),
      ),
    ).toEqual({
      warn: {
        problem: '资源即将用完：token、费用、上下文',
        suggest: '尽快收束：基于已有信息给出结果',
      },
      detail: 'token 90%，费用 95%，上下文 90%',
    })
  })

  it('AC-022 can warn again after a restart', async () => {
    const guard = budgetGuard()
    const facts = observation({ pressure: pressure({ steps: 0.95 }), stepsLeft: 50 })
    expect(await guard.start(RUN, CTX).check(facts)).toMatchObject({ detail: '剩余 50 步' })
    expect(await guard.start(RUN, CTX).check(facts)).toMatchObject({ detail: '剩余 50 步' })
  })

  it('stays quiet below the warning lines', async () => {
    const guard = budgetGuard().start(RUN, CTX)
    const facts = observation({
      stepsLeft: 2,
      pressure: pressure({ steps: 0.9, time: 0.89, tokens: 0.5, cost: 0.1, context: 0.8 }),
    })
    expect(await guard.check(facts)).toBeUndefined()
    expect(budgetGuard()).toMatchObject({ id: 'budget', version: '1' })
  })
})
