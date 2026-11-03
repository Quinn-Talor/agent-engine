// 测试用运行事件：两步、一次失败的工具调用、一次监督模型调用、一条意见（只被测试使用）。

import type { Observation, RunEvent, RunEventBody } from '../../sdk.js'

const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 })

const observation = (step: number): Observation => ({
  step,
  text: '',
  toolCalls: [],
  allToolsFailed: null,
  isFinalCandidate: step === 2,
  newInformation: false,
  finishReason: 'stop',
  interventions: { applied: [], violated: [] },
  pressure: { context: 0, steps: 0, time: 0, tokens: 0, cost: 0 },
  usage: usage(0, 0),
})

const response = (
  text: string,
  u: ReturnType<typeof usage>,
  toolCalls: Array<{ id: string; name: string; input: unknown }> = [],
) => ({
  text,
  toolCalls,
  finishReason: toolCalls.length > 0 ? ('tool-calls' as const) : ('stop' as const),
  usage: u,
  warnings: [],
  attempts: [],
})

const timeline: Array<[number, RunEventBody]> = [
  [
    1000,
    {
      t: 'run_started',
      agent: { id: 'helper', fingerprint: 'agent-fp' },
      task: {
        fingerprint: 'task-fp',
        content: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
      environment: { name: 'env', fingerprint: 'env-fp', principalReachable: true },
      engine: { fingerprint: 'engine-fp' },
      capabilities: [],
      unavailable: [],
      model: 'fake:m',
      contextLimit: 10_000,
      outputReserve: 0,
      queuedMs: 0,
      rootRunId: 'root-1',
      schemaVersion: 1,
    },
  ],
  [1010, { t: 'step_started', step: 1 }],
  [1020, { t: 'context_built', step: 1, messages: [], tools: ['search'], estimate: 10 }],
  [
    1030,
    {
      t: 'model_responded',
      step: 1,
      response: response('', usage(10, 2), [{ id: 'c1', name: 'search', input: { q: 'x' } }]),
      startedAt: 1020,
    },
  ],
  [
    1040,
    {
      t: 'tool_finished',
      callId: 'c1',
      capability: 'web',
      effect: 'none',
      shown: 'sha256:0',
      isError: true,
      errorCode: 'TOOL_TIMEOUT',
      startedAt: 1031,
      durationMs: 5,
    },
  ],
  [
    1045,
    {
      t: 'external_call',
      source: 'engine:advisor/supervision:advise',
      kind: 'model',
      request: 'sha256:1',
      response: 'sha256:2',
      usage: usage(4, 1),
      startedAt: 1041,
      durationMs: 3,
    },
  ],
  [
    1050,
    {
      t: 'evaluated',
      step: 1,
      observation: observation(1),
      opinions: [{ source: 'engine:advisor', mode: 'active', durationMs: 2 }],
      verdict: { continue: { interventions: [] }, sources: ['default'] },
      decidedAt: 0,
    },
  ],
  [1060, { t: 'step_ended', step: 1 }],
  [1070, { t: 'step_started', step: 2 }],
  [1075, { t: 'context_built', step: 2, messages: [], tools: [], estimate: 10 }],
  [
    1090,
    { t: 'model_responded', step: 2, response: response('done', usage(20, 5)), startedAt: 1075 },
  ],
  [
    1095,
    {
      t: 'evaluated',
      step: 2,
      observation: observation(2),
      opinions: [],
      verdict: { complete: true, sources: ['default'] },
      decidedAt: 0,
    },
  ],
  [1100, { t: 'step_ended', step: 2 }],
  [
    1105,
    {
      t: 'delivery_checked',
      step: 2,
      path: 'normal',
      attempt: 1,
      output: { ok: true },
      checks: [],
      outcome: 'delivered',
    },
  ],
  [
    1110,
    {
      t: 'run_ended',
      result: {
        runId: 'run-1',
        status: 'completed',
        model: 'fake:m',
        usage: {
          ...usage(34, 8),
          main: usage(30, 7),
          memory: usage(0, 0),
          supervision: usage(4, 1),
          children: usage(0, 0),
        },
        steps: 2,
        toolCalls: 1,
      },
    },
  ],
]

export const runEvents = (runId = 'run-1'): RunEvent[] =>
  timeline.map(([at, body], i) => {
    const event = { ...body, seq: i + 1, at } as RunEvent
    return event.t === 'run_ended' ? { ...event, result: { ...event.result, runId } } : event
  })
