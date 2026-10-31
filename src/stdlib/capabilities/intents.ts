// 与委托人沟通（设计 §4.2、§9.7）：意图工具 finish、ask_user、propose、report_blocked。
// 意图工具照常走流水线，只返回简短确认；委托人联系不上时排除 ask_user、propose。

import { z } from 'zod'
import type { Capability } from '../../contracts/capability.js'
import type { Segment } from '../../contracts/common.js'
import type { ToolDef, ToolIntent } from '../../contracts/tool.js'
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

const FINISH = intentTool(
  'finish',
  '任务完成时调用，参数为完成摘要。',
  z.object({ summary: z.string() }),
  { kind: 'complete', code: 'finish' },
  '已记录',
)
const ASK_USER = intentTool(
  'ask_user',
  '需要委托人回答才能继续时调用。',
  z.object({ question: z.string(), options: z.array(z.string()).optional() }),
  { kind: 'await_input', code: 'ask_user' },
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
  { kind: 'await_input', code: 'propose' },
  '提议已发送给委托人',
)
const REPORT_BLOCKED = intentTool(
  'report_blocked',
  '无法继续时调用，说明受阻原因。',
  z.object({ reason: z.string() }),
  { kind: 'stop', code: 'blocked' },
  '已报告受阻',
)

function notes(reachable: boolean): Segment {
  const lines = [
    '与委托人沟通的意图工具：',
    '- 任务完成时调用 finish，参数里写完成摘要。',
    '- 无法继续时调用 report_blocked，说明原因。',
    ...(reachable
      ? ['- 需要委托人回答时调用 ask_user。', '- 需要委托人确认一组动作时调用 propose。']
      : [
          '- 委托人联系不上，不会回答提问：不要在回答里向委托人提问；缺少关键信息无法继续时，调用 report_blocked 说明缺什么。',
        ]),
    '意图工具必须单独调用，不要和其他工具在同一步调用。',
  ]
  return { role: 'system', parts: [{ type: 'text', text: lines.join('\n') }] }
}

export function intents(): Capability {
  return {
    id: 'intents',
    version: '2',
    kind: 'intents',
    async prepare(ctx) {
      const reachable = ctx.run.environment.principalReachable
      const tools = reachable
        ? [FINISH, ASK_USER, PROPOSE, REPORT_BLOCKED]
        : [FINISH, REPORT_BLOCKED]
      return {
        tools,
        description: [notes(reachable)],
        snapshot: { fingerprint: toolsFingerprint(tools) },
      }
    },
  }
}
