// 测试用准备上下文（只被测试使用；覆盖率与构建均排除 *.fixture.ts）。

import type { PrepareCtx } from '../../contracts/capability.js'
import type { RunInfo } from '../../contracts/component.js'

export const runInfo = (principalReachable = true, approver = false): RunInfo => ({
  runId: 'r1',
  rootRunId: 'r1',
  environment: { name: 'env', principalReachable, approver },
  agent: { id: 'a' },
  task: {},
  model: { ref: 'fake:m', contextLimit: 1000 },
})

export const prepareCtx = (patch: Partial<PrepareCtx> = {}): PrepareCtx => ({
  run: runInfo(),
  signal: new AbortController().signal,
  deadline: 0,
  host: () => {
    throw new Error('no host')
  },
  vault: { resolve: async () => '' },
  ...patch,
})
