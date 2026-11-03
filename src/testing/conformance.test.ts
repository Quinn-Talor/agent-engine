import { describe, expect, it } from 'vitest'
import type {
  Check,
  Exposure,
  Guard,
  Memory,
  MemoryState,
  MemoryView,
  ModelMessage,
  PermissionRule,
} from '../sdk.js'
import type { ContractCase } from './archive-contract.js'
import { conformance } from './conformance.js'

const named = (cases: ContractCase[], name: string) => {
  const c = cases.find((x) => x.name === name)
  if (!c) throw new Error(`没有用例：${name}；现有 ${cases.map((x) => x.name).join(' / ')}`)
  return c
}
const passAll = async (cases: ContractCase[]) => {
  for (const c of cases) await c.run()
}

/** 连续 3 步全部失败时告知，5 步时收尾。 */
const streak: Guard = {
  id: 'streak',
  version: '1',
  start: () => {
    let n = 0
    return {
      check: (facts) => {
        n = facts.allToolsFailed ? n + 1 : 0
        if (n === 3) return { warn: { problem: `连续 ${n} 步失败`, suggest: '换个工具' } }
        if (n >= 5) return { end: { as: 'finalize', code: 'failure_streak' }, detail: `计数 ${n}` }
        return undefined
      },
    }
  },
}
const passMemory: Memory = {
  id: 'pass',
  version: '1',
  start: () => ({ recall: async () => ({}) }),
}
const ratioOf = (s: MemoryState) =>
  s.estimate([...s.history, ...s.transcript]) / (s.inputLimit - s.fixedTokens)
const isCall = (m: ModelMessage) =>
  m.role === 'assistant' &&
  Array.isArray(m.content) &&
  m.content.some((p) => p.type === 'tool-call')

/** 占比达到 trigger 时，把最后一组工具交换之前的内容压成摘要；`cutAt` 改写切分点。 */
function summarizingMemory(
  opts: { trigger?: number; cutAt?: (cut: number) => number; onCompact?: () => void } = {},
): Memory {
  return {
    id: 'summarizing',
    version: '1',
    start: (_run, ctx) => ({
      async recall(s): Promise<MemoryView> {
        const all = [...s.history, ...s.transcript]
        if (ratioOf(s) < (opts.trigger ?? 0.8)) return {}
        const last = all.findLastIndex(isCall)
        const cut = opts.cutAt ? opts.cutAt(last) : last
        const response = await ctx.callModel({
          purpose: 'memory:compaction',
          messages: [{ role: 'user', content: JSON.stringify(all.slice(0, cut)) }],
        })
        if (cut <= 0 || !response) return {}
        opts.onCompact?.()
        return { compaction: { upTo: cut, summary: response.text } }
      },
    }),
  }
}

const allExposure: Exposure = {
  id: 'all',
  version: '1',
  start: () => ({ visible: (s) => s.prepared.map((p) => p.name) }),
}
const nonEmpty: Check = {
  id: 'non-empty',
  version: '1',
  mode: 'gate',
  start: () => ({
    accept: async (c) =>
      (c.text ?? '').trim() ? { pass: true } : { pass: false, issues: ['空'], hint: '写点什么' },
  }),
}
const askHigh: PermissionRule = {
  id: 'ask-high',
  version: '1',
  permit: async (call) =>
    call.risk === 'high' ? { ask: { summary: `执行 ${call.toolName}`, risk: 'high' } } : 'allow',
}

