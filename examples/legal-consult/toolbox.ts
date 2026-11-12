// 工具呈现：按办案阶段给工具。先查明事实、检索法规，检索过法规之后才露出计算、发函和提交意见书的工具，
// 免得模型没查依据就下结论。呈现只能收窄（可见工具必须是已准备工具的子集），不能凭空加工具。

import type { Exposure } from '@talor/agent-engine'

const DRAFTING = new Set(['calc_compensation', 'send_demand_letter', 'submit'])

export const stagedExposure: Exposure = {
  id: 'staged-exposure',
  version: '1',
  config: { drafting: [...DRAFTING], after: 'search_statutes' },
  start: () => ({
    visible(state) {
      const researched = state.calls.some((c) => c.name === 'search_statutes')
      return state.prepared.map((t) => t.name).filter((name) => researched || !DRAFTING.has(name))
    },
  }),
}
