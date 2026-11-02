// 不变量属性测试（设计 §13、方案 D8）：固定种子生成随机场景——并发工具、失败与超时、引导、取消、压缩、
// 守卫告知与封路、子运行、熔断、交付退回、模型故障注入——每次运行（含子运行）都必须结束，日志满足 I1–I16，
// 严格重放没有违规。

import { describe, expect, it } from 'vitest'
import {
  FakeClock,
  chaos,
  checkInvariants,
  compactingMemory,
  createEngine,
  defineAgent,
  defineTask,
  fakeModel,
  fakeTool,
  inputHash,
  memoryArchive,
  modelHub,
  seededRandom,
  strictReplay,
  subagent,
  tools,
  type Check,
  type FakeReply,
  type Guard,
  type ModelInput,
  type RunEvent,
} from './index.js'

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1)
const MAX_TICKS = 400
const CHILD_TICKS = 50
const LONG = '数据'.repeat(800)
const TOOL_NAMES = ['ok', 'fail', 'slow', 'write', 'delegate'] as const

function scenario(seed: number) {
  const random = seededRandom(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!
  const clock = new FakeClock()

  const script: FakeReply[] = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, i) => {
    const r = random()
    if (r < 0.15) return { text: `结论 ${i}` }
    if (r < 0.3) return { error: { code: 'MODEL_ERROR', status: 503, retryable: true } }
    if (r < 0.4) return { hang: true }
    const n = 1 + Math.floor(random() * 3)
    return {
      toolCalls: Array.from({ length: n }, () => {
        const name = pick(TOOL_NAMES)
        return name === 'delegate'
          ? { name, input: { agent: 'researcher', task: '查资料' } }
          : { name, input: { q: Math.floor(random() * 3) } }
      }),
    }
  })

  let mainCalls = 0
  const reply = (input: ModelInput): FakeReply => {
    if (input.tools.length === 0) return { text: '摘要：进展正常' }
    if (JSON.stringify(input.messages[0]).includes('你负责查资料')) {
      return input.messages.at(-1)?.role === 'tool'
        ? { text: '子任务结果' }
        : { toolCalls: [{ name: 'ok', input: { q: 'child' } }] }
    }
    return script[mainCalls++] ?? { text: '完成' }
  }
  const model = fakeModel({
    model: 'main',
    clock,
    capabilities: { contextLimit: 6000 },
    replies: [reply],
    repeatLast: true,
  })
  const injected = random() < 0.3 ? chaos({ seed, rate: 0.2, faults: ['model_5xx'] }) : undefined
  const archive = memoryArchive()
  const engine = createEngine({
    services: {
      models: modelHub({
        providers: [injected ? injected.provider(model) : model],
        default: model.ref,
        clock,
      }),
      archive,
      clock,
      logger: { log: () => {} },
    },
    // 默认保留最近 4 组工具交换；场景最多 8 步，只保留 1 组才有可压的内容。
    memory: compactingMemory({ trigger: 0.5, anchors: 1 }),
  })

  const ok = fakeTool({ name: 'ok', result: LONG })
  const fail = fakeTool({
    name: 'fail',
    run: () => {
      throw new Error('失败')
    },
  })
  const slow = fakeTool({ name: 'slow', delayMs: 1500, clock, result: '慢结果' })
  const write = fakeTool({ name: 'write', effect: 'side_effect', result: '已写入' })
  const researcher = defineAgent({
    id: 'researcher',
    instructions: [{ role: 'system', parts: [{ type: 'text', text: '你负责查资料' }] }],
    capabilities: [tools([fakeTool({ name: 'ok', result: '资料' })])],
  })
  const lead = defineAgent({
    id: 'lead',
    instructions: [{ role: 'system', parts: [{ type: 'text', text: '你是负责人' }] }],
    capabilities: [
      tools([ok, fail, slow, write]),
      subagent(researcher, { budget: { maxTotalMs: 60_000 } }),
    ],
  })

  let rejected = false
  const gate: Check = {
    id: 'gate',
    version: '1',
    mode: 'gate',
    start: () => ({
      accept: async () => {
        if (rejected) return { pass: true }
        rejected = true
        return { pass: false, issues: ['缺少来源'], hint: '补上来源' }
      },
    }),
  }
  const hintStep = 1 + Math.floor(random() * 3)
  const blockFail = [0, 1, 2].map((q) => ({
    tool: 'fail',
    inputHash: inputHash({ q }),
    code: 'failure_streak',
    reason: '一直失败',
  }))
  const hinting: Guard = {
    id: 'hinting',
    version: '1',
    start: () => ({
      check: (facts) =>
        facts.step === hintStep ? { warn: { problem: '换个做法', block: blockFail } } : undefined,
    }),
  }
  const withGate = random() < 0.3
  const withGuard = random() < 0.3
  const steerAt = random() < 0.3 ? 2 + Math.floor(random() * 20) : undefined
  const abortAt = random() < 0.2 ? 3 + Math.floor(random() * 25) : undefined

  const task = defineTask({
    input: [{ role: 'user', parts: [{ type: 'text', text: '把资料整理成结论' }] }],
    budget: { maxTotalMs: 300_000, finalizeReserveMs: 1000, maxSteps: 8 },
    ...(withGate
      ? { deliverable: { output: lead.deliverable?.output ?? textContract(), checks: [gate] } }
      : {}),
    ...(withGuard ? { guards: [hinting] } : {}),
  })

  const leadTools = [ok, fail, slow, write]
  return { clock, archive, engine, lead, leadTools, task, steerAt, abortAt, injected }
}

