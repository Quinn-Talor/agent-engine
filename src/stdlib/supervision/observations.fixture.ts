// 测试用观察构造（只被测试使用；覆盖率与构建均排除 *.fixture.ts）。

import type {
  ComponentCtx,
  Guard,
  GuardOpinion,
  Observation,
  RunInfo,
  StepFacts,
  StepToolFact,
} from '../../contracts/component.js'

export const tool = (patch: Partial<StepToolFact> = {}): StepToolFact => ({
  name: 'search',
  capability: 'web',
  inputHash: 'h1',
  outputHash: `out-${Math.random().toString(16).slice(2)}`,
  ok: true,
  effect: 'none',
  durationMs: 1,
  blocked: false,
  ...patch,
})

export const failed = (patch: Partial<StepToolFact> = {}): StepToolFact =>
  tool({ ok: false, errorCode: 'TOOL_EXCEPTION', ...patch })

export function obs(step: number, patch: Partial<Observation> = {}): Observation {
  const toolCalls = patch.toolCalls ?? []
  return {
    step,
    text: '',
    toolCalls,
    allToolsFailed: toolCalls.length === 0 ? null : toolCalls.every((c) => !c.ok),
    isFinalCandidate: toolCalls.length === 0,
    newInformation: true,
    finishReason: toolCalls.length > 0 ? 'tool-calls' : 'stop',
    interventions: { applied: [], violated: [] },
    pressure: { context: 0, steps: 0, time: 0, tokens: 0, cost: 0 },
    stepsLeft: 100,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...patch,
  }
}

/** 依次构造多步观察：每项给出该步的补丁，步号从 1 开始。 */
export const steps = (...patches: Array<Partial<Observation>>): Observation[] =>
  patches.map((p, i) => obs(i + 1, p))

/** 单步事实（守卫的输入）。 */
export const facts = (step: number, patch: Partial<StepFacts> = {}): StepFacts => obs(step, patch)

const RUN: RunInfo = {
  runId: 'r1',
  rootRunId: 'r1',
  environment: { name: 'env', principalReachable: true },
  agent: { id: 'a' },
  task: { input: '分析这家公司' },
  model: { ref: 'fake:m', contextLimit: 1000 },
}

export const guardCtx = (patch: Partial<ComponentCtx> = {}): ComponentCtx => ({
  clock: { now: () => 0, setTimer: () => () => {} },
  random: () => 0.5,
  callModel: async () => undefined,
  record: (_name, fn) => fn(),
  log: () => {},
  host: (kind) => {
    throw new Error(`没有能力宿主 ${kind}`)
  },
  signal: new AbortController().signal,
  modelLimits: () => ({ contextLimit: 1000, maxOutputTokens: 500 }),
  ...patch,
})

/** 启动守卫并依次检查每一步，返回每步的意见。 */
export async function checkAll(
  guard: Guard,
  sequence: StepFacts[],
  ctx: ComponentCtx = guardCtx(),
): Promise<Array<GuardOpinion | undefined>> {
  const instance = guard.start(RUN, ctx)
  const out: Array<GuardOpinion | undefined> = []
  for (const f of sequence) out.push(await instance.check(f))
  return out
}

/** 依次构造多步事实：每项给出该步的补丁，步号从 1 开始。 */
export const factSteps = (...patches: Array<Partial<StepFacts>>): StepFacts[] =>
  patches.map((p, i) => facts(i + 1, p))
