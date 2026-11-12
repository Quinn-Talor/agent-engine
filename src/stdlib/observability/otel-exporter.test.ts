import { describe, expect, it, vi } from 'vitest'
import { sha256Hex, type LogEntry } from '../../sdk.js'
import { otelExporter, type OtelSpan } from './otel-exporter.js'
import { runEvents, sessionRunEvents } from './run.fixture.js'

async function feed(sub: ReturnType<typeof otelExporter>, events = runEvents()) {
  for (const e of events) await sub.onEvent!(e)
}

describe('otelExporter', () => {
  it('AC-010 sends one OTLP-style span per trace node with parents and timings', async () => {
    const sent: OtelSpan[][] = []
    const sub = otelExporter({ send: (spans) => void sent.push(spans), serviceName: 'research' })
    await feed(sub)
    expect(sent).toHaveLength(1)
    const spans = sent[0]!
    const traceId = sha256Hex('root-1').slice(0, 32)
    expect(spans.every((s) => s.traceId === traceId && s.kind === 'INTERNAL')).toBe(true)
    expect(spans.map((s) => s.name)).toEqual([
      'run',
      'step 1',
      'model',
      'search',
      'engine:advisor/supervision:advise',
      'engine:advisor',
      'step 2',
      'model',
      'output',
    ])
    const byName = (name: string, n = 0) => spans.filter((s) => s.name === name)[n]!
    const run = byName('run')
    expect(run).not.toHaveProperty('parentSpanId')
    expect(run.spanId).toBe(sha256Hex('run-1/run:run:0').slice(0, 16))
    expect(byName('step 1').parentSpanId).toBe(run.spanId)
    expect(byName('search').parentSpanId).toBe(byName('step 1').spanId)
    expect(run).toMatchObject({
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '1110000000',
      status: { code: 'OK' },
    })
    expect(run.attributes).toMatchObject({
      'service.name': 'research',
      'agent.kind': 'run',
      'agent.run_id': 'run-1',
      'agent.model': 'fake:m',
      'agent.agentId': 'helper',
      'agent.status': 'completed',
    })
    expect(byName('model').attributes).toMatchObject({
      'agent.usage.input': 10,
      'agent.usage.output': 2,
    })
    expect(byName('model').attributes).not.toHaveProperty('agent.attempts')
    expect(byName('search')).toMatchObject({
      startTimeUnixNano: '1031000000',
      endTimeUnixNano: '1036000000',
      status: { code: 'ERROR', message: 'TOOL_TIMEOUT' },
    })
  })

  it('AC-013 exports once per run and keeps runs apart', async () => {
    const send = vi.fn()
    const a = otelExporter({ send })
    const b = otelExporter({ send })
    const events = runEvents()
    for (const e of events.slice(0, 5)) await a.onEvent!(e)
    expect(send).not.toHaveBeenCalled()
    await feed(b, runEvents('run-2'))
    for (const e of events.slice(5)) await a.onEvent!(e)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]![0][0].attributes['agent.run_id']).toBe('run-2')
    expect(send.mock.calls[1]![0][0].attributes['agent.run_id']).toBe('run-1')
  })

  it('nests a child run under the delegate tool span of its parent', async () => {
    const sent: OtelSpan[][] = []
    const sub = otelExporter({ send: (spans) => void sent.push(spans) })
    const child = runEvents('child-1').map((e) =>
      e.t === 'run_started' ? { ...e, parentRunId: 'run-1' } : e,
    )
    const parent = runEvents('run-1').map((e) =>
      e.t === 'tool_finished' ? { ...e, childRunId: 'child-1' } : e,
    )
    await feed(sub, child)
    await feed(sub, parent)
    const [childSpans, parentSpans] = sent
    const delegate = parentSpans!.find((s) => s.attributes['agent.childRunId'] === 'child-1')!
    expect(delegate.name).toBe('search')
    const childRoot = childSpans![0]!
    expect(childRoot.parentSpanId).toBe(delegate.spanId)
    expect(childRoot.traceId).toBe(delegate.traceId)
    // 父运行的根 span 没有父 span；子运行的其他 span 仍挂在子运行的树上。
    expect(parentSpans![0]).not.toHaveProperty('parentSpanId')
    expect(childSpans![1]!.parentSpanId).toBe(childRoot.spanId)
  })

  it('keeps a buffer per run when one exporter receives interleaved runs', async () => {
    const send = vi.fn()
    const sub = otelExporter({ send })
    const a = runEvents('run-a')
    const b = runEvents('run-b')
    for (let i = 0; i < a.length; i++) {
      await sub.onEvent!(a[i]!, { runId: 'run-a' })
      await sub.onEvent!(b[i]!, { runId: 'run-b' })
    }
    expect(send).toHaveBeenCalledTimes(2)
    const [first, second] = send.mock.calls.map((c) => c[0] as OtelSpan[])
    expect(first!.map((s) => s.name)).toEqual(second!.map((s) => s.name))
    expect(first!.every((s) => s.attributes['agent.run_id'] === 'run-a')).toBe(true)
    expect(first).toHaveLength(9)
    expect(second!.every((s) => s.attributes['agent.run_id'] === 'run-b')).toBe(true)
  })

  it('AC-003 tags a session turn with the conversation id and marks failed checks without an error status', async () => {
    const sent: OtelSpan[][] = []
    await feed(otelExporter({ send: (s) => void sent.push(s) }), sessionRunEvents())
    const spans = sent[0]!
    expect(spans[0]!.attributes).toMatchObject({
      'gen_ai.conversation.id': 's1',
      'agent.session': 's1',
      'agent.turn': 3,
    })
    const checks = spans.filter((s) => s.attributes['agent.kind'] === 'check')
    expect(
      checks.map((s) => [s.name, s.attributes['agent.pass'], s.attributes['agent.mode']]),
    ).toEqual([
      ['output', true, 'gate'],
      ['completion', false, 'gate'],
      ['grounding', false, 'shadow'],
      ['output', true, 'gate'],
      ['completion', true, 'gate'],
      ['grounding', true, 'shadow'],
    ])
    expect(checks.every((s) => s.status.code === 'OK')).toBe(true)
    expect(checks[1]!.attributes).toMatchObject({
      'agent.attempt': 1,
      'agent.outcome': 'returned',
      'agent.issues': 1,
    })
    expect(checks[1]!.startTimeUnixNano).toBe(checks[1]!.endTimeUnixNano)

    const plain: OtelSpan[][] = []
    await feed(otelExporter({ send: (s) => void plain.push(s) }))
    expect(plain[0]![0]!.attributes).not.toHaveProperty('gen_ai.conversation.id')
    expect(plain[0]![0]!.attributes).not.toHaveProperty('agent.session')
  })

  it('AC-010 marks a failed run as an error', async () => {
    const sent: OtelSpan[][] = []
    const events = runEvents()
    const ended = events.at(-1)!
    if (ended.t === 'run_ended')
      ended.result = { ...ended.result, status: 'failed', code: 'model_error' }
    await feed(otelExporter({ send: (s) => void sent.push(s) }), events)
    expect(sent[0]![0]!.status).toEqual({ code: 'ERROR', message: 'model_error' })
  })

  it('AC-012 logs a failed send instead of throwing', async () => {
    const logs: LogEntry[] = []
    const sub = otelExporter({
      send: async () => {
        throw new Error('collector down')
      },
      logger: { log: (e) => logs.push(e) },
    })
    await feed(sub)
    expect(logs).toEqual([
      expect.objectContaining({ level: 'warn', message: '观测导出失败', runId: 'run-1' }),
    ])
    await feed(otelExporter({ send: () => Promise.reject(new Error('x')) }))
  })
})
