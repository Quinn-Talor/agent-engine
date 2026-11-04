// MCP 契约：服务器规格、连接端口（patterns P6；适配器在 adapters/mcp-*）（设计 §4.2、§8.3）。

import type { JsonSchema, SecretRef } from './common.js'

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

// ── 连接端口 ─────────────────────────────────────────────────────────

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema: JsonSchema
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean; destructiveHint?: boolean }
}

export interface McpCallResult {
  /** MCP 的内容块：`image` 块带 base64 的 `data` 与 `mimeType`。 */
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
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
