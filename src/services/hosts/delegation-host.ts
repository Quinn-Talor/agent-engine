// 委托宿主（设计 §8.3）：每次运行一个共享的委托工具 delegate，参数里用枚举选择子 agent；
// 经 ctx.spawn 启动子运行（深度、防环、次数、预算由引擎强制），把子运行的结果映射成文本或 SUBAGENT_* 信封。

import type { Agent } from '../../contracts/agent.js'
import type { CapabilityHost } from '../../contracts/capability.js'
import type { Environment } from '../../contracts/environment.js'
import { toolError } from '../../contracts/errors.js'
import type { RunResult } from '../../contracts/run.js'
import type { Budget } from '../../contracts/task.js'
import type { ToolDef } from '../../contracts/tool.js'
import { defineTask } from '../../core/definition/define.js'

/** 子运行的时长由它自己的预算约束；委托工具本身不再用默认的 30 秒超时。 */
const DELEGATE_TIMEOUT_MS = 86_400_000

export interface SubagentSpec {
  name: string
  description: string
  agent: Agent
  budget?: Budget
  environment?: Environment
}

export interface DelegationHost extends CapabilityHost {
  readonly kind: 'delegation'
  /** 在能力准备时同步调用：同一运行的多个子 agent 拿到同一个委托工具。 */
  register(runId: string, spec: SubagentSpec): { tool: ToolDef; release(): void }
}

interface RunAgents {
  specs: Map<string, SubagentSpec>
  /** 委托工具参数的枚举，与 schema 中的数组是同一个对象。 */
  names: string[]
  refs: number
  tool: ToolDef
}

const json = (value: unknown) => JSON.stringify(value)

/** 子运行结果 → 文本或 SUBAGENT_* 信封（设计 §8.3）。 */
function mapResult(result: RunResult): unknown {
  const code = result.code ?? result.status
  const text =
    result.text ||
    (result.output !== undefined ? json(result.output) : '') ||
    (result.intent ? json(result.intent.input) : '')
  const detail = text || result.error?.message
  const message = detail ? `${code}: ${detail}` : code
  switch (result.status) {
    case 'completed':
      return text || '子 agent 已完成'
    case 'finalized':
      return `（阶段性结果，子 agent 未完成：${code}）\n${text}`
    case 'awaiting_input':
      // 子运行在等审批：用同一个错误码，父运行同样以 approval_pending 结束。
      if (result.code === 'approval_pending') {
        return toolError(
          'APPROVAL_PENDING',
          `子 agent 的操作在等委托人审批：${message}`,
          '不要重试，也不要换做法；委托人答复后会接着做',
        )
      }
      return toolError('SUBAGENT_NEEDS_INPUT', message, '补充信息后重新委托，或自己完成')
    case 'stopped':
      return toolError('SUBAGENT_STOPPED', message, '换一种做法，或自己完成')
    case 'failed':
      return toolError('SUBAGENT_FAILED', message, '换一种做法，或自己完成')
    case 'aborted':
      return toolError('SUBAGENT_ABORTED', message, '换一种做法，或自己完成')
  }
}

export function delegationHost(): DelegationHost {
  const runs = new Map<string, RunAgents>()

  const toolFor = (names: string[]): ToolDef => ({
    name: 'delegate',
    description: '把子任务委托给一个子 agent，返回它的结果',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: names },
        task: { type: 'string', minLength: 1 },
      },
      required: ['agent', 'task'],
      additionalProperties: false,
    },
    // 子运行的副作用另进台账；委托本身按有副作用处理（I15）。
    execution: { effect: 'side_effect', timeoutMs: DELEGATE_TIMEOUT_MS },
    async execute(input, ctx) {
      const { agent, task } = input as { agent: string; task: string }
      const spec = runs.get(ctx.runId)?.specs.get(agent)
      if (!spec) return toolError('INVALID_INPUT', `子 agent ${agent} 不在本次运行中`)
      const child = defineTask({
        input: [{ role: 'user', parts: [{ type: 'text', text: task }] }],
        ...(ctx.task.subject !== undefined ? { subject: ctx.task.subject } : {}),
        ...(ctx.task.context !== undefined ? { context: { ...ctx.task.context } } : {}),
        // 子运行在同一个工作区里干活：文件工具和沙箱都按父运行的工作区判断。
        ...(ctx.scope.workspace !== undefined ? { scope: { ...ctx.scope } } : {}),
        ...(spec.budget ? { budget: spec.budget } : {}),
      })
      const result = await ctx.spawn(
        spec.agent,
        child,
        ...(spec.environment ? [{ environment: spec.environment }] : []),
      )
      return mapResult(result)
    },
  })

  return {
    kind: 'delegation',
    register(runId, spec) {
      let entry = runs.get(runId)
      if (!entry) {
        const names: string[] = []
        entry = { specs: new Map(), names, refs: 0, tool: toolFor(names) }
        runs.set(runId, entry)
      }
      entry.specs.set(spec.name, spec)
      if (!entry.names.includes(spec.name)) entry.names.push(spec.name)
      entry.refs += 1
      const current = entry
      let released = false
      return {
        tool: current.tool,
        release() {
          if (released) return
          released = true
          current.refs -= 1
          if (current.refs === 0 && runs.get(runId) === current) runs.delete(runId)
        },
      }
    },
  }
}
