// 测试工具（设计 §13）：可脚本化的工具定义，记录每次调用，可注入延迟。

import { z, type ZodType } from 'zod'
import { abortError, systemClock } from '../sdk.js'
import type { Clock, JsonSchema } from '../contracts/common.js'
import type { ToolAccess, ToolCtx, ToolDef, ToolEffect, ToolIntent } from '../contracts/tool.js'

export interface FakeToolOptions {
  name: string
  description?: string
  inputSchema?: ZodType | JsonSchema
  result?: unknown
  run?: (input: unknown, ctx: ToolCtx) => Promise<unknown> | unknown
  delayMs?: number
  clock?: Clock
  effect?: ToolEffect
  exclusive?: boolean
  timeoutMs?: number
  maxOutputChars?: number
  intent?: ToolIntent
  repeatable?: boolean
  risk?: 'low' | 'high'
  access?: (input: unknown) => ToolAccess
  validate?: ToolDef['validate']
}

export type FakeTool = ToolDef & { calls: Array<{ input: unknown; ctx: ToolCtx }> }

function wait(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const onAbort = () => {
      cancel()
      reject(abortError())
    }
    const cancel = clock.setTimer(ms, () => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 只保留有值的字段；全部为空时返回 undefined。 */
function compact<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined
}

export function fakeTool(opts: FakeToolOptions): FakeTool {
  const calls: FakeTool['calls'] = []
  const clock = opts.clock ?? systemClock()
  const tool: FakeTool = {
    name: opts.name,
    description: opts.description ?? `fake tool ${opts.name}`,
    inputSchema: opts.inputSchema ?? z.looseObject({}),
    calls,
    async execute(input, ctx) {
      calls.push({ input, ctx })
      if (opts.delayMs) await wait(clock, opts.delayMs, ctx.signal)
      if (opts.run) return opts.run(input, ctx)
      return opts.result ?? 'ok'
    },
  }
  if (opts.validate) tool.validate = opts.validate
  const execution = compact({
    effect: opts.effect,
    exclusive: opts.exclusive,
    timeoutMs: opts.timeoutMs,
    maxOutputChars: opts.maxOutputChars,
  })
  if (execution) tool.execution = execution
  const safety = compact({ risk: opts.risk, access: opts.access })
  if (safety) tool.safety = safety
  const semantics = compact({ intent: opts.intent, repeatable: opts.repeatable })
  if (semantics) tool.semantics = semantics
  return tool
}
