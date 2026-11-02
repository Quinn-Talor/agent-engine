// 按传输方式分派到官方 SDK 的 stdio / Streamable HTTP 适配器（设计 §8.3）。
// 第一次连接时才加载：MCP SDK 是可选的 peer 依赖，不用 MCP 的应用不必安装；没装时给出能照着做的错误，
// 而不是一条看不出原因的连接失败。

import type { McpConnect } from '../sdk.js'

const SDK_PACKAGE = '@modelcontextprotocol/sdk'

/** 加载失败是因为没装 MCP SDK 时，换成说明要装什么的错误；其他错误原样返回。 */
export function explainMissingSdk(error: unknown): unknown {
  const missing =
    error instanceof Error &&
    (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' &&
    error.message.includes(SDK_PACKAGE)
  return missing
    ? new Error(`接 MCP 服务器需要安装可选依赖 ${SDK_PACKAGE}`, { cause: error })
    : error
}

export const mcpConnect: McpConnect = async (server, opts) => {
  try {
    return server.transport.kind === 'stdio'
      ? (await import('./mcp-stdio/mcp-stdio.js')).stdioConnect(server, opts)
      : (await import('./mcp-http/mcp-http.js')).httpConnect(server, opts)
  } catch (error) {
    throw explainMissingSdk(error)
  }
}
