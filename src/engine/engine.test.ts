import { describe, expect, it, vi } from 'vitest'
import type { CapabilityHost } from '../contracts/capability.js'
import type { LogEntry } from '../contracts/common.js'
import type { Guard, PermissionRule } from '../contracts/component.js'
import type { BreakerStatus, EngineConfig } from '../contracts/engine.js'
import type { EnvironmentConfig } from '../contracts/environment.js'
import { DefinitionError } from '../contracts/errors.js'
import type { RunEvent } from '../contracts/events.js'
import {
  call,
  contextBuilt,
  evaluated,
  modelResponded,
  runStarted,
  sequence,
  stepEnded,
  stepStarted,
  toolFinished,
  toolSnapshot,
} from '../core/log/events.fixture.js'
import { checkInvariants } from '../core/log/invariants.js'
import { engineFingerprint, environmentFingerprint } from '../core/definition/fingerprint.js'
import { memoryArchive } from '../services/memory-archive.js'
import { FakeClock } from '../testing/fake-clock.js'
import { fakeModel, type FakeReply } from '../testing/fake-model.js'
import { fakeTool } from '../testing/fake-tool.js'
import { assembleEngine, type EngineDefaults } from './engine.js'
import { agentOf, defaults, hubOf, passMemory, taskOf } from './engine.fixture.js'

const guard = (id: string): Guard => ({
  id,
  version: '1',
  start: () => ({ check: () => undefined }),
})
const permission = (id: string): PermissionRule => ({
  id,
  version: '1',
  permit: async () => 'allow',
})

function setup(replies: FakeReply[], services: Partial<EngineConfig['services']> = {}) {
  const clock = new FakeClock()
  const model = fakeModel({ model: 'main', clock, replies })
  const hub = hubOf([model.port], { defaultModel: 'fake:main' })
  const logs: LogEntry[] = []
  const engineDefaults: EngineDefaults = {
    ...defaults(),
    memory: passMemory(),
    guards: [guard('roadblock')],
    logger: { log: (e) => logs.push(e) },
  }
  const engine = assembleEngine({ services: { models: hub, clock, ...services } }, engineDefaults)
  return { clock, model, hub, logs, engine, engineDefaults }
}

const environment = (patch: Partial<EnvironmentConfig> = {}): EnvironmentConfig => ({
  name: 'interactive',
  principal: { reachable: true },
  ...patch,
})

const read = async (archive: ReturnType<typeof memoryArchive>, runId: string) => {
  const out: RunEvent[] = []
  for await (const e of archive.read(runId)) out.push(e)
  return out
}

