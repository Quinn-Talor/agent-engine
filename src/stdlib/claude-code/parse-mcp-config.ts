// MCP 配置解析（设计 §4.2 插件表、§11 格式解析）：`.mcp.json` 的 mcpServers → 服务器规格。
// 启动参数、环境变量与请求头里的 `${VAR}` 写成凭据引用：整值为 `${VAR}` 时是 `{ secret }`，嵌在字符串里时
// （例如 `Bearer ${TOKEN}`）带上原文模板，由 MCP 宿主解析；一个值只能引用一个变量。
// 只解析标准格式，SSE 传输暂不支持。

import type { McpServerSpec, SecretRef } from '../../api.js'

const SECRET = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/
const EMBEDDED = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function secretOf(value: unknown, where: string): string | SecretRef {
  const text = String(value)
  const whole = SECRET.exec(text)
  const names = [...new Set(Array.from(text.matchAll(EMBEDDED), (m) => m[1]!))]
  if (names.length > 1) {
    throw new Error(`${where} 引用了多个变量（${names.join('、')}），一个值只能引用一个凭据`)
  }
  return whole
    ? { secret: whole[1]! }
    : names.length === 1
      ? { secret: names[0]!, template: text }
      : text
}

function secretify(record: unknown, where: string): Record<string, string | SecretRef> | undefined {
  if (!isObject(record)) return undefined
  const out: Record<string, string | SecretRef> = {}
  for (const [key, value] of Object.entries(record)) out[key] = secretOf(value, `${where}.${key}`)
  return out
}

export function parseMcpConfig(json: string | unknown): McpServerSpec[] {
  const config: unknown = typeof json === 'string' ? JSON.parse(json) : json
  const servers = isObject(config) ? config.mcpServers : undefined
  if (!isObject(servers)) throw new Error('缺少 mcpServers')
  return Object.entries(servers).map(([name, raw]): McpServerSpec => {
    const cfg = isObject(raw) ? raw : {}
    if (typeof cfg.command === 'string') {
      const env = secretify(cfg.env, `MCP 服务器 ${name} 的 env`)
      return {
        name,
        transport: {
          kind: 'stdio',
          command: cfg.command,
          ...(Array.isArray(cfg.args)
            ? { args: cfg.args.map((a, i) => secretOf(a, `MCP 服务器 ${name} 的 args[${i}]`)) }
            : {}),
          ...(env ? { env } : {}),
          ...(typeof cfg.cwd === 'string' ? { cwd: cfg.cwd } : {}),
        },
      }
    }
    if (cfg.type === 'sse') throw new Error(`MCP 服务器 ${name} 使用 SSE 传输，暂不支持`)
    if (typeof cfg.url === 'string') {
      const headers = secretify(cfg.headers, `MCP 服务器 ${name} 的 headers`)
      return { name, transport: { kind: 'http', url: cfg.url, ...(headers ? { headers } : {}) } }
    }
    throw new Error(`MCP 服务器 ${name} 缺少 command 或 url`)
  })
}
