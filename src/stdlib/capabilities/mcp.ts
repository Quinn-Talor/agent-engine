// MCP 能力（设计 §4.2）：从连接池取连接，列出工具，按工具列表生成快照；工具名为 `服务器名__工具名`，
// 不符合厂商格式时改用规整名字（调用仍用原名，快照记 renamed）；annotations 映射副作用；默认延后呈现。
// 依赖不可用由失败连击（external_failure）与封路处理。

import { z } from 'zod'
import { hashOf, toolError } from '../../api.js'
import type {
  Capability,
  JsonValue,
  McpCallResult,
  McpHost,
  McpServerSpec,
  McpToolInfo,
  ToolDef,
  ToolEffect,
} from '../../api.js'

const DEFAULT_CALL_TIMEOUT_MS = 30_000
/** 厂商通用的工具名格式。 */
const VALID_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
/** 规整名字：前缀最多 55 个字符 + `_` + 8 位哈希 = 64。 */
const COMPLIANT_PREFIX_CHARS = 55
/** 工具超时比 SDK 请求超时多 1 秒，让请求超时先触发并计入熔断。 */
const TOOL_TIMEOUT_GRACE_MS = 1000

function effectOf(t: McpToolInfo): ToolEffect {
  if (t.annotations?.readOnlyHint) return 'none'
  if (t.annotations?.idempotentHint) return 'idempotent'
  return 'side_effect'
}

type Schema = McpToolInfo['inputSchema']

/** zod 编译不了、只表达条件约束的关键字：去掉后属性和类型仍然完整。 */
const CONDITIONAL_KEYS = new Set([
  'if',
  'then',
  'else',
  'not',
  'dependentSchemas',
  'dependentRequired',
])

/** 深拷贝并逐个节点改写；改写函数返回新的节点。 */
function mapSchema(
  value: unknown,
  fn: (node: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (Array.isArray(value)) return value.map((v) => mapSchema(v, fn))
  if (typeof value !== 'object' || value === null) return value
  const node = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapSchema(v, fn)]))
  return fn(node)
}

/** draft-07 的 `definitions` 改成 `$defs`，引用跟着改（zod 只认 `$defs`）。 */
function normalize(schema: Schema): Schema {
  const moved = mapSchema(schema, (node) =>
    typeof node.$ref === 'string' && node.$ref.startsWith('#/definitions/')
      ? { ...node, $ref: `#/$defs/${node.$ref.slice('#/definitions/'.length)}` }
      : node,
  ) as Schema
  const { definitions, ...rest } = moved as Schema & { definitions?: unknown }
  return definitions !== undefined && rest.$defs === undefined
    ? ({ ...rest, $defs: definitions } as Schema)
    : moved
}

/** 去掉条件约束和找不到目标的引用。 */
function relax(schema: Schema): Schema {
  const defs = (schema as { $defs?: Record<string, unknown> }).$defs ?? {}
  return mapSchema(schema, (node) => {
    const kept = Object.fromEntries(Object.entries(node).filter(([k]) => !CONDITIONAL_KEYS.has(k)))
    const ref = kept.$ref
    if (typeof ref === 'string' && !(ref.startsWith('#/$defs/') && ref.slice(8) in defs)) {
      delete kept.$ref
    }
    return kept
  }) as Schema
}

/**
 * 模型和校验用的 schema：能编译就原样用；draft-07 的引用改写后能编译就用改写的；还不行就去掉
 * 条件约束（记为 relaxed）；都不行返回 undefined（工具跳过，记为 skipped）。
 */
function usableSchema(schema: Schema): { schema: Schema; relaxed: boolean } | undefined {
  if (compiles(schema)) return { schema, relaxed: false }
  const normalized = normalize(schema)
  if (compiles(normalized)) return { schema: normalized, relaxed: false }
  const relaxed = relax(normalized)
  return compiles(relaxed) ? { schema: relaxed, relaxed: true } : undefined
}

function compiles(schema: Schema): boolean {
  try {
    z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
    return true
  } catch {
    return false
  }
}

/** 不合规的完整名字的替代：非法字符换成 `_`，截断后接原名哈希的前 8 位（稳定、跨能力不撞名）。 */
function compliantName(fullName: string): string {
  const prefix = fullName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, COMPLIANT_PREFIX_CHARS)
  return `${prefix}_${hashOf(fullName).slice(0, 8)}`
}

