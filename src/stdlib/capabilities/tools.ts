// 标准能力：工具、工具集、能力包（设计 §4.2）。

import { z, type ZodType } from 'zod'
import { hashOf, toolError } from '../../sdk.js'
import type { Capability, Prepared } from '../../contracts/capability.js'
import type { Segment } from '../../contracts/common.js'
import type { Guard } from '../../contracts/component.js'
import type { ToolDef } from '../../contracts/tool.js'

const isZod = (schema: unknown): schema is ZodType =>
  typeof (schema as { safeParse?: unknown }).safeParse === 'function'

/** 输入 schema 的 JSON 形式；zod schema 转不过去时（例如 z.date()）报出是哪个工具。 */
function jsonSchemaOf(def: ToolDef): unknown {
  if (!isZod(def.inputSchema)) return def.inputSchema
  try {
    return z.toJSONSchema(def.inputSchema)
  } catch (error) {
    throw new Error(
      `工具 ${def.name} 的 schema 不能转成 JSON Schema：${(error as Error).message}`,
      {
        cause: error,
      },
    )
  }
}

/** 能力快照指纹：工具名、描述、schema（设计 §6.4）。 */
export function toolsFingerprint(defs: readonly ToolDef[]): string {
  return hashOf(
    defs.map((d) => ({ name: d.name, description: d.description, schema: jsonSchemaOf(d) })),
  )
}

/**
 * 工具定义哈希（设计 §6.4，Agent 指纹含每项能力的配置哈希）：名称、描述、schema 与执行、安全、语义属性；
 * 函数不进入哈希，只记是否声明了 `safety.access`。
 */
export function toolDefinitionsHash(defs: readonly ToolDef[]): string {
  return hashOf(
    defs.map((d) => ({
      name: d.name,
      description: d.description,
      schema: jsonSchemaOf(d),
      risk: d.safety?.risk ?? null,
      access: d.safety?.access !== undefined,
      execution: {
        effect: d.execution.effect,
        exclusive: d.execution.exclusive ?? null,
        timeoutMs: d.execution.timeoutMs ?? null,
        maxOutputChars: d.execution.maxOutputChars ?? null,
      },
      semantics: d.semantics ?? null,
    })),
  )
}

/**
 * 工具定义在创建时复制一份并算好哈希（I14）：之后改动传入的数组不影响能力与 Agent 指纹；
 * schema 转不成 JSON Schema 的工具在这里就报错，不等到运行时才让整项能力不可用。
 */
export function tools(
  defs: ToolDef[],
  opts: { id?: string; description?: Segment[]; exposure?: 'eager' | 'deferred' } = {},
): Capability {
  const list = [...defs]
  const exposure = opts.exposure ?? 'eager'
  const fingerprint = toolsFingerprint(list)
  return {
    id: opts.id ?? `tools:${list.map((d) => d.name).join('+')}`,
    version: '1',
    kind: 'tool',
    config: { tools: list.map((d) => d.name), exposure, definitions: toolDefinitionsHash(list) },
    async prepare() {
      const prepared: Prepared = { tools: list, exposure, snapshot: { fingerprint } }
      if (opts.description) prepared.description = opts.description
      return prepared
    },
  }
}

export function tool(
  def: ToolDef,
  opts: { id?: string; exposure?: 'eager' | 'deferred' } = {},
): Capability {
  return tools([def], {
    id: opts.id ?? `tool:${def.name}`,
    ...(opts.exposure ? { exposure: opts.exposure } : {}),
  })
}

/** 部分不可用时（例如 MCP 熔断），它的工具直接返回 TOOL_UNAVAILABLE；没有 available 的部分原样保留。 */
function withAvailability(part: Prepared): ToolDef[] {
  const available = part.available
  if (!available) return part.tools
  return part.tools.map((def) => ({
    ...def,
    execute: (input, ctx) =>
      available()
        ? def.execute(input, ctx)
        : Promise.resolve(
            toolError(
              'TOOL_UNAVAILABLE',
              `工具 ${def.name} 依赖的服务暂时不可用`,
              '改用其他能力，或说明限制',
            ),
          ),
  }))
}

/**
 * 能力包：展开内部能力；任一内部能力准备失败，整个能力包失败。每个部分的可用性和呈现方式落在它自己的工具上；
 * 能力包整体的呈现方式在全部部分 deferred 时为 deferred，否则为 eager。
 */
export function bundle(spec: {
  id: string
  version?: string
  capabilities: Capability[]
  description?: Segment[]
  guards?: Guard[]
}): Capability {
  return {
    id: spec.id,
    version: spec.version ?? '1',
    kind: 'bundle',
    config: {
      capabilities: spec.capabilities.map((c) => ({
        id: c.id,
        kind: c.kind,
        version: c.version,
        config: c.config ?? null,
      })),
    },
    async prepare(ctx) {
      const parts: Prepared[] = []
      try {
        for (const c of spec.capabilities) parts.push(await c.prepare(ctx))
      } catch (error) {
        for (const p of parts) p.release?.()
        throw error
      }
      return {
        tools: parts.flatMap(withAvailability),
        description: [...(spec.description ?? []), ...parts.flatMap((p) => p.description ?? [])],
        guards: [...(spec.guards ?? []), ...parts.flatMap((p) => p.guards ?? [])],
        exposure:
          parts.length > 0 && parts.every((p) => p.exposure === 'deferred') ? 'deferred' : 'eager',
        toolExposure: Object.fromEntries(
          parts.flatMap((p) => p.tools.map((t) => [t.name, p.exposure ?? 'eager'] as const)),
        ),
        snapshot: {
          fingerprint: hashOf(parts.map((p) => p.snapshot.fingerprint)),
          detail: { parts: spec.capabilities.map((c) => c.id) },
        },
        release: () => parts.forEach((p) => p.release?.()),
      }
    },
  }
}
