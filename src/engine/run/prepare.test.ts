import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Capability, Prepared } from '../../contracts/capability.js'
import type {
  ComponentCtx,
  Exposure,
  Guard,
  NoticeProvider,
  OutputContract,
  RunInfo,
} from '../../contracts/component.js'
import { isToolError } from '../../contracts/errors.js'
import type { ToolCtx, ToolDef } from '../../contracts/tool.js'
import { hashOf } from '../../core/definition/hash.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { prepareRun, type PrepareInput } from './prepare.js'
import { allExposure, textOutput } from '../engine.fixture.js'

const def = (name: string, patch: Partial<ToolDef> = {}): ToolDef => ({
  name,
  description: `tool ${name}`,
  inputSchema: z.object({ q: z.string().optional() }),
  execute: async () => 'ok',
  ...patch,
  execution: patch.execution ?? { effect: 'side_effect' },
})

const cap = (id: string, prepared: Partial<Prepared> | (() => Promise<Prepared>)): Capability => ({
  id,
  version: '1',
  kind: 'tool',
  prepare:
    typeof prepared === 'function'
      ? prepared
      : async () => ({ tools: [], snapshot: { fingerprint: `fp-${id}` }, ...prepared }),
})

const runInfo = (principalReachable = true): RunInfo => ({
  runId: 'r1',
  rootRunId: 'r1',
  environment: { name: 'test', principalReachable },
  agent: { id: 'helper' },
  task: {},
  model: { ref: 'fake:model', contextLimit: 100_000 },
})

const toolsHash = (tools: ReadonlyArray<{ name: string; schemaHash: string }>) =>
  hashOf(tools.map((t) => ({ name: t.name, schemaHash: t.schemaHash })))

const guard: Guard = { id: 'progress', version: '1', start: () => ({ check: () => undefined }) }

function setup(patch: Partial<PrepareInput> = {}) {
  const clock = new FakeClock()
  const logs: string[] = []
  const sources: string[] = []
  const blobs = new Map<string, string>()
  const prepareInput: PrepareInput = {
    run: runInfo(),
    capabilities: [],
    output: textOutput(),
    exposure: allExposure(),
    host: () => {
      throw new Error('no host')
    },
    vault: { resolve: async () => 'secret' },
    clock,
    signal: new AbortController().signal,
    notice: [],
    history: [],
    ctxFor: (source) => {
      sources.push(source)
      return {} as ComponentCtx
    },
    putBlob: async (data) => {
      const ref = `sha256:${hashOf(data)}`
      blobs.set(ref, data)
      return ref
    },
    log: (_level, message) => logs.push(message),
    ...patch,
  }
  return { clock, logs, sources, blobs, prepareInput }
}

const submit = def('submit', { semantics: { intent: { kind: 'complete', code: 'submit' } } })
const structured: OutputContract = {
  ...textOutput(),
  id: 'json',
  kind: 'structured',
  tools: [submit],
}
const search = def('search_tool', { execution: { effect: 'none' } })
const searchExposure: Exposure = { ...allExposure(), id: 'search', tools: [search] }

