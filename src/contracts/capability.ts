// 能力契约：能力、准备上下文与结果、能力快照、能力宿主、MCP 规格（设计 §4.2、§8.3）。

import type {
  JsonSchema,
  JsonValue,
  ModelMessage,
  SecretRef,
  SecretResolver,
  Segment,
} from './common.js'
import type { Guard, RunInfo } from './component.js'
import type { BreakerStatus } from './engine.js'
import type { ToolDef, ToolEffect, ToolIntent } from './tool.js'

export interface Capability {
  id: string
  version: string
  /** 'tool' | 'mcp' | 'skill' | 'subagent' | 'planning' | 'intents' | 'bundle' | 自定义 */
  kind: string
  /** 可序列化的配置，进入 Agent 指纹（方案 D14）。 */
  config?: JsonValue
  /** 运行开始时执行一次，结果冻结。 */
  prepare(ctx: PrepareCtx): Promise<Prepared>
}

export interface PrepareCtx {
  run: RunInfo
  signal: AbortSignal
  deadline: number
  /** 取得对应的能力宿主，例如 MCP 连接池；宿主不存在时抛错。 */
  host<T>(kind: string): T
  /** 按引用解析凭据，解析结果不进日志。 */
  vault: SecretResolver
  /** 任务的 history（只读），供需要参考前文的能力使用。 */
  history?: readonly ModelMessage[]
}

export interface Prepared {
  tools: ToolDef[]
  /** 能力说明，进入视图的稳定前缀。 */
  description?: Segment[]
  /** 能力自带的守卫，来源为 `capability:<id>`。 */
  guards?: Guard[]
  /** 默认呈现方式，供工具呈现参考。 */
  exposure?: 'eager' | 'deferred'
  /** 按工具覆盖呈现方式，例如能力包里各部分的呈现方式不同。 */
  toolExposure?: Record<string, 'eager' | 'deferred'>
  snapshot: { fingerprint: string; detail?: unknown }
  /** 所属依赖是否可用（例如 MCP 服务器的熔断）；不可用时调用直接返回 TOOL_UNAVAILABLE。 */
  available?(): boolean
  /** 运行结束时调用。 */
  release?(): void
}

/** 写入 `run_started` 的能力快照（设计 §3.4、§6.4）。 */
export interface CapabilitySnapshot {
  capability: string
  kind: string
  version: string
  fingerprint: string
  /** 工具的语义写入日志，步事实与回放只读日志即可得到（F2 §B.4.4）。 */
  tools: Array<{
    name: string
    schemaHash: string
    intent?: ToolIntent
    effect?: ToolEffect
    repeatable?: boolean
  }>
  detail?: unknown
}

/** 能力宿主：MCP 连接池、skill 宿主、委托调度、hook 执行器；可以注册新的宿主。 */
export interface CapabilityHost {
  readonly kind: string
  shutdown?(): Promise<void>
  /** 宿主管理的依赖的熔断状态（例如 MCP 服务器），并入 `engine.health()`。 */
  health?(): BreakerStatus[]
  onHealth?(fn: (status: BreakerStatus) => void): () => void
}

export interface McpServerSpec {
  name: string
  transport:
    | {
        kind: 'stdio'
        command: string
        args?: Array<string | SecretRef>
        env?: Record<string, string | SecretRef>
        cwd?: string
      }
    | { kind: 'http'; url: string; headers?: Record<string, string | SecretRef> }
  tools?: { include?: string[]; exclude?: string[] }
  /** 默认 deferred。 */
  exposure?: 'deferred' | 'eager'
  /** 默认 3 秒。 */
  connectTimeoutMs?: number
  callTimeoutMs?: number
  /**
   * 工具返回 `isError` 时的错误类别：键为服务器上的原始工具名，`*` 为缺省。
   * 不声明时按 `TOOL_EXCEPTION`（瞬时）处理，同样的输入允许再试一次。
   */
  errorClass?: Record<string, 'deterministic' | 'transient'>
}

// ── MCP 连接端口（patterns P6；适配器在 adapters/mcp-*） ─────────────────

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema: JsonSchema
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean; destructiveHint?: boolean }
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
  structuredContent?: unknown
}

export interface McpConnection {
  listTools(): Promise<McpToolInfo[]>
  callTool(
    name: string,
    args: unknown,
    opts: { signal: AbortSignal; timeoutMs: number },
  ): Promise<McpCallResult>
  /** 服务器通知工具列表变化。 */
  onToolsChanged(fn: () => void): void
  /** 连接意外断开（主动 close 不触发）。 */
  onClose(fn: () => void): void
  close(): Promise<void>
}

/** 凭据引用已经解析成值的服务器规格，只交给连接函数，不进日志。 */
export interface ResolvedMcpServer {
  name: string
  transport:
    | {
        kind: 'stdio'
        command: string
        args?: string[]
        env?: Record<string, string>
        cwd?: string
      }
    | { kind: 'http'; url: string; headers?: Record<string, string> }
}

/** 按传输方式建立 MCP 连接。 */
export type McpConnect = (
  server: ResolvedMcpServer,
  opts: { signal: AbortSignal },
) => Promise<McpConnection>

// ── hook 执行端口（patterns P6；适配器在 adapters/hook-process） ───────────

export interface HookExecResult {
  /** 被信号结束时为 null。 */
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** 经 shell 执行一条命令，把 input 写入标准输入，收集输出。 */
export type HookExec = (
  command: string,
  input: string,
  opts: { timeoutMs: number; signal?: AbortSignal; cwd?: string },
) => Promise<HookExecResult>
