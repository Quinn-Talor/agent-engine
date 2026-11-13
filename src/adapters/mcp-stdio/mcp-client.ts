// SDK 客户端封装（patterns P6）：把官方 `Client` 翻译成引擎的 McpConnection。
// stdio 与 HTTP 两个适配器使用同一个外部库，共用这一层；HTTP 适配器从这里引用。

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { JsonSchema, McpCallResult, McpConnection, McpToolInfo } from '../../sdk.js'

export const CLIENT_INFO = { name: 'agent-engine', version: '0.1.1' }

type ListedTool = Awaited<ReturnType<Client['listTools']>>['tools'][number]

function toolInfo(t: ListedTool): McpToolInfo {
  const a = t.annotations
  const annotations = a
    ? {
        ...(a.readOnlyHint !== undefined ? { readOnlyHint: a.readOnlyHint } : {}),
        ...(a.idempotentHint !== undefined ? { idempotentHint: a.idempotentHint } : {}),
        ...(a.destructiveHint !== undefined ? { destructiveHint: a.destructiveHint } : {}),
      }
    : undefined
  return {
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    inputSchema: t.inputSchema as JsonSchema,
    ...(annotations && Object.keys(annotations).length > 0 ? { annotations } : {}),
  }
}

export function wrapClient(client: Client): McpConnection {
  const changed: Array<() => void> = []
  const closes: Array<() => void> = []
  let closing = false
  client.onclose = () => {
    if (!closing) for (const fn of closes) fn()
  }
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    for (const fn of changed) fn()
  })

  return {
    async listTools() {
      const tools: McpToolInfo[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined)
        tools.push(...page.tools.map(toolInfo))
        cursor = page.nextCursor
      } while (cursor)
      return tools
    },
    async callTool(name, args, { signal, timeoutMs }) {
      const r = await client.callTool(
        { name, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { signal, timeout: timeoutMs },
      )
      const result: McpCallResult = {
        content:
          'content' in r && Array.isArray(r.content) ? (r.content as McpCallResult['content']) : [],
      }
      if (r.isError === true) result.isError = true
      if (r.structuredContent !== undefined) result.structuredContent = r.structuredContent
      return result
    },
    onToolsChanged: (fn) => void changed.push(fn),
    onClose: (fn) => void closes.push(fn),
    async close() {
      closing = true
      await client.close()
    },
  }
}