const textContract = () => ({
  id: 'plain',
  version: '1',
  kind: 'text' as const,
  validate: async (c: { text?: string }) =>
    (c.text ?? '').trim()
      ? { ok: true as const }
      : { ok: false as const, issues: ['交付文本为空'], hint: '请给出回答' },
})

/** 场景覆盖：每类情况在 60 个种子里至少出现一次，否则生成器太弱（F25 后重复写操作较少收尾，40 个覆盖不到兜底）。 */
const COVERAGE = [
  'parallel_tools',
  'tool_error',
  'model_timeout',
  'model_error',
  'chaos',
  'steer',
  'aborted',
  'compaction',
  'intervention',
  'blocked_call',
  'child_run',
  'delivery_returned',
  'fallback',
  'completed',
] as const
const covered = new Set<(typeof COVERAGE)[number]>()

function cover(events: readonly RunEvent[]) {
  for (const e of events) {
    if (e.t === 'model_responded' && e.response.toolCalls.length > 1) covered.add('parallel_tools')
    if (e.t === 'tool_finished' && e.isError) covered.add('tool_error')
    if (e.t === 'model_failed' && e.error.code === 'MODEL_TIMEOUT') covered.add('model_timeout')
    if (e.t === 'steer_received') covered.add('steer')
    if (e.t === 'context_built' && e.compaction) covered.add('compaction')
    if (e.t === 'intervention_applied') covered.add('intervention')
    if (e.t === 'tool_finished' && e.errorCode === 'TOOL_BLOCKED') covered.add('blocked_call')
    if (e.t === 'delivery_checked' && e.outcome === 'returned') covered.add('delivery_returned')
    if (e.t === 'fallback_generated') covered.add('fallback')
    if (e.t === 'run_ended') {
      if (e.result.status === 'aborted') covered.add('aborted')
      if (e.result.status === 'completed') covered.add('completed')
      if (e.result.code === 'model_error') covered.add('model_error')
    }
  }
}

async function readAll(archive: ReturnType<typeof memoryArchive>, runId: string) {
  const out: RunEvent[] = []
  for await (const e of archive.read(runId)) out.push(e)
  return out
}

describe('invariant properties', () => {
  it.each(SEEDS)(
    'seed %i: every run ends, keeps the invariants and replays strictly',
    async (seed) => {
      const s = scenario(seed)
      const run = s.engine
        .environment({ name: 'property', principal: { reachable: true } })
        .start(s.lead, s.task)
      let seen = 0
      run.subscribe({
        onEvent: () => {
          seen++
          if (seen === s.steerAt) run.steer('换个方向')
          if (seen === s.abortAt) run.abort('属性测试取消')
        },
      })
      let done = false
      void run.result.then(() => (done = true))
      for (let i = 0; i < MAX_TICKS && !done; i++) await s.clock.tick(1000)
      expect(done, `seed ${seed}：根运行没有结束`).toBe(true)

      const unfinished = async () =>
        (await s.archive.query({ rootRunId: run.runId })).filter((r) => r.status === undefined)
      for (let i = 0; i < CHILD_TICKS && (await unfinished()).length > 0; i++) {
        await s.clock.tick(1000)
      }
      expect(await unfinished(), `seed ${seed}：子运行没有结束`).toEqual([])

      const runs = await s.archive.query({ rootRunId: run.runId })
      expect(runs.map((r) => r.runId)).toContain(run.runId)
      if (runs.length > 1) covered.add('child_run')
      if ((s.injected?.injected.length ?? 0) > 0) covered.add('chaos')
      for (const r of runs) {
        const events = await readAll(s.archive, r.runId)
        cover(events)
        const label = `seed ${seed} run ${r.runId}`
        expect(events.at(-1)?.t, label).toBe('run_ended')
        expect(checkInvariants(events, { complete: true }), label).toEqual([])
        expect(strictReplay(events).violations, label).toEqual([])
        if (r.runId === run.runId) {
          // 被封住的调用从未执行（AC-045）。
          const blocked = events.flatMap((e) =>
            e.t === 'tool_finished' && e.errorCode === 'TOOL_BLOCKED' ? [e.callId] : [],
          )
          const executed = s.leadTools.flatMap((t) => t.calls.map((c) => c.ctx.callId))
          expect(
            executed.filter((id) => blocked.includes(id)),
            label,
          ).toEqual([])
        }
      }
    },
  )

  it('the generated scenarios cover every case', () => {
    expect(COVERAGE.filter((c) => !covered.has(c))).toEqual([])
  })
})
