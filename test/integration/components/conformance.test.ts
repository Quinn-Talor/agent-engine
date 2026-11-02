// 标准组件的一致性（设计 §13 `conformance.*`）：标准组件库的每个组件都通过对应的一致性测试集。

import { describe, it } from 'vitest'
import {
  adaptHooks,
  completionReview,
  compactingMemory,
  conformance,
  createHookRunner,
  groundingCheck,
  modelAdvisor,
  progressGuard,
  riskApproval,
  searchExposure,
  standardGuards,
  workspaceSandbox,
  type ComponentCtx,
  type ContractCase,
  type HookExecResult,
} from '../../../src/index.js'

const exitWith = (result: Partial<HookExecResult>) => {
  const runner = createHookRunner({
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result }),
  })
  return { ctx: { host: <T>() => runner as T } satisfies Partial<ComponentCtx> }
}
const allowing = exitWith({})
const blocking = exitWith({ exitCode: 2, stderr: '不允许' })
const summarizing = {
  ctx: {
    callModel: async () => ({
      text: '1. 意图：整理天气\n2. 关键事实：东京晴',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      model: 'fake:model',
    }),
  } satisfies Partial<ComponentCtx>,
}

const hooks = adaptHooks([
  { event: 'PreToolUse', command: 'guard.sh' },
  { event: 'PostToolUse', command: 'audit.sh' },
  { event: 'Stop', command: 'stop.sh' },
])

const suites: Array<[string, ContractCase[]]> = [
  ...standardGuards().map((g): [string, ContractCase[]] => [g.id, conformance.guard(g)]),
  ['progress', conformance.guard(progressGuard([3, 5]))],
  ['advisor', conformance.guard(modelAdvisor())],
  ['compacting', conformance.memory(compactingMemory())],
  [
    'compacting (compacts)',
    conformance.memory(compactingMemory({ trigger: 0.1, anchors: 1 }), {
      ...summarizing,
      trigger: 0.1,
    }),
  ],
  ['search', conformance.exposure(searchExposure())],
  ['grounding', conformance.check(groundingCheck())],
  ['completion', conformance.check(completionReview())],
  ['hook stop (allows)', conformance.check(hooks.checks[0]!, allowing)],
  ['hook stop (blocks)', conformance.check(hooks.checks[0]!, blocking)],
  ['hook post-tool (allows)', conformance.guard(hooks.guards[0]!, allowing)],
  [
    'hook post-tool (blocks)',
    // 每次都拦的 hook 按设计在每个匹配的调用后告知，不适用"健康步不能每步告知"。
    conformance
      .guard(hooks.guards[0]!, blocking)
      .filter((c) => c.name !== 'guard: does not warn on every healthy step'),
  ],
  ['workspace-sandbox', conformance.permission(workspaceSandbox())],
  ...(['auto', 'ask-high', 'ask-all'] as const).map((mode): [string, ContractCase[]] => [
    `risk-approval ${mode}`,
    conformance.permission(riskApproval({ mode })),
  ]),
  ['hook pre-tool (allows)', conformance.permission(hooks.permissions[0]!, allowing)],
  ['hook pre-tool (blocks)', conformance.permission(hooks.permissions[0]!, blocking)],
]

describe('standard components conform', () => {
  for (const [component, cases] of suites) {
    describe(component, () => {
      for (const c of cases) it(`AC-013 ${c.name}`, () => c.run())
    })
  }
})