/** 工具名：合规的完整名字原样使用；不合规的规整，能力内与已用名字重复的跳过。 */
function toolNames(
  server: string,
  tools: McpToolInfo[],
): { names: Map<string, string>; renamed: Record<string, string>; skipped: string[] } {
  const full = (t: McpToolInfo) => `${server}__${t.name}`
  const names = new Map<string, string>()
  const used = new Set<string>()
  for (const t of tools) {
    if (!VALID_TOOL_NAME.test(full(t))) continue
    names.set(t.name, full(t))
    used.add(full(t))
  }
  const renamed: Record<string, string> = {}
  const skipped: string[] = []
  for (const t of tools) {
    if (names.has(t.name)) continue
    const name = compliantName(full(t))
    if (used.has(name)) {
      skipped.push(t.name)
      continue
    }
    names.set(t.name, name)
    used.add(name)
    renamed[t.name] = name
  }
  return { names, renamed, skipped }
}

function mapResult(r: McpCallResult, errorClass?: 'deterministic' | 'transient'): unknown {
  const text = r.content.map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n')
  if (r.isError) {
    const envelope = toolError('TOOL_EXCEPTION', text || 'MCP 工具返回错误')
    return errorClass ? { ...envelope, errorClass } : envelope
  }
  if (!text && r.structuredContent !== undefined) return JSON.stringify(r.structuredContent)
  return text
}

/** 工具声明的错误类别：先找工具自己的，再找 `*`；只认规格自己的键（工具可能叫 `constructor`）。 */
function errorClassOf(spec: McpServerSpec, tool: string) {
  const declared = spec.errorClass ?? {}
  if (Object.hasOwn(declared, tool)) return declared[tool]
  return Object.hasOwn(declared, '*') ? declared['*'] : undefined
}

export function mcp(spec: McpServerSpec): Capability {
  const callTimeoutMs = spec.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  return {
    id: `mcp:${spec.name}`,
    version: '2',
    kind: 'mcp',
    // 规格只含凭据的引用名，可以序列化进入 Agent 指纹（方案 D14）；JSON 往返得到 JsonValue。
    config: JSON.parse(JSON.stringify(spec)) as JsonValue,
    async prepare(ctx) {
      const lease = await ctx
        .host<McpHost>('mcp')
        .acquire(spec, { vault: ctx.vault, signal: ctx.signal })
      const include = spec.tools?.include
      const exclude = new Set(spec.tools?.exclude ?? [])
      const listed = lease.tools.filter(
        (t) => (!include || include.includes(t.name)) && !exclude.has(t.name),
      )
      const schemas = new Map(listed.map((t) => [t.name, usableSchema(t.inputSchema)]))
      const skipped = listed.filter((t) => !schemas.get(t.name)).map((t) => t.name)
      const relaxed = listed.filter((t) => schemas.get(t.name)?.relaxed).map((t) => t.name)
      const schemaOk = listed.filter((t) => !skipped.includes(t.name))
      const named = toolNames(spec.name, schemaOk)
      const provided = schemaOk.filter((t) => named.names.has(t.name))
      const allSkipped = [...skipped, ...named.skipped]
      const tools: ToolDef[] = provided.map((t) => ({
        name: named.names.get(t.name)!,
        description: t.description ?? t.name,
        inputSchema: schemas.get(t.name)!.schema,
        execution: { effect: effectOf(t), timeoutMs: callTimeoutMs + TOOL_TIMEOUT_GRACE_MS },
        async execute(input, toolCtx) {
          return mapResult(
            await lease.call(t.name, input, { signal: toolCtx.signal, timeoutMs: callTimeoutMs }),
            errorClassOf(spec, t.name),
          )
        },
      }))
      return {
        tools,
        exposure: spec.exposure ?? 'deferred',
        snapshot: {
          fingerprint: hashOf(
            provided.map((t) => ({
              name: t.name,
              description: t.description ?? null,
              inputSchema: t.inputSchema,
              annotations: t.annotations ?? null,
            })),
          ),
          detail: {
            server: spec.name,
            version: lease.version,
            ...(allSkipped.length > 0 ? { skipped: allSkipped } : {}),
            ...(relaxed.length > 0 ? { relaxed } : {}),
            ...(Object.keys(named.renamed).length > 0 ? { renamed: named.renamed } : {}),
          },
        },
        available: lease.available,
        release: lease.release,
      }
    },
  }
}
