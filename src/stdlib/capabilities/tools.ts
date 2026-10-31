// 标准能力：工具、工具集、能力包（设计 §4.2）。

import { z, type ZodType } from 'zod'
import { hashOf, toolError } from '../../api.js'
import type { Capability, Prepared } from '../../contracts/capability.js'
import type { Segment } from '../../contracts/common.js'
import type { Guard } from '../../contracts/component.js'
import type { ToolDef } from '../../contracts/tool.js'

const isZod = (schema: unknown): schema is ZodType =>
  typeof (schema as { safeParse?: unknown }).safeParse === 'function'

/** 能力快照指纹：工具名、描述、schema（设计 §6.4）。 */
export function toolsFingerprint(defs: readonly ToolDef[]): string {
  return hashOf(
    defs.map((d) => ({
      name: d.name,
      description: d.description,
      schema: isZod(d.inputSchema) ? z.toJSONSchema(d.inputSchema) : d.inputSchema,
    })),
  )
}

export function tools(
  defs: ToolDef[],
  opts: { id?: string; description?: Segment[]; exposure?: 'eager' | 'deferred' } = {},
): Capability {
  const exposure = opts.exposure ?? 'eager'
  return {
    id: opts.id ?? `tools:${defs.map((d) => d.name).join('+')}`,
    version: '1',
    kind: 'tool',
    config: { tools: defs.map((d) => d.name), exposure },
    async prepare() {
      const prepared: Prepared = {
        tools: defs,
        exposure,
        snapshot: { fingerprint: toolsFingerprint(defs) },
      }
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
