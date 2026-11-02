// 测试用事件构造（只被测试使用；覆盖率与构建均排除 *.fixture.ts）。

import type { Observation, Verdict } from '../../contracts/component.js'
import type { RunEvent } from '../../contracts/events.js'
import type { ModelResponse, NormalizedUsage, RunUsage } from '../../contracts/model.js'
import type { RunResult } from '../../contracts/run.js'

export type EventBody = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, 'seq' | 'at'>
    : never
  : never

type Of<T extends RunEvent['t']> = Extract<EventBody, { t: T }>

/** 给事件体依次编号：seq 从 1 开始，at 从 `startAt` 起每条 +10。 */
export function sequence(bodies: EventBody[], startAt = 1_000): RunEvent[] {
  return bodies.map((body, i) => ({ ...body, seq: i + 1, at: startAt + i * 10 }) as RunEvent)
}

export const usage = (input = 0, output = 0): NormalizedUsage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
})

export const runUsage = (): RunUsage => ({
  ...usage(),
  main: usage(),
  memory: usage(),
  supervision: usage(),
  children: usage(),
})

export const toolSnapshot = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  schemaHash: `schema-${name}`,
  effect: 'none' as const,
  ...extra,
})

export const runStarted = (patch: Partial<Of<'run_started'>> = {}): Of<'run_started'> => ({
  t: 'run_started',
  agent: { id: 'agent', fingerprint: 'agent-fp' },
  task: { fingerprint: 'task-fp' },
  environment: { name: 'env', fingerprint: 'env-fp', principalReachable: true },
  engine: { fingerprint: 'engine-fp' },
  capabilities: [
    {
      capability: 'tools',
      kind: 'tool',
      version: '1',
      fingerprint: 'cap-fp',
      tools: [toolSnapshot('search'), toolSnapshot('fetch')],
    },
  ],
  unavailable: [],
  model: 'fake:model',
  contextLimit: 10_000,
  queuedMs: 0,
  rootRunId: 'r1',
  schemaVersion: 1,
  ...patch,
})

export const stepStarted = (step: number): Of<'step_started'> => ({ t: 'step_started', step })

export const contextBuilt = (step: number, estimate = 100): Of<'context_built'> => ({
  t: 'context_built',
  step,
  messages: [],
  tools: [],
  estimate,
})

export const response = (patch: Partial<ModelResponse> = {}): ModelResponse => ({
  text: '',
  toolCalls: [],
  finishReason: 'stop',
  usage: usage(100, 10),
  warnings: [],
  attempts: [],
  ...patch,
})

export const call = (id: string, name = 'search', input: unknown = { q: id }) => ({
  id,
  name,
  input,
})

export const modelResponded = (
  step: number,
  patch: Partial<ModelResponse> = {},
): Of<'model_responded'> => ({
  t: 'model_responded',
  step,
  response: response(patch),
  startedAt: 0,
})

export const toolFinished = (
  callId: string,
  patch: Partial<Of<'tool_finished'>> = {},
): Of<'tool_finished'> => ({
  t: 'tool_finished',
  callId,
  capability: 'tools',
  effect: 'none',
  shown: `sha256:${callId.padEnd(64, '0')}`,
  isError: false,
  startedAt: 0,
  durationMs: 5,
  ...patch,
})

export const observation = (patch: Partial<Observation> = {}): Observation => ({
  step: 1,
  text: '',
  toolCalls: [],
  allToolsFailed: null,
  isFinalCandidate: false,
  newInformation: false,
  finishReason: 'stop',
  interventions: { applied: [], violated: [] },
  pressure: { context: 0, steps: 0, time: 0, tokens: 0, cost: 0 },
  usage: usage(),
  ...patch,
})

export const evaluated = (
  step: number,
  verdict: Verdict,
  obs: Partial<Observation> = {},
  opinions: Of<'evaluated'>['opinions'] = [],
): Of<'evaluated'> => ({
  t: 'evaluated',
  step,
  observation: observation({ step, ...obs }),
  opinions,
  verdict,
})

/** 守卫意见记录：warn 记为带一条提示的继续。 */
export const opinionRecord = (
  source: string,
  kind: 'warn' | 'finalize' | 'stop' | 'awaitInput',
  patch: Partial<Of<'evaluated'>['opinions'][number]> = {},
): Of<'evaluated'>['opinions'][number] => ({
  source,
  opinion:
    kind === 'warn'
      ? { continue: { interventions: [{ hint: { text: `- ${source}` } }] } }
      : kind === 'finalize'
        ? { finalize: { code: 'x' } }
        : kind === 'stop'
          ? { stop: { code: 'x', message: 'm' } }
          : { awaitInput: { code: 'x' } },
  mode: 'active',
  durationMs: 0,
  ...patch,
})

export const stepEnded = (step: number): Of<'step_ended'> => ({ t: 'step_ended', step })

export const deliveryChecked = (
  step: number,
  outcome: Of<'delivery_checked'>['outcome'],
  patch: Partial<Of<'delivery_checked'>> = {},
): Of<'delivery_checked'> => ({
  t: 'delivery_checked',
  step,
  path: 'normal',
  attempt: 1,
  output: { ok: outcome !== 'returned' },
  checks: [],
  outcome,
  ...patch,
})

export const result = (patch: Partial<RunResult> = {}): RunResult => ({
  runId: 'r1',
  status: 'completed',
  model: 'fake:model',
  usage: runUsage(),
  steps: 1,
  toolCalls: 0,
  ...patch,
})

export const runEnded = (patch: Partial<RunResult> = {}): Of<'run_ended'> => ({
  t: 'run_ended',
  result: result(patch),
})
