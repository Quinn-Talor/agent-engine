// 与委托人沟通（设计 §4.2、§9.7）：意图工具 ask_user、propose、report_blocked。完成不需要意图工具：
// 不调用工具、直接给出答复就是完成。意图工具照常走流水线，只返回简短确认；每个意图声明参数里给委托人
// 看的那段话（`reply`），模型没写正文时它就是答复。委托人联系不上时排除 ask_user、propose。

import { z } from 'zod'
import type { Capability } from '../../contracts/capability.js'
import type { Segment } from '../../contracts/common.js'
import type { ToolDef, ToolIntent } from '../../contracts/tool.js'
import { hashOf } from '../../sdk.js'
import { toolsFingerprint } from './tools.js'

const intentTool = (
  name: string,
  description: string,
  inputSchema: z.ZodType,
  intent: ToolIntent,
  reply: string,
): ToolDef => ({
  name,
  description,
  inputSchema,
  execution: { effect: 'none' },
  semantics: { intent },
  execute: async () => reply,
})

const ASK_USER = intentTool(
  'ask_user',
  '需要委托人回答才能继续时调用。',
  z.object({ question: z.string(), options: z.array(z.string()).optional() }),
  { kind: 'await_input', code: 'ask_user', reply: 'question' },
  '问题已发送给委托人',
)
const PROPOSE = intentTool(
  'propose',
  '提议一组需要委托人确认的动作；确认后作为下一次运行的输入。',
  z.object({
    summary: z.string(),
    preview: z.string().optional(),
    actions: z.array(z.object({ tool: z.string(), input: z.unknown() })).min(1),
  }),
  { kind: 'await_input', code: 'propose', reply: 'summary' },
  // 写成事实：只说"已发送"，下一轮模型会当成已经办理。
  '提议还没有执行：委托人确认后，由你在下一轮调用相应工具执行',
)
const REPORT_BLOCKED = intentTool(
  'report_blocked',
  '无法继续时调用，说明受阻原因。',
  z.object({ reason: z.string() }),
  { kind: 'stop', code: 'blocked', reply: 'reason' },
  '已报告受阻',
)

function notes(reachable: boolean, approver: boolean): Segment {
  const lines = [
    '与委托人沟通的意图工具：',
    '- 任务完成时直接给出答复，不需要调用工具。',
    '- 无法继续时调用 report_blocked，说明原因。',
    ...(reachable
      ? ['- 需要委托人回答时调用 ask_user。', '- 需要委托人确认一组动作时调用 propose。']
      : [
          '- 委托人联系不上，不会回答提问：不要在回答里向委托人提问；缺少关键信息无法继续时，调用 report_blocked 说明缺什么。',
        ]),
    // 不说清楚，模型看到"需要审批"的规定会自己放弃，审批人根本没机会决定。
    ...(approver
      ? [
          '- 需要审批的操作直接调用工具：系统会请审批人决定，并把结果返回给你；不要因为需要审批而自己放弃或改为提议。',
        ]
      : []),
    '意图工具必须单独调用，不要和其他工具在同一步调用。',
  ]
  return { role: 'system', parts: [{ type: 'text', text: lines.join('\n') }] }
}

export function intents(): Capability {
  return {
    id: 'intents',
    version: '3',
    kind: 'intents',
    async prepare(ctx) {
      const { principalReachable: reachable, approver } = ctx.run.environment
      const tools = reachable ? [ASK_USER, PROPOSE, REPORT_BLOCKED] : [REPORT_BLOCKED]
      return {
        tools,
        description: [notes(reachable, approver)],
        snapshot: { fingerprint: hashOf({ tools: toolsFingerprint(tools), approver }) },
      }
    },
  }
}