describe('assembleEngine', () => {
  it('AC-023 fingerprints the memory and guards in use', () => {
    const { engine, engineDefaults } = setup([])
    expect(engine.fingerprint).toBe(
      engineFingerprint({
        memory: engineDefaults.memory,
        guards: engineDefaults.guards,
        deliverable: engineDefaults.deliverable,
        exposure: engineDefaults.exposure,
      }),
    )
    const own = assembleEngine(
      { services: { models: hubOf([]) }, guards: [guard('x')] },
      engineDefaults,
    )
    expect(own.fingerprint).not.toBe(engine.fingerprint)
    const none = assembleEngine({ services: { models: hubOf([]) }, guards: [] }, engineDefaults)
    expect(none.fingerprint).not.toBe(engine.fingerprint)
  })

  it('AC-023 runs a task in an environment', async () => {
    const { engine } = setup([{ text: '完成了' }])
    const env = engine.environment(environment())
    const run = env.start(agentOf(), taskOf(), { runId: 'fixed-id' })
    expect(run.runId).toBe('fixed-id')
    expect(await run.result).toMatchObject({ status: 'completed', text: '完成了' })
  })

  it('AC-021 delegates into another environment of the same engine', async () => {
    const archive = memoryArchive()
    const { engine } = setup(
      [{ toolCalls: [{ id: 'd1', name: 'delegate' }] }, { text: 'child' }, { text: 'done' }],
      { archive },
    )
    const strict = engine.environment(
      environment({ name: 'strict', principal: { reachable: false } }),
    )
    const delegate = fakeTool({
      name: 'delegate',
      run: async (_input, ctx) =>
        (
          await ctx.spawn(
            agentOf({ id: 'researcher' }),
            taskOf({ budget: { maxTotalMs: 60_000, finalizeReserveMs: 0 } }),
            { environment: strict },
          )
        ).text,
    })
    const cap = {
      id: 'core',
      version: '1',
      kind: 'tool',
      prepare: async () => ({ tools: [delegate], snapshot: { fingerprint: 'x' } }),
    }
    const run = engine
      .environment(environment())
      .start(agentOf({ id: 'lead', capabilities: [cap] }), taskOf())
    expect(await run.result).toMatchObject({ status: 'completed', text: 'done' })
    const [child] = await archive.query({ parentRunId: run.runId })
    expect(child).toMatchObject({ environment: 'strict' })
    const foreign = fakeTool({
      name: 'delegate',
      run: async (_input, ctx) =>
        ctx.spawn(agentOf({ id: 'researcher' }), taskOf(), {
          environment: { name: 'x', fingerprint: 'y', start: () => undefined as never },
        }),
    })
    const again = setup([{ toolCalls: [{ id: 'd1', name: 'delegate' }] }, { text: 'done' }], {
      archive,
    })
    const cap2 = {
      ...cap,
      prepare: async () => ({ tools: [foreign], snapshot: { fingerprint: 'x' } }),
    }
    const second = again.engine
      .environment(environment())
      .start(agentOf({ id: 'lead', capabilities: [cap2] }), taskOf())
    await second.result
    const finished = (await read(archive, second.runId)).find((e) => e.t === 'tool_finished')
    expect(finished).toMatchObject({ isError: true, errorCode: 'TOOL_EXCEPTION' })
  })

  it('AC-024 validates environments and engines', () => {
    const { engine } = setup([])
    const bad = () =>
      engine.environment(
        environment({
          name: '',
          permissions: [permission('p'), permission('p')],
          caps: { toolConcurrency: 0, delegation: { depth: 1.5 } },
        }),
      )
    expect(bad).toThrow(DefinitionError)
    try {
      bad()
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_environment',
        issues: [
          'name 必须是非空字符串',
          '权限规则 id 重复：p',
          'caps.toolConcurrency 必须是正整数',
          'caps.delegation.depth 必须是正整数',
        ],
      })
    }
    const config = environment({ permissions: [permission('p')] })
    const env = engine.environment(config)
    expect(env.fingerprint).toBe(environmentFingerprint(config))
    expect(engine.environment(config).fingerprint).toBe(env.fingerprint)

    expect(() =>
      assembleEngine(
        {
          services: {
            models: hubOf([]),
            hosts: [{ kind: 'mcp' }, { kind: 'mcp' }],
          },
          guards: [guard('a'), guard('a')],
        },
        setup([]).engineDefaults,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'invalid_engine',
        issues: ['守卫 id 重复：a', '能力宿主重复：mcp'],
      }),
    )
  })

  it('AC-024 validates the other environment fields', () => {
    const { engine } = setup([])
    const g = guard('r')
    const check = {
      id: 'c',
      version: '1',
      mode: 'gate' as const,
      start: () => ({ accept: async () => ({ pass: true as const }) }),
    }
    const provider = { id: 'n', version: '1', provide: async () => [] }
    expect(() =>
      engine.environment(
        environment({
          guards: [g, g],
          checks: [check, check],
          notice: [provider, provider],
          caps: { approvalTimeoutMs: -1, budget: { maxSteps: 0 } },
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        issues: [
          '守卫 id 重复：r',
          '强制验收 id 重复：c',
          '须知生成器 id 重复：n',
          'caps.approvalTimeoutMs 必须是正数',
          'caps.budget.maxSteps 必须是正数',
        ],
      }),
    )
  })

  it('AC-025 queues runs over the environment limit', async () => {
    const { engine, clock } = setup([{ delayMs: 1000, text: 'one' }, { text: 'two' }])
    const env = engine.environment(environment({ caps: { maxConcurrentRuns: 1 } }))
    const first = env.start(agentOf(), taskOf())
    const second = env.start(agentOf(), taskOf())
    await vi.waitFor(() => expect(engine.health().admission).toEqual({ running: 1, queued: 1 }))
    await clock.tick(1000)
    expect(await first.result).toMatchObject({ text: 'one' })
    expect(await second.result).toMatchObject({ text: 'two' })
  })

  it('AC-025 records the queue time and fails on admission timeout', async () => {
    const archive = memoryArchive()
    const { engine, clock } = setup([{ hang: true }, { text: 'two' }], {
      archive,
      admission: { maxConcurrentRuns: 1, queueTimeoutMs: 500 },
    })
    const env = engine.environment(environment())
    const first = env.start(agentOf(), taskOf())
    const second = env.start(agentOf(), taskOf())
    await vi.waitFor(() => expect(engine.health().admission.queued).toBe(1))
    await clock.tick(500)
    expect(await second.result).toMatchObject({
      status: 'failed',
      code: 'admission_timeout',
      error: { retryable: true },
    })
    first.abort()
    await first.result
    const third = env.start(agentOf(), taskOf())
    await third.result
    const started = (await read(archive, third.runId)).find((e) => e.t === 'run_started')
    expect(started).toMatchObject({ queuedMs: 0 })
  })

  it('AC-026 reports health and forwards breaker changes', () => {
    const { engine, hub } = setup([])
    const open: BreakerStatus = { key: 'fake:main', dependency: 'model', state: 'open', since: 1 }
    hub.breakers = [open]
    expect(engine.health()).toEqual({ breakers: [open], admission: { running: 0, queued: 0 } })
    const seen: unknown[] = []
    const off = engine.onHealth((h) => seen.push(h))
    hub.emitHealth()
    expect(seen).toEqual([{ breakers: [open], admission: { running: 0, queued: 0 } }])
    off()
    hub.emitHealth()
    expect(seen).toHaveLength(1)
  })

  it('AC-020 merges host breakers into health and forwards their changes', () => {
    const mcpOpen: BreakerStatus = { key: 'mcp:crm', dependency: 'mcp', state: 'open', since: 2 }
    const listeners = new Set<(s: BreakerStatus) => void>()
    const host: CapabilityHost = {
      kind: 'mcp',
      health: () => [mcpOpen],
      onHealth(fn) {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    }
    const { engine } = setup([], { hosts: [host, { kind: 'plain' }] })
    expect(engine.health().breakers).toEqual([mcpOpen])
    const seen: unknown[] = []
    const off = engine.onHealth((h) => seen.push(h))
    for (const fn of listeners) fn(mcpOpen)
    expect(seen).toEqual([{ breakers: [mcpOpen], admission: { running: 0, queued: 0 } }])
    off()
    expect(listeners.size).toBe(0)
  })

  it('AC-027 shuts down running runs and hosts, then refuses new runs', async () => {
    const host: CapabilityHost & { closed: number } = {
      kind: 'mcp',
      closed: 0,
      async shutdown() {
        host.closed += 1
      },
    }
    const archive = memoryArchive()
    const { engine, model } = setup([{ hang: true }], { hosts: [host], archive })
    const env = engine.environment(environment())
    const run = env.start(agentOf(), taskOf())
    await vi.waitFor(() => expect(model.inputs).toHaveLength(1))
    await engine.shutdown()
    expect(await run.result).toMatchObject({ status: 'aborted', code: 'interrupted' })
    expect(host.closed).toBe(1)
    const late = env.start(agentOf(), taskOf())
    expect(await late.result).toMatchObject({
      status: 'failed',
      code: 'engine_error',
      error: { message: '引擎已关闭' },
    })
    expect((await read(archive, late.runId)).map((e) => e.t)).toEqual(['run_ended'])
  })

  it('AC-028 closes runs interrupted by a previous process', async () => {
    const archive = memoryArchive()
    const tools = [
      {
        capability: 'tools',
        kind: 'tool',
        version: '1',
        fingerprint: 'fp',
        tools: [toolSnapshot('search', { effect: 'side_effect' })],
      },
    ]
    await archive.append(
      'old-run',
      sequence([
        runStarted({ rootRunId: 'old-run', capabilities: tools }),
        stepStarted(1),
        contextBuilt(1),
        modelResponded(1, {
          toolCalls: [call('c1')],
          usage: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0 },
        }),
      ]),
    )
    const { engine } = setup([], { archive })
    const summaries = await engine.interrupted()
    expect(summaries).toEqual([
      expect.objectContaining({
        runId: 'old-run',
        status: 'aborted',
        code: 'interrupted',
        steps: 1,
      }),
    ])
    const events = await read(archive, 'old-run')
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({
        t: 'tool_finished',
        callId: 'c1',
        capability: 'tools',
        effect: 'side_effect',
        isError: true,
        errorCode: 'TOOL_INTERRUPTED',
        seq: 5,
      }),
      expect.objectContaining({
        t: 'run_ended',
        seq: 6,
        result: expect.objectContaining({ status: 'aborted', code: 'interrupted', toolCalls: 1 }),
      }),
    ])
    expect(await archive.getBlob((events[4] as { shown: string }).shown)).toContain(
      'TOOL_INTERRUPTED',
    )
    expect(
      await assembleEngine(
        { services: { models: hubOf([]), archive } },
        setup([]).engineDefaults,
      ).interrupted(),
    ).toEqual([])
  })

  it('AC-028 closes the last step even when the provider reused a call id from an earlier step', async () => {
    const archive = memoryArchive()
    await archive.append(
      'reused',
      sequence([
        runStarted({ rootRunId: 'reused' }),
        stepStarted(1),
        contextBuilt(1),
        modelResponded(1, { toolCalls: [call('call_0')] }),
        toolFinished('call_0'),
        evaluated(1, { continue: { interventions: [] }, sources: ['default'] }),
        stepEnded(1),
        stepStarted(2),
        contextBuilt(2),
        modelResponded(2, { toolCalls: [call('call_0')] }),
      ]),
    )
    const { engine } = setup([], { archive })
    await engine.interrupted()
    const events = await read(archive, 'reused')
    expect(events.filter((e) => e.t === 'tool_finished').map((e) => e.errorCode)).toEqual([
      undefined,
      'TOOL_INTERRUPTED',
    ])
    expect(checkInvariants(events)).toEqual([])
  })

  it('AC-028 logs and returns nothing when recovery fails', async () => {
    const archive = memoryArchive()
    archive.query = async () => {
      throw new Error('locked')
    }
    const { engine, logs } = setup([], { archive })
    expect(await engine.interrupted()).toEqual([])
    expect(logs.map((l) => l.message)).toContain('补齐中断运行失败')
  })
})
