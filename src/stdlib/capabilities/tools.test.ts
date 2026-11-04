import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineAgent } from '../../sdk.js'
import type { Capability } from '../../contracts/capability.js'
import type { ToolDef } from '../../contracts/tool.js'
import { fakeTool } from '../../testing/fake-tool.js'
import { prepareCtx } from './prepare.fixture.js'
import { bundle, tool, toolDefinitionsHash, tools, toolsFingerprint } from './tools.js'

const search = fakeTool({
  name: 'search',
  description: 'search the web',
  inputSchema: z.object({ q: z.string() }),
})
const fetchTool = fakeTool({ name: 'fetch', description: 'fetch a page' })
const instructions = [
  { role: 'system' as const, parts: [{ type: 'text' as const, text: '你是助手' }] },
]

describe('tool and tools', () => {
  it('AC-001 wraps a single tool', async () => {
    const cap = tool(search)
    expect(cap).toMatchObject({ id: 'tool:search', version: '1', kind: 'tool' })
    const prepared = await cap.prepare(prepareCtx())
    expect(prepared.tools).toEqual([search])
    expect(prepared.exposure).toBe('eager')
    expect(prepared.snapshot.fingerprint).toBe(toolsFingerprint([search]))
  })

  it('AC-001 groups tools with a description and a stable fingerprint', async () => {
    const description = [
      { role: 'system' as const, parts: [{ type: 'text' as const, text: 'web tools' }] },
    ]
    const cap = tools([search, fetchTool], { description })
    expect(cap.id).toBe('tools:search+fetch')
    const prepared = await cap.prepare(prepareCtx())
    expect(prepared.tools.map((t) => t.name)).toEqual(['search', 'fetch'])
    expect(prepared.description).toBe(description)
    expect(toolsFingerprint([search, fetchTool])).toBe(toolsFingerprint([search, fetchTool]))
    const renamed = { ...fetchTool, description: 'fetch a web page' }
    expect(toolsFingerprint([search, renamed])).not.toBe(toolsFingerprint([search, fetchTool]))
  })

  it('honours an explicit id and a deferred exposure', async () => {
    const cap = tools([fetchTool], { id: 'web', exposure: 'deferred' })
    expect(cap.id).toBe('web')
    expect(cap.config).toEqual({
      tools: ['fetch'],
      exposure: 'deferred',
      definitions: toolDefinitionsHash([fetchTool]),
    })
    expect((await cap.prepare(prepareCtx())).exposure).toBe('deferred')
    expect((await tool(fetchTool, { exposure: 'deferred' }).prepare(prepareCtx())).exposure).toBe(
      'deferred',
    )
  })
})

describe('agent fingerprint and tool definitions', () => {
  const base: ToolDef = {
    name: 'q',
    description: 'find records',
    inputSchema: z.object({ s: z.string() }),
    execution: { effect: 'none' },
    execute: async () => '',
  }
  const fingerprintOf = (def: ToolDef) =>
    defineAgent({ id: 'a', instructions, capabilities: [tools([def])] }).fingerprint

  it('F19 AC-012 changes when any part of a tool definition changes', () => {
    const variants: ToolDef[] = [
      { ...base, description: 'DELETE records' },
      { ...base, inputSchema: z.object({ s: z.number() }) },
      { ...base, execution: { effect: 'side_effect' } },
      { ...base, safety: { risk: 'high' } },
      { ...base, execution: { effect: 'none', timeoutMs: 5_000 } },
      { ...base, semantics: { repeatable: true } },
      { ...base, safety: { access: () => ({ read: [] }) } },
    ]
    const prints = new Set([fingerprintOf(base), ...variants.map(fingerprintOf)])
    expect(prints.size).toBe(variants.length + 1)
  })

  it('keeps its own copy of the definitions, so later pushes change neither tools nor hash', async () => {
    const defs: ToolDef[] = [base]
    const cap = tools(defs)
    const config = structuredClone(cap.config)
    defs.push({ ...base, name: 'extra' })
    expect(cap.config).toEqual(config)
    expect((await cap.prepare(prepareCtx())).tools.map((t) => t.name)).toEqual(['q'])
  })

  it('names the tool whose zod schema cannot become JSON Schema', () => {
    const dated: ToolDef = { ...base, name: 'when', inputSchema: z.object({ at: z.date() }) }
    expect(() => tools([base, dated])).toThrow(/^工具 when 的 schema 不能转成 JSON Schema：/)
  })

  it('F19 AC-012 stays the same for the same definitions', () => {
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base }))
    const definitions = (cap: Capability) => (cap.config as { definitions: string }).definitions
    expect(definitions(tool(base))).toMatch(/^[0-9a-f]{64}$/)
    expect(definitions(tool(base))).toBe(definitions(tools([{ ...base }])))
  })
})