describe('prepareRun', () => {
  it('honours per-tool exposure over the capability default', async () => {
    const { prepareInput } = setup({
      capabilities: [
        cap('mixed', {
          tools: [def('a'), def('b')],
          exposure: 'eager',
          toolExposure: { b: 'deferred' },
        }),
      ],
    })
    const r = await prepareRun(prepareInput)
    expect(r.ok && Object.fromEntries(r.prepared.exposureOf)).toMatchObject({
      a: 'eager',
      b: 'deferred',
    })
  })

  it('AC-005 merges capability, output and exposure tools into a frozen toolset', async () => {
    const finish = def('finish', {
      execution: { effect: 'none' },
      semantics: { intent: { kind: 'complete', code: 'finish' }, repeatable: true },
    })
    const { prepareInput } = setup({
      capabilities: [
        cap('core', {
          tools: [def('a'), def('b')],
          description: [{ role: 'system', parts: [{ type: 'text', text: 'core notes' }] }],
        }),
        cap('crm', {
          tools: [finish],
          exposure: 'deferred',
          guards: [guard],
          description: [{ role: 'system', parts: [{ type: 'text', text: 'crm notes' }] }],
          snapshot: { fingerprint: 'fp-crm', detail: { server: 'crm' } },
        }),
      ],
      output: structured,
      exposure: searchExposure,
    })
    const r = await prepareRun(prepareInput)
    if (!r.ok) throw new Error(r.message)
    const p = r.prepared
    expect([...p.toolset.keys()]).toEqual(['a', 'b', 'finish', 'submit', 'search_tool'])
    expect(p.toolset.get('submit')!.invalidInputCode).toBe('OUTPUT_INVALID')
    expect(p.toolset.get('a')!.invalidInputCode).toBe('INVALID_INPUT')
    expect(p.toolset.get('submit')!.capability).toBe('output:json')
    expect(Object.fromEntries(p.exposureOf)).toEqual({
      a: 'eager',
      b: 'eager',
      finish: 'deferred',
      submit: 'eager',
      search_tool: 'eager',
    })
    expect(p.snapshots.map((s) => [s.capability, s.kind, s.fingerprint])).toEqual([
      ['core', 'tool', 'fp-core'],
      ['crm', 'tool', 'fp-crm'],
      ['output:json', 'output', toolsHash(p.snapshots[2]!.tools)],
      ['exposure:search', 'exposure', toolsHash(p.snapshots[3]!.tools)],
    ])
    expect(p.snapshots[1]).toMatchObject({
      detail: { server: 'crm' },
      tools: [
        {
          name: 'finish',
          schemaHash: hashOf(p.toolset.get('finish')!.jsonSchema),
          intent: { kind: 'complete', code: 'finish' },
          effect: 'none',
          repeatable: true,
        },
      ],
    })
    expect(p.snapshots[0]!.tools[0]).toEqual({
      name: 'a',
      schemaHash: hashOf(p.toolset.get('a')!.jsonSchema),
      effect: 'side_effect',
    })
    expect(p.descriptions.map((s) => s.parts[0])).toEqual([
      { type: 'text', text: 'core notes' },
      { type: 'text', text: 'crm notes' },
    ])
    expect(p.guards).toEqual([guard])
    expect(p.unavailable).toEqual([])
  })

  it('AC-006 leaves out capabilities that fail or time out', async () => {
    const { prepareInput, clock } = setup({
      capabilities: [
        cap('broken', async () => {
          throw new Error('connection refused')
        }),
        cap('slow', () => new Promise<Prepared>(() => {})),
        cap('ok', { tools: [def('a')] }),
      ],
    })
    const pending = prepareRun(prepareInput)
    await clock.tick(30_000)
    const r = await pending
    if (!r.ok) throw new Error(r.message)
    expect(r.prepared.unavailable).toEqual([
      { capability: 'broken', reason: 'connection refused' },
      { capability: 'slow', reason: '准备超时' },
    ])
    expect([...r.prepared.toolset.keys()]).toEqual(['a'])
  })

  it('releases a capability that finishes preparing after its timeout', async () => {
    const release = vi.fn()
    let finish!: (p: Prepared) => void
    const { prepareInput, clock } = setup({
      capabilities: [cap('late', () => new Promise<Prepared>((resolve) => (finish = resolve)))],
    })
    const pending = prepareRun(prepareInput)
    await clock.tick(30_000)
    expect((await pending).ok).toBe(true)
    finish({ tools: [], snapshot: { fingerprint: 'x' }, release })
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
  })

  it('wires a capability availability check into each of its tools', async () => {
    let up = true
    const { prepareInput } = setup({
      capabilities: [cap('remote', { tools: [def('a'), def('b')], available: () => up })],
    })
    const r = await prepareRun(prepareInput)
    if (!r.ok) throw new Error(r.message)
    expect(r.prepared.toolset.get('a')!.available!()).toBe(true)
    up = false
    expect(r.prepared.toolset.get('b')!.available!()).toBe(false)
  })

  it('AC-011 passes the task history to prepare, read only', async () => {
    let seen: Parameters<Capability['prepare']>[0] | undefined
    const history = [{ role: 'user' as const, content: 'earlier' }]
    const { prepareInput } = setup({
      history,
      capabilities: [
        cap('probe', async (...args: unknown[]) => {
          seen = args[0] as Parameters<Capability['prepare']>[0]
          return { tools: [], snapshot: { fingerprint: 'x' } }
        }),
      ],
    })
    await prepareRun(prepareInput)
    expect(seen?.history).toEqual(history)
  })

  it('passes run, deadline, host and vault to prepare', async () => {
    let seen: Parameters<Capability['prepare']>[0] | undefined
    const { prepareInput, clock } = setup({
      capabilities: [
        cap('probe', async (...args: unknown[]) => {
          seen = args[0] as Parameters<Capability['prepare']>[0]
          return { tools: [], snapshot: { fingerprint: 'x' } }
        }),
      ],
    })
    await clock.tick(5)
    await prepareRun(prepareInput)
    expect(seen?.run.runId).toBe('r1')
    expect(seen?.deadline).toBe(clock.now() + 30_000)
    expect(await seen?.vault.resolve({ secret: 'k' })).toBe('secret')
    expect(() => seen?.host('mcp')).toThrow('no host')
  })

  it('AC-007 fails on conflicting tool names and releases what was prepared', async () => {
    const release = vi.fn()
    const { prepareInput } = setup({
      capabilities: [cap('one', { tools: [def('a')], release }), cap('two', { tools: [def('a')] })],
    })
    expect(await prepareRun(prepareInput)).toEqual({
      ok: false,
      code: 'invalid_agent',
      message: '工具名冲突：a',
    })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('AC-007 releases capabilities listed after the one that fails', async () => {
    const first = vi.fn()
    const last = vi.fn()
    const { prepareInput } = setup({
      capabilities: [
        cap('one', { tools: [def('a')], release: first }),
        cap('two', { tools: [def('a')] }),
        cap('three', { tools: [def('c')], release: last }),
      ],
    })
    expect(await prepareRun(prepareInput)).toMatchObject({ ok: false, code: 'invalid_agent' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(last).toHaveBeenCalledTimes(1)
  })

  it('AC-033 rejects two capability guards with the same id, but shares one guard object', async () => {
    const other: Guard = { ...guard }
    const clash = setup({
      capabilities: [cap('one', { guards: [guard] }), cap('two', { guards: [other] })],
    })
    expect(await prepareRun(clash.prepareInput)).toEqual({
      ok: false,
      code: 'invalid_agent',
      message: '守卫 id 重复：progress',
    })
    const shared = setup({
      capabilities: [cap('one', { guards: [guard] }), cap('two', { guards: [guard] })],
    })
    const r = await prepareRun(shared.prepareInput)
    expect(r.ok && r.prepared.guards).toEqual([guard])
  })

  it('AC-007 merges a tool object shared by several capabilities', async () => {
    const shared = def('activate_skill')
    const { prepareInput } = setup({
      capabilities: [cap('s1', { tools: [shared] }), cap('s2', { tools: [shared] })],
    })
    const r = await prepareRun(prepareInput)
    expect(r.ok && [...r.prepared.toolset.keys()]).toEqual(['activate_skill'])
    expect(r.ok && r.prepared.snapshots.map((s) => s.tools.length)).toEqual([1, 0])
  })

  it('fails when a tool schema does not compile', async () => {
    const bad = def('bad', { inputSchema: { type: 'not-a-type' } })
    const { prepareInput } = setup({ capabilities: [cap('x', { tools: [bad] })] })
    const r = await prepareRun(prepareInput)
    expect(r).toMatchObject({ ok: false, code: 'invalid_agent' })
  })

  it('AC-008 excludes tools that wait for the principal when unreachable', async () => {
    const ask = def('ask_user', {
      semantics: { intent: { kind: 'await_input', code: 'ask_user' } },
    })
    const capabilities = [cap('intents', { tools: [ask, def('finish')] })]
    const reachable = await prepareRun(setup({ capabilities }).prepareInput)
    expect(reachable.ok && [...reachable.prepared.toolset.keys()]).toEqual(['ask_user', 'finish'])
    const away = await prepareRun(setup({ capabilities, run: runInfo(false) }).prepareInput)
    expect(away.ok && [...away.prepared.toolset.keys()]).toEqual(['finish'])
    expect(away.ok && away.prepared.snapshots[0]!.tools.map((t) => t.name)).toEqual(['finish'])
  })

  it('AC-009 checks that proposed actions use tools of this run', async () => {
    const ownValidate = vi.fn((input: unknown) =>
      (input as { summary?: string }).summary === 'bad'
        ? { error: { __agent_error: true as const, code: 'INVALID_INPUT', message: 'own' } }
        : { ok: true as const },
    )
    const propose = def('propose', {
      semantics: { intent: { kind: 'await_input', code: 'propose' } },
      validate: ownValidate,
    })
    const { prepareInput } = setup({
      capabilities: [cap('intents', { tools: [propose, def('a')] })],
    })
    const r = await prepareRun(prepareInput)
    if (!r.ok) throw new Error(r.message)
    const validate = r.prepared.toolset.get('propose')!.def.validate!
    const ctx = {} as ToolCtx
    expect(validate({ summary: 's', actions: [{ tool: 'a', input: {} }] }, ctx)).toEqual({
      ok: true,
    })
    const missing = validate({ summary: 's', actions: [{ tool: 'rm', input: {} }] }, ctx)
    expect('error' in missing && isToolError(missing.error) && missing.error).toMatchObject({
      code: 'INVALID_INPUT',
      message: '动作里的工具不在本次运行的工具集中：rm',
    })
    expect(validate({ summary: 'bad' }, ctx)).toMatchObject({ error: { message: 'own' } })
    expect(propose.validate).toBe(ownValidate)
  })

  it('AC-010 records dynamic notice before run_started and skips failing providers', async () => {
    const segments = [
      { role: 'system' as const, parts: [{ type: 'text' as const, text: '今日规定' }] },
    ]
    const good: NoticeProvider = { id: 'daily', version: '1', provide: async () => segments }
    const bad: NoticeProvider = {
      id: 'broken',
      version: '1',
      provide: async () => {
        throw new Error('boom')
      },
    }
    const staticNotice = {
      role: 'system' as const,
      parts: [{ type: 'text' as const, text: '准则' }],
    }
    const { prepareInput, logs, sources, blobs } = setup({ notice: [staticNotice, good, bad] })
    const r = await prepareRun(prepareInput)
    if (!r.ok) throw new Error(r.message)
    expect(r.prepared.notice).toEqual([staticNotice])
    expect(r.prepared.noticeEvents).toEqual([
      expect.objectContaining({ t: 'external_call', source: 'notice:daily', kind: 'record' }),
    ])
    const event = r.prepared.noticeEvents[0] as { response: string; request: string }
    expect(JSON.parse(blobs.get(event.response)!)).toEqual(segments)
    expect(JSON.parse(blobs.get(event.request)!)).toEqual({ provider: 'daily' })
    expect(sources).toEqual(['provider:daily', 'provider:broken'])
    expect(logs).toEqual(['须知 broken 生成失败'])
  })

  it('§9.10 stops at a notice provider that blocks and releases what was prepared', async () => {
    const release = vi.fn()
    const later = vi.fn(async () => [])
    const block: NoticeProvider = {
      id: 'prompt-hook',
      version: '1',
      provide: async () => ({ block: '包含敏感信息' }),
    }
    const after: NoticeProvider = { id: 'after', version: '1', provide: later }
    const { prepareInput } = setup({
      capabilities: [cap('one', { tools: [def('a')], release })],
      notice: [block, after],
    })
    expect(await prepareRun(prepareInput)).toEqual({
      ok: false,
      code: 'notice_blocked',
      message: '包含敏感信息',
    })
    expect(release).toHaveBeenCalledTimes(1)
    expect(later).not.toHaveBeenCalled()
  })
})
