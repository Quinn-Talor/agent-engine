import { describe, expect, it } from 'vitest'
import { createMcpHost, hashOf, isToolError, type McpServerSpec, type ToolCtx } from '../../api.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { fakeMcpServer, type FakeMcpTool } from '../../testing/fake-mcp-server.js'
import { mcp } from './mcp.js'
import { prepareCtx } from './prepare.fixture.js'

const crm: McpServerSpec = { name: 'crm', transport: { kind: 'stdio', command: 'crm-server' } }
const TOOLS: FakeMcpTool[] = [
  {
    name: 'lookup',
    description: '查客户',
    annotations: { readOnlyHint: true },
    handler: () => '客户 A\n等级 VIP',
  },
  {
    name: 'update',
    annotations: { idempotentHint: true },
    handler: () => ({ content: [], structuredContent: { ok: 1 } }),
  },
  {
    name: 'send',
    handler: () => ({
      content: [
        { type: 'text', text: '发送失败' },
        { type: 'image', data: 'x' } as { type: string },
      ],
      isError: true,
    }),
  },
]

async function prepare(
  spec: McpServerSpec = crm,
  tools: FakeMcpTool[] = TOOLS,
  breaker?: { failureThreshold: number },
) {
  const clock = new FakeClock()
  const fake = fakeMcpServer({ tools, clock })
  const host = createMcpHost({ connect: fake.connect, clock, ...(breaker ? { breaker } : {}) })
  const prepared = await mcp(spec).prepare(
    prepareCtx({ host: <T>(kind: string) => (kind === 'mcp' ? host : undefined) as T }),
  )
  return { prepared, fake, host }
}

const ctx = { signal: new AbortController().signal } as ToolCtx

