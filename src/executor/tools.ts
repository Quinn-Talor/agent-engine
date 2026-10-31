// 已准备工具：编译 schema（zod 或 JSON Schema），带上所属能力与副作用类型。准备环节逐个调用。

import { z, type ZodType } from 'zod'
import type { JsonSchema } from '../contracts/common.js'
import type { ModelToolSpec } from '../contracts/model.js'
import type { ToolDef, ToolEffect } from '../contracts/tool.js'

export interface PreparedTool {
  def: ToolDef
  capability: string
  schema: ZodType
  jsonSchema: JsonSchema
  effect: ToolEffect
  /** 参数校验失败时的错误码；submit 为 OUTPUT_INVALID（设计 §8.4）。 */
  invalidInputCode: 'INVALID_INPUT' | 'OUTPUT_INVALID'
  /** 所属依赖是否可用（熔断，设计 §8.2 f）。 */
  available?: () => boolean
}

const isZod = (schema: unknown): schema is ZodType =>
  typeof (schema as { safeParse?: unknown }).safeParse === 'function'

export function prepareTool(
  def: ToolDef,
  capability: string,
  opts: { invalidInputCode?: PreparedTool['invalidInputCode']; available?: () => boolean } = {},
): PreparedTool {
  let schema: ZodType
  let jsonSchema: JsonSchema
  if (isZod(def.inputSchema)) {
    schema = def.inputSchema
    jsonSchema = z.toJSONSchema(schema) as JsonSchema
  } else {
    try {
      schema = z.fromJSONSchema(def.inputSchema as Parameters<typeof z.fromJSONSchema>[0])
    } catch (error) {
      throw new Error(`工具 ${def.name} 的 schema 不能编译：${(error as Error).message}`, {
        cause: error,
      })
    }
    jsonSchema = def.inputSchema
  }
  const tool: PreparedTool = {
    def,
    capability,
    schema,
    jsonSchema,
    effect: def.execution?.effect ?? 'side_effect',
    invalidInputCode: opts.invalidInputCode ?? 'INVALID_INPUT',
  }
  if (opts.available) tool.available = opts.available
  return tool
}

export function toModelTool(tool: PreparedTool): ModelToolSpec {
  return { name: tool.def.name, description: tool.def.description, inputSchema: tool.jsonSchema }
}