describe('bundle', () => {
  const releases: string[] = []
  const capability = (
    id: string,
    opts: { fail?: boolean; exposure?: 'eager' | 'deferred' } = {},
  ): Capability => ({
    id,
    version: '1',
    kind: 'custom',
    prepare: async () => {
      if (opts.fail) throw new Error(`${id} unavailable`)
      return {
        tools: [fakeTool({ name: `${id}-tool` })],
        description: [{ role: 'system', parts: [{ type: 'text', text: `${id} notes` }] }],
        guards: [{ id: `${id}-guard`, version: '1', start: () => ({ check: () => undefined }) }],
        exposure: opts.exposure ?? 'eager',
        snapshot: { fingerprint: `${id}-fp` },
        release: () => releases.push(id),
      }
    },
  })

  it('AC-002 AC-033 merges tools, descriptions and guards and releases every part', async () => {
    releases.length = 0
    const cap = bundle({ id: 'research', capabilities: [capability('a'), capability('b')] })
    expect(cap).toMatchObject({ id: 'research', version: '1', kind: 'bundle' })
    const prepared = await cap.prepare(prepareCtx())
    expect(prepared.tools.map((t) => t.name)).toEqual(['a-tool', 'b-tool'])
    expect(prepared.description?.map((s) => (s.parts[0] as { text: string }).text)).toEqual([
      'a notes',
      'b notes',
    ])
    expect(prepared.guards?.map((g) => g.id)).toEqual(['a-guard', 'b-guard'])
    expect(prepared.exposure).toBe('eager')
    expect(prepared.snapshot.detail).toEqual({ parts: ['a', 'b'] })
    prepared.release?.()
    expect(releases).toEqual(['a', 'b'])
  })

  it('is deferred only when every part is deferred', async () => {
    const cap = bundle({
      id: 'quiet',
      capabilities: [
        capability('a', { exposure: 'deferred' }),
        capability('b', { exposure: 'deferred' }),
      ],
    })
    expect((await cap.prepare(prepareCtx())).exposure).toBe('deferred')
  })

  it('keeps the exposure of each part when parts mix', async () => {
    const cap = bundle({
      id: 'mixed',
      capabilities: [
        capability('a', { exposure: 'eager' }),
        capability('b', { exposure: 'deferred' }),
      ],
    })
    const prepared = await cap.prepare(prepareCtx())
    expect(prepared.exposure).toBe('eager')
    expect(prepared.toolExposure).toEqual({ 'a-tool': 'eager', 'b-tool': 'deferred' })
  })

  it('keeps each part available on its own', async () => {
    let up = false
    const remote = fakeTool({ name: 'remote', result: 'remote ok' })
    const local = fakeTool({ name: 'local', result: 'local ok' })
    const flaky: Capability = {
      id: 'flaky',
      version: '1',
      kind: 'mcp',
      prepare: async () => ({
        tools: [remote],
        exposure: 'deferred',
        snapshot: { fingerprint: 'f' },
        available: () => up,
      }),
    }
    const prepared = await bundle({
      id: 'mixed',
      capabilities: [flaky, tool(local)],
    }).prepare(prepareCtx())
    // 能力包整体始终可用，不可用只落在所属部分的工具上。
    expect(prepared.available).toBeUndefined()
    const [wrapped, plain] = prepared.tools
    expect(plain).toBe(local)
    const toolCtx = {} as Parameters<typeof remote.execute>[1]
    expect(await wrapped!.execute({}, toolCtx)).toMatchObject({
      __agent_error: true,
      code: 'TOOL_UNAVAILABLE',
    })
    expect(remote.calls).toHaveLength(0)
    expect(await plain!.execute({}, toolCtx)).toBe('local ok')
    up = true
    expect(await wrapped!.execute({}, toolCtx)).toBe('remote ok')
    expect(wrapped).toMatchObject({ name: 'remote', description: remote.description })
    // 契约只有能力级的呈现方式：混合时取 eager，不把 eager 的工具藏起来。
    expect(prepared.exposure).toBe('eager')
  })

  it('AC-003 fails as a whole and releases the parts already prepared', async () => {
    releases.length = 0
    const cap = bundle({
      id: 'broken',
      capabilities: [capability('a'), capability('b', { fail: true })],
    })
    await expect(cap.prepare(prepareCtx())).rejects.toThrow('b unavailable')
    expect(releases).toEqual(['a'])
  })
})