describe('mcp', () => {
  it('AC-011 identifies itself and names, classifies and defers the server tools', async () => {
    expect(mcp(crm)).toMatchObject({
      id: 'mcp:crm',
      version: '2',
      kind: 'mcp',
      config: { name: 'crm' },
    })
    const { prepared } = await prepare()
    expect(
      prepared.tools.map((t) => [t.name, t.execution?.effect, t.execution?.timeoutMs]),
    ).toEqual([
      ['crm__lookup', 'none', 31_000],
      ['crm__update', 'idempotent', 31_000],
      ['crm__send', 'side_effect', 31_000],
    ])
    expect(prepared.tools[0]!.description).toBe('查客户')
    expect(prepared.tools[1]!.description).toBe('update')
    expect(prepared.exposure).toBe('deferred')
    expect(prepared.guards).toBeUndefined()
  })

  it('AC-011 honours include, exclude, exposure and the call timeout', async () => {
    const spec = {
      ...crm,
      tools: { include: ['lookup', 'send'], exclude: ['send'] },
      exposure: 'eager' as const,
      callTimeoutMs: 5000,
    }
    const { prepared, fake } = await prepare(spec)
    expect(prepared.tools.map((t) => t.name)).toEqual(['crm__lookup'])
    expect(prepared.exposure).toBe('eager')
    expect(prepared.tools[0]!.execution?.timeoutMs).toBe(6000)
    await prepared.tools[0]!.execute({ id: 1 }, ctx)
    expect(fake.calls).toEqual([{ name: 'lookup', args: { id: 1 } }])
  })

  it('AC-012 maps text, structured content and tool errors', async () => {
    const { prepared } = await prepare()
    const [lookup, update, send] = prepared.tools
    expect(await lookup!.execute({}, ctx)).toBe('客户 A\n等级 VIP')
    expect(await update!.execute({}, ctx)).toBe('{"ok":1}')
    const out = await send!.execute({}, ctx)
    expect(isToolError(out) && out).toMatchObject({
      code: 'TOOL_EXCEPTION',
      message: '发送失败\n[image]',
    })
  })

  it('AC-012 reports an empty tool error with a fixed message', async () => {
    const { prepared } = await prepare(crm, [
      { name: 'x', handler: () => ({ content: [], isError: true }) },
    ])
    expect(await prepared.tools[0]!.execute({}, ctx)).toMatchObject({ message: 'MCP 工具返回错误' })
  })

  it('F21 AC-001 marks a tool error with the class declared for that tool', async () => {
    const { prepared } = await prepare({ ...crm, errorClass: { send: 'deterministic' } })
    const send = prepared.tools.find((t) => t.name === 'crm__send')!
    expect(await send.execute({}, ctx)).toEqual({
      __agent_error: true,
      code: 'TOOL_EXCEPTION',
      message: '发送失败\n[image]',
      errorClass: 'deterministic',
    })
  })

  it('F21 AC-002 lets a tool override the default class', async () => {
    const failing = (name: string): FakeMcpTool => ({
      name,
      handler: () => ({ content: [{ type: 'text', text: `${name} 失败` }], isError: true }),
    })
    const { prepared } = await prepare(
      { ...crm, errorClass: { '*': 'deterministic', send: 'transient' } },
      [failing('send'), failing('x')],
    )
    const [send, x] = prepared.tools
    expect(await send!.execute({}, ctx)).toMatchObject({ errorClass: 'transient' })
    expect(await x!.execute({}, ctx)).toMatchObject({ errorClass: 'deterministic' })
  })

  it('looks up only the keys the spec declares, not inherited object keys', async () => {
    const { prepared } = await prepare({ ...crm, errorClass: { '*': 'deterministic' } }, [
      {
        name: 'constructor',
        handler: () => ({ content: [{ type: 'text', text: '失败' }], isError: true }),
      },
    ])
    expect(await prepared.tools[0]!.execute({}, ctx)).toMatchObject({
      errorClass: 'deterministic',
    })
  })

  it('F21 AC-003 leaves results unchanged without a declared class', async () => {
    const { prepared } = await prepare({ ...crm, errorClass: { other: 'deterministic' } })
    const [lookup, , send] = prepared.tools
    expect(await lookup!.execute({}, ctx)).toBe('客户 A\n等级 VIP')
    const out = await send!.execute({}, ctx)
    expect(out).toEqual({
      __agent_error: true,
      code: 'TOOL_EXCEPTION',
      message: '发送失败\n[image]',
    })
    expect(out).not.toHaveProperty('errorClass')
  })

  it('F22 AC-001 keeps compliant tool names unchanged', async () => {
    const { prepared } = await prepare(crm, [
      { name: 'lookup' },
      { name: 'update-order' },
      { name: 'send_1' },
    ])
    expect(prepared.tools.map((t) => t.name)).toEqual([
      'crm__lookup',
      'crm__update-order',
      'crm__send_1',
    ])
    expect(prepared.snapshot.detail).not.toHaveProperty('renamed')
  })

  it('F22 AC-002 renames a tool with illegal characters and calls it by its original name', async () => {
    const { prepared, fake } = await prepare(crm, [{ name: 'files.read', handler: () => 'ok' }])
    const expected = `crm__files_read_${hashOf('crm__files.read').slice(0, 8)}`
    expect(prepared.tools.map((t) => t.name)).toEqual([expected])
    expect(expected).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(prepared.snapshot.detail).toMatchObject({ renamed: { 'files.read': expected } })
    expect(await prepared.tools[0]!.execute({ path: 'a' }, ctx)).toBe('ok')
    expect(fake.calls).toEqual([{ name: 'files.read', args: { path: 'a' } }])
  })

  it('F22 AC-003 shortens a name longer than 64 characters', async () => {
    const long = 'a'.repeat(70)
    const { prepared, fake } = await prepare(crm, [{ name: long }])
    const name = prepared.tools[0]!.name
    expect(name).toHaveLength(64)
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(name).toMatch(/_[0-9a-f]{8}$/)
    await prepared.tools[0]!.execute({}, ctx)
    expect(fake.calls[0]!.name).toBe(long)
  })

  it('F22 AC-004 gives distinct, stable names and also cleans the server name', async () => {
    const tools: FakeMcpTool[] = [{ name: 'a.b' }, { name: 'a:b' }]
    const first = (await prepare(crm, tools)).prepared.tools.map((t) => t.name)
    const again = (await prepare(crm, tools)).prepared.tools.map((t) => t.name)
    expect(first[0]).not.toBe(first[1])
    expect(again).toEqual(first)
    const dotted = { ...crm, name: 'my.server' }
    const { prepared } = await prepare(dotted, [{ name: 'x' }])
    expect(prepared.tools[0]!.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  it('F22 AC-005 keeps a compliant name and skips the renamed tool it collides with', async () => {
    const clash = `a_b_${hashOf('crm__a.b').slice(0, 8)}`
    const { prepared } = await prepare(crm, [{ name: 'a.b' }, { name: clash }])
    expect(prepared.tools.map((t) => t.name)).toEqual([`crm__${clash}`])
    expect(prepared.snapshot.detail).toMatchObject({ skipped: ['a.b'] })
  })

  it('keeps tools written with draft-07 definitions or conditional schemas', async () => {
    const tools: FakeMcpTool[] = [
      {
        name: 'draft7',
        inputSchema: {
          type: 'object',
          properties: { order: { $ref: '#/definitions/Order' } },
          definitions: { Order: { type: 'string', description: '订单号' } },
        },
      },
      {
        name: 'conditional',
        inputSchema: {
          type: 'object',
          properties: { kind: { type: 'string' }, id: { type: 'string', not: { const: '' } } },
          if: { properties: { kind: { const: 'order' } } },
          then: { required: ['id'] },
          dependentRequired: { kind: ['id'] },
        },
      },
    ]
    const { prepared } = await prepare(crm, tools)
    expect(prepared.tools.map((t) => t.name)).toEqual(['crm__draft7', 'crm__conditional'])
    expect(prepared.tools[0]!.inputSchema).toEqual({
      type: 'object',
      properties: { order: { $ref: '#/$defs/Order' } },
      $defs: { Order: { type: 'string', description: '订单号' } },
    })
    // 条件约束去掉，属性和类型保留给模型。
    expect(prepared.tools[1]!.inputSchema).toEqual({
      type: 'object',
      properties: { kind: { type: 'string' }, id: { type: 'string' } },
    })
    expect(prepared.snapshot.detail).toEqual({
      server: 'crm',
      version: 1,
      relaxed: ['conditional'],
    })
  })

  it('AC-013 skips tools whose schema does not compile', async () => {
    const tools: FakeMcpTool[] = [
      { name: 'weird', inputSchema: { type: 'not-a-type' } },
      { name: 'fine' },
    ]
    const { prepared } = await prepare(crm, tools)
    expect(prepared.tools.map((t) => t.name)).toEqual(['crm__fine'])
    expect(prepared.snapshot.detail).toEqual({ server: 'crm', version: 1, skipped: ['weird'] })
  })

  it('AC-014 fingerprints the tool list and exposes availability and release', async () => {
    const { prepared } = await prepare()
    const again = await prepare()
    expect(prepared.snapshot.fingerprint).toBe(again.prepared.snapshot.fingerprint)
    expect(prepared.snapshot.fingerprint).toBe(
      hashOf(
        TOOLS.map((t) => ({
          name: t.name,
          description: t.description ?? null,
          inputSchema: { type: 'object' },
          annotations: t.annotations ?? null,
        })),
      ),
    )
    expect(prepared.snapshot.detail).toEqual({ server: 'crm', version: 1 })
    const fewer = await prepare(crm, TOOLS.slice(0, 1))
    expect(fewer.prepared.snapshot.fingerprint).not.toBe(prepared.snapshot.fingerprint)
    expect(prepared.available!()).toBe(true)
    prepared.release!()
  })

  it('AC-014 becomes unavailable when the server breaker opens', async () => {
    const tools: FakeMcpTool[] = [
      { name: 'boom', handler: () => Promise.reject(new Error('EPIPE')) },
    ]
    const { prepared } = await prepare(crm, tools, { failureThreshold: 1 })
    await expect(prepared.tools[0]!.execute({}, ctx)).rejects.toThrow('EPIPE')
    expect(prepared.available!()).toBe(false)
  })

  it('fails to prepare when the pool cannot connect', async () => {
    const fake = fakeMcpServer({ tools: [], failConnects: 1 })
    const host = createMcpHost({ connect: fake.connect })
    await expect(mcp(crm).prepare(prepareCtx({ host: <T>() => host as T }))).rejects.toThrow(
      '连接失败',
    )
  })
})
