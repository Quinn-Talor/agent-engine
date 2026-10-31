import { describe, expect, it } from 'vitest'
import { parseMcpConfig } from './parse-mcp-config.js'

describe('parseMcpConfig', () => {
  it('AC-016 turns .mcp.json servers into specs with secret references', () => {
    const json = JSON.stringify({
      mcpServers: {
        market: {
          command: 'npx',
          args: ['-y', 'market-mcp'],
          env: { API_KEY: '${MARKET_KEY}', REGION: 'cn', MIXED: 'k-${MARKET_KEY}' },
          cwd: '/srv/market',
        },
        crm: {
          type: 'http',
          url: 'https://crm.example/mcp',
          headers: { Authorization: '${CRM_TOKEN}' },
        },
        docs: { url: 'https://docs.example/mcp' },
      },
    })
    expect(parseMcpConfig(json)).toEqual([
      {
        name: 'market',
        transport: {
          kind: 'stdio',
          command: 'npx',
          args: ['-y', 'market-mcp'],
          env: {
            API_KEY: { secret: 'MARKET_KEY' },
            REGION: 'cn',
            MIXED: { secret: 'MARKET_KEY', template: 'k-${MARKET_KEY}' },
          },
          cwd: '/srv/market',
        },
      },
      {
        name: 'crm',
        transport: {
          kind: 'http',
          url: 'https://crm.example/mcp',
          headers: { Authorization: { secret: 'CRM_TOKEN' } },
        },
      },
      { name: 'docs', transport: { kind: 'http', url: 'https://docs.example/mcp' } },
    ])
  })

  it('turns a variable embedded in a value into a templated secret reference', () => {
    const [http, stdio] = parseMcpConfig({
      mcpServers: {
        a: {
          url: 'https://x',
          headers: {
            Authorization: 'Bearer ${TOKEN}',
            Twice: '${TOKEN}:${TOKEN}',
            Plain: '$TOKEN',
          },
        },
        b: { command: 'npx', args: ['--key', '${KEY}'], env: { URL: 'https://u:${PW}@db' } },
      },
    })
    expect(http!.transport).toEqual({
      kind: 'http',
      url: 'https://x',
      headers: {
        Authorization: { secret: 'TOKEN', template: 'Bearer ${TOKEN}' },
        Twice: { secret: 'TOKEN', template: '${TOKEN}:${TOKEN}' },
        Plain: '$TOKEN',
      },
    })
    expect(stdio!.transport).toMatchObject({
      args: ['--key', { secret: 'KEY' }],
      env: { URL: { secret: 'PW', template: 'https://u:${PW}@db' } },
    })
    const [embedded] = parseMcpConfig({
      mcpServers: { c: { command: 'x', args: ['--key=${KEY}'] } },
    })
    expect(embedded!.transport).toMatchObject({
      args: [{ secret: 'KEY', template: '--key=${KEY}' }],
    })
  })

  it('rejects a value that embeds several different variables', () => {
    expect(() =>
      parseMcpConfig({
        mcpServers: { a: { url: 'https://x', headers: { Authorization: '${USER}:${PASS}' } } },
      }),
    ).toThrow(
      'MCP 服务器 a 的 headers.Authorization 引用了多个变量（USER、PASS），一个值只能引用一个凭据',
    )
  })

  it('accepts an already parsed object', () => {
    expect(parseMcpConfig({ mcpServers: { a: { command: 'a' } } })).toEqual([
      { name: 'a', transport: { kind: 'stdio', command: 'a' } },
    ])
  })

  it.each([
    [{ mcpServers: { broken: { args: [] } } }, 'MCP 服务器 broken 缺少 command 或 url'],
    [
      { mcpServers: { legacy: { type: 'sse', url: 'https://x' } } },
      'MCP 服务器 legacy 使用 SSE 传输，暂不支持',
    ],
    [{ servers: {} }, '缺少 mcpServers'],
    [null, '缺少 mcpServers'],
  ])('AC-017 rejects %j', (json, message) => {
    expect(() => parseMcpConfig(json)).toThrow(message)
  })
})
