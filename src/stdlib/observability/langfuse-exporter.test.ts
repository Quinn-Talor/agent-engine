import { describe, expect, it } from 'vitest'
import type { LogEntry } from '../../sdk.js'
import { langfuseExporter, type LangfuseEvent } from './langfuse-exporter.js'
import { runEvents, sessionRunEvents } from './run.fixture.js'

describe('langfuseExporter', () => {
  it('AC-011 sends a trace with spans and generations in tree order', async () => {
    const sent: LangfuseEvent[][] = []
    const sub = langfuseExporter({ send: (events) => void sent.push(events) })
    for (const e of runEvents()) await sub.onEvent!(e)
    expect(sent).toHaveLength(1)
    const events = sent[0]!
    expect(events[0]).toEqual({
      type: 'trace-create',
      body: {
        id: 'run-1',
        name: 'helper',
        timestamp: new Date(1000).toISOString(),
        metadata: { status: 'completed' },
      },
    })
    expect(events.slice(1).map((e) => [e.type, e.body.name])).toEqual([
      ['span-create', 'step 1'],
      ['generation-create', 'model'],
      ['span-create', 'search'],
      ['span-create', 'engine:advisor/supervision:advise'],
      ['span-create', 'engine:advisor'],
      ['span-create', 'step 2'],
      ['generation-create', 'model'],
      ['span-create', 'output'],
    ])
    const step1 = events[1]!.body
    const generation = events[2]!.body
    expect(step1).not.toHaveProperty('parentObservationId')
    expect(generation).toMatchObject({
      traceId: 'run-1',
      parentObservationId: step1.id,
      startTime: new Date(1020).toISOString(),
      endTime: new Date(1030).toISOString(),
      model: 'fake:m',
      usage: { input: 10, output: 2 },
    })
    expect(events[3]!.body).toMatchObject({
      level: 'ERROR',
      metadata: { errorCode: 'TOOL_TIMEOUT' },
    })
    expect(events[4]!.body).toMatchObject({ level: 'DEFAULT' })
  })

  it('AC-004 groups a session turn by sessionId and warns on failed checks', async () => {
    const sent: LangfuseEvent[][] = []
    const sub = langfuseExporter({ send: (events) => void sent.push(events) })
    for (const e of sessionRunEvents()) await sub.onEvent!(e)
    const [trace, ...observations] = sent[0]!
    expect(trace).toEqual({
      type: 'trace-create',
      body: {
        id: 'run-1',
        name: 'helper',
        timestamp: new Date(1000).toISOString(),
        sessionId: 's1',
        metadata: { status: 'completed', turn: 3 },
      },
    })
    const checks = observations.filter(
      (e) => e.body.metadata && (e.body.metadata as { pass?: unknown }).pass !== undefined,
    )
    expect(checks.map((e) => [e.type, e.body.name, e.body.level])).toEqual([
      ['span-create', 'output', 'DEFAULT'],
      ['span-create', 'completion', 'WARNING'],
      ['span-create', 'grounding', 'WARNING'],
      ['span-create', 'output', 'DEFAULT'],
      ['span-create', 'completion', 'DEFAULT'],
      ['span-create', 'grounding', 'DEFAULT'],
    ])

    const plain: LangfuseEvent[][] = []
    const other = langfuseExporter({ send: (events) => void plain.push(events) })
    for (const e of runEvents()) await other.onEvent!(e)
    expect(plain[0]![0]!.body).not.toHaveProperty('sessionId')
    expect(plain[0]![0]!.body.metadata).toEqual({ status: 'completed' })
  })

  it('AC-012 logs a failed send', async () => {
    const logs: LogEntry[] = []
    const sub = langfuseExporter({
      send: () => {
        throw new Error('401')
      },
      logger: { log: (e) => logs.push(e) },
    })
    for (const e of runEvents()) await sub.onEvent!(e)
    expect(logs.map((l) => l.message)).toEqual(['观测导出失败'])
  })
})