describe('conformance', () => {
  it('AC-036 passes a conforming guard', async () => {
    const cases = conformance.guard(streak)
    expect(cases.map((c) => c.name)).toEqual([
      'guard: returns undefined or a valid opinion',
      'guard: is deterministic',
      'guard: does not warn on every healthy step',
    ])
    await passAll(cases)
  })

  it('AC-036 fails a random guard and a guard that always warns', async () => {
    let n = 0
    const random: Guard = {
      ...streak,
      start: () => ({ check: () => (n++ % 2 ? { warn: { problem: '随机' } } : undefined) }),
    }
    await expect(
      named(conformance.guard(random), 'guard: is deterministic').run(),
    ).rejects.toThrow()
    const noisy: Guard = {
      ...streak,
      start: () => ({ check: () => ({ warn: { problem: '总是' } }) }),
    }
    await passAll([named(conformance.guard(noisy), 'guard: is deterministic')])
    await expect(
      named(conformance.guard(noisy), 'guard: does not warn on every healthy step').run(),
    ).rejects.toThrow()
  })

  it('AC-036 fails a guard that returns a malformed opinion', async () => {
    const malformed = (opinion: unknown): Guard => ({
      ...streak,
      start: () => ({ check: () => opinion as never }),
    })
    for (const bad of [
      { warn: { problem: '' } },
      { warn: { problem: 'p', block: [{ tool: 't' }] } },
      { end: { as: 'complete', code: 'x' } },
      { end: { as: 'stop' } },
      { awaitInput: {} },
      { complete: true },
      { warn: { problem: 'p' }, end: { as: 'stop', code: 'x' } },
      { warn: { problem: 'p' }, detail: 1 },
    ]) {
      await expect(
        named(
          conformance.guard(malformed(bad)),
          'guard: returns undefined or a valid opinion',
        ).run(),
      ).rejects.toThrow()
    }
  })

  it('AC-010 passes a conforming memory', async () => {
    const cases = conformance.memory(passMemory)
    expect(cases.map((c) => c.name)).toEqual([
      'memory: is deterministic',
      'memory: returns a valid decision',
      'memory: keeps tool calls paired with their results',
      'memory: compacts nothing below the compaction trigger',
      'memory: leaves the task input and the given messages untouched',
      'memory: handles an empty transcript',
    ])
    await passAll(cases)
  })

  it('AC-010 drives a memory past the trigger and gives it a summary to compact with', async () => {
    let compactions = 0
    const ratios: number[] = []
    const watched: Memory = {
      ...passMemory,
      start: () => ({
        recall: async (s) => {
          ratios.push(ratioOf(s))
          return {}
        },
      }),
    }
    await passAll(conformance.memory(watched))
    expect(ratios.some((r) => r >= 0.8 && r < 1)).toBe(true)
    expect(ratios.some((r) => r >= 1)).toBe(true)
    expect(ratios.some((r) => r >= 0.5 && r < 0.8)).toBe(true)
    await passAll(conformance.memory(summarizingMemory({ onCompact: () => void compactions++ })))
    expect(compactions).toBeGreaterThan(0)
  })

  it('AC-010 checks compactions against the trigger the memory declares', async () => {
    const early = summarizingMemory({ trigger: 0.5 })
    await expect(
      named(
        conformance.memory(early),
        'memory: compacts nothing below the compaction trigger',
      ).run(),
    ).rejects.toThrow(/低于压缩触发线/)
    await passAll(conformance.memory(early, { trigger: 0.5 }))
  })

  it('AC-011 passes a conforming exposure', async () => {
    const cases = conformance.exposure(allExposure)
    expect(cases.map((c) => c.name)).toEqual([
      'exposure: is deterministic',
      'exposure: only narrows the prepared tools',
      'exposure: shows nothing when nothing is prepared',
    ])
    await passAll(cases)
  })

  it('AC-012 passes conforming checks and permission rules', async () => {
    const all = [...conformance.check(nonEmpty), ...conformance.permission(askHigh)]
    expect(all.map((c) => c.name)).toEqual([
      'check: returns a valid result',
      'check: is deterministic',
      'permission: returns allow, deny or ask',
      'permission: is deterministic',
    ])
    await passAll(all)
  })

  it('AC-014 fails an exposure that shows tools that were not prepared', async () => {
    const ghost: Exposure = {
      ...allExposure,
      start: () => ({ visible: (s) => [...s.prepared.map((p) => p.name), 'ghost'] }),
    }
    const cases = conformance.exposure(ghost)
    await expect(named(cases, 'exposure: only narrows the prepared tools').run()).rejects.toThrow(
      /ghost/,
    )
    await expect(
      named(cases, 'exposure: shows nothing when nothing is prepared').run(),
    ).rejects.toThrow()
  })

  it('AC-014 fails components that are not deterministic', async () => {
    let n = 0
    const flaky: PermissionRule = {
      ...askHigh,
      permit: async () => (n++ % 2 ? 'allow' : { deny: '随机' }),
    }
    await expect(
      named(conformance.permission(flaky), 'permission: is deterministic').run(),
    ).rejects.toThrow()
  })

  it('AC-014 fails components that return malformed values or throw', async () => {
    const badCheck: Check = {
      ...nonEmpty,
      start: () => ({
        accept: async () => ({ pass: false, issues: [], hint: 1 as unknown as string }),
      }),
    }
    await expect(
      named(conformance.check(badCheck), 'check: returns a valid result').run(),
    ).rejects.toThrow()
    const throwing: PermissionRule = {
      ...askHigh,
      permit: async (call) => {
        if (!call.access) throw new Error('没有 access')
        return 'allow'
      },
    }
    await expect(
      named(conformance.permission(throwing), 'permission: returns allow, deny or ask').run(),
    ).rejects.toThrow('没有 access')
    const badAsk: PermissionRule = {
      ...askHigh,
      permit: async () => ({ ask: { summary: 's', risk: 'medium' as 'low' } }),
    }
    await expect(
      named(conformance.permission(badAsk), 'permission: returns allow, deny or ask').run(),
    ).rejects.toThrow()
  })

  it('AC-014 fails memories whose compaction splits a pair or runs past the messages', async () => {
    // 压缩时切分点落在工具结果上：结果留在视图里，调用被压进了摘要。
    const splitting = summarizingMemory({ cutAt: (cut) => cut + 1 })
    await expect(
      named(
        conformance.memory(splitting),
        'memory: keeps tool calls paired with their results',
      ).run(),
    ).rejects.toThrow('前面没有调用')
    const pastTheEnd: Memory = {
      ...passMemory,
      start: () => ({
        recall: async (s) => ({
          compaction: { upTo: s.history.length + s.transcript.length + 1, summary: 's' },
        }),
      }),
    }
    await expect(
      named(conformance.memory(pastTheEnd), 'memory: returns a valid decision').run(),
    ).rejects.toThrow(/超出了/)
    const empty: Memory = {
      ...passMemory,
      start: () => ({ recall: async () => ({ compaction: { upTo: 1, summary: '' } }) }),
    }
    await expect(
      named(conformance.memory(empty), 'memory: returns a valid decision').run(),
    ).rejects.toThrow(/summary/)
  })

  it('AC-014 fails a memory that compacts below its trigger', async () => {
    const eager = summarizingMemory({ trigger: 0 })
    await expect(
      named(
        conformance.memory(eager),
        'memory: compacts nothing below the compaction trigger',
      ).run(),
    ).rejects.toThrow(/低于压缩触发线/)
  })

  it('AC-014 fails a memory that rewrites the task input or the messages it was given', async () => {
    const name = 'memory: leaves the task input and the given messages untouched'
    const rewritesInput: Memory = {
      ...passMemory,
      start: (run) => ({
        recall: async () => {
          run.task.input = '改写的任务输入'
          return {}
        },
      }),
    }
    await expect(named(conformance.memory(rewritesInput), name).run()).rejects.toThrow(/任务输入/)
    const trimsInPlace: Memory = {
      ...passMemory,
      start: () => ({
        recall: async (s) => {
          s.transcript.splice(0, 2)
          return {}
        },
      }),
    }
    await expect(named(conformance.memory(trimsInPlace), name).run()).rejects.toThrow(/改写/)
  })

  it('passes context overrides to the components', async () => {
    const hosted: PermissionRule = {
      ...askHigh,
      permit: async (_call, _run, ctx) =>
        ctx.host<{ ok: boolean }>('probe').ok ? 'allow' : { deny: 'x' },
    }
    await passAll(conformance.permission(hosted, { ctx: { host: <T>() => ({ ok: true }) as T } }))
    await expect(passAll(conformance.permission(hosted))).rejects.toThrow('没有能力宿主 probe')
  })
})
