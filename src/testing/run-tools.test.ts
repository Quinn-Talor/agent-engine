import { describe, expect, it } from 'vitest'
import type { ArchiveStore, Run, RunEvent, RunResult } from '../api.js'
import { testDefaults, testHarness, twoSteps } from './engine.fixture.js'
import { assertInvariants, replay, runToEnd } from './run-tools.js'

describe('runToEnd', () => {
  it('AC-001 returns the result and every event up to run_ended', async () => {
    const h = testHarness({ replies: twoSteps })
    const { result, events } = await runToEnd(h.start())
    expect(result).toMatchObject({ status: 'completed', text: '东京今天晴。' })
    expect(events[0]?.t).toBe('run_started')
    expect(events.at(-1)?.t).toBe('run_ended')
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
  })

  it('AC-001 returns the result and the events received when run_ended never arrives', async () => {
    const result = { runId: 'r' } as RunResult
    const silent: Run = {
      runId: 'r',
      result: Promise.resolve(result),
      subscribe: () => () => {},
      steer: () => {},
      abort: () => {},
    }
    expect(await runToEnd(silent)).toEqual({ result, events: [] })
  })

  it('AC-001 returns the result when the archive cannot write run_ended', async () => {
    const h = testHarness({
      replies: twoSteps,
      wrapArchive: (a): ArchiveStore => ({
        async append(runId, events) {
          if (events.some((e) => e.t === 'run_ended')) throw new Error('写不进 run_ended')
          return a.append(runId, events)
        },
        read: (runId, fromSeq) => a.read(runId, fromSeq),
        putBlob: (data) => a.putBlob(data),
        getBlob: (ref) => a.getBlob(ref),
        query: (filter) => a.query(filter),
        pin: (runId, reason) => a.pin(runId, reason),
        retain: (policy) => a.retain(policy),
      }),
    })
    const run = h.start()
    const { result, events } = await runToEnd(run)
    expect(result).toEqual(await run.result)
    expect(events[0]?.t).toBe('run_started')
    expect(events.some((e) => e.t === 'run_ended')).toBe(false)
  })
})

describe('assertInvariants', () => {
  it('AC-002 passes a conforming log and lists violations otherwise', async () => {
    const { events } = await runToEnd(testHarness({ replies: twoSteps }).start())
    expect(() => assertInvariants(events)).not.toThrow()
    const broken: RunEvent[] = []
    for (const e of events) {
      if (e.t === 'tool_finished') continue
      broken.push({ ...e, seq: broken.length + 1 })
    }
    expect(() => assertInvariants(broken)).toThrow(
      /不变量违规：\n- I2（seq \d+）工具调用 c1 没有结果/,
    )
  })

  it('F19 AC-013 runs the complete checks', async () => {
    const { events } = await runToEnd(testHarness({ replies: twoSteps }).start())
    const ghost = events.map((e) =>
      e.t === 'context_built' ? { ...e, tools: [...e.tools, 'ghost'] } : e,
    )
    expect(() => assertInvariants(ghost)).toThrow(/- I4（seq \d+）/)
  })
})

describe('replay', () => {
  async function archived(): Promise<{ archive: ArchiveStore; runId: string }> {
    const h = testHarness({ replies: twoSteps })
    const run = h.start()
    await runToEnd(run)
    return { archive: h.archive, runId: run.runId }
  }

  it('AC-003 replays an archived run strictly', async () => {
    const { archive, runId } = await archived()
    const strict = await replay(archive, runId, 'strict')
    expect(strict.violations).toEqual([])
    expect(strict.result).toMatchObject({ runId, status: 'completed' })
  })

  it('AC-003 replays an archived run against new components', async () => {
    const { archive, runId } = await archived()
    const d = testDefaults()
    const report = await replay(archive, runId, {
      mode: 'regression',
      guards: { engine: d.guards },
      deliverable: d.deliverable,
    })
    expect(report.firstDivergence).toBeUndefined()
    expect(report.steps.map((s) => s.same)).toEqual([true, true])
    expect(report.deliveries).toEqual([expect.objectContaining({ same: true })])
  })

  it('AC-003 decodes binary blobs as UTF-8 for regression replay', async () => {
    const { archive, runId } = await archived()
    const binary: ArchiveStore = {
      ...archive,
      read: (id, from) => archive.read(id, from),
      getBlob: async (ref) => {
        const data = await archive.getBlob(ref)
        return typeof data === 'string' ? new TextEncoder().encode(data) : data
      },
    }
    const d = testDefaults()
    const report = await replay(binary, runId, {
      mode: 'regression',
      guards: {},
      deliverable: d.deliverable,
    })
    expect(report.firstDivergence).toBeUndefined()
  })
})
