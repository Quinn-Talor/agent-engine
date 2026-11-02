import { describe, expect, it } from 'vitest'
import { inputHash } from '../definition/hash.js'
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
  type EventBody,
} from '../log/events.fixture.js'
import { costOf, matchBlock, stepFacts } from './facts.js'
import { apply, initial, type RunState } from '../run/state.js'

const fold = (bodies: EventBody[]): RunState =>
  sequence(bodies).reduce(apply, initial({ runId: 'r1' }))

const continueVerdict = { continue: { interventions: [] }, sources: ['default'] }

const intentsCapability = {
  capability: 'intents',
  kind: 'intents',
  version: '1',
  fingerprint: 'fp',
  tools: [
    { name: 'submit', schemaHash: 'h', intent: { kind: 'complete' as const, code: 'submit' } },
    { name: 'search', schemaHash: 'h', effect: 'none' as const },
  ],
}

describe('stepFacts', () => {
  it('AC-027 reports blocked calls, new information and the violated block source and code', () => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1),
      evaluated(1, continueVerdict),
      stepEnded(1),
      stepStarted(2),
      {
        t: 'intervention_applied',
        step: 2,
        intervention: {
          block: {
            tool: 'fetch',
            inputHash: inputHash({ q: 'c2' }),
            code: 'failure_streak',
            reason: 'loop',
          },
        },
        source: 'engine:roadblock',
      },
      contextBuilt(2, 500),
      modelResponded(2, { toolCalls: [call('c1'), call('c2', 'fetch')], text: 'working' }),
      toolFinished('c1'),
      toolFinished('c2', { isError: true, errorCode: 'TOOL_BLOCKED' }),
    ])
    const facts = stepFacts(state, { now: 1_200 })
    expect(facts.step).toBe(2)
    expect(facts.text).toBe('working')
    expect(facts.allToolsFailed).toBe(false)
    expect(facts.toolCalls.map((c) => [c.name, c.ok, c.blocked])).toEqual([
      ['search', true, false],
      ['fetch', false, true],
    ])
    expect(facts.toolCalls[0]!.inputHash).toBe(inputHash({ q: 'c1' }))
    expect(facts.newInformation).toBe(true)
    expect(facts.interventions).toEqual({
      applied: [{ kind: 'block', source: 'engine:roadblock' }],
      violated: [{ source: 'engine:roadblock', code: 'failure_streak' }],
    })
    expect(facts.pressure.context).toBeCloseTo(0.05)
    expect(facts.pressure.steps).toBeCloseTo(2 / 1000)
  })

  it('treats a step without tool calls as a final candidate', () => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { text: 'done' }),
    ])
    const facts = stepFacts(state, { now: 1_100 })
    expect(facts.allToolsFailed).toBeNull()
    expect(facts.isFinalCandidate).toBe(true)
    expect(facts.newInformation).toBe(false)
  })

  it('recognises a lone complete intent such as submit', () => {
    const state = fold([
      runStarted({ capabilities: [intentsCapability] }),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1', 'submit', { answer: 1 })] }),
      toolFinished('c1', { capability: 'intents' }),
    ])
    const facts = stepFacts(state, { now: 1_100 })
    expect(facts.intent).toEqual({ tool: 'submit', kind: 'complete', code: 'submit' })
    expect(facts.isFinalCandidate).toBe(true)
  })

  it('ignores an intent that failed with INTENT_NOT_ALONE', () => {
    const state = fold([
      runStarted({ capabilities: [intentsCapability] }),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1', 'submit'), call('c2', 'search')] }),
      toolFinished('c1', { isError: true, errorCode: 'INTENT_NOT_ALONE' }),
      toolFinished('c2'),
    ])
    const facts = stepFacts(state, { now: 1_100 })
    expect(facts.intent).toBeUndefined()
    expect(facts.isFinalCandidate).toBe(false)
  })

  it('does not count outputs already seen in earlier steps as new information', () => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1')] }),
      toolFinished('c1', { shown: `sha256:${'a'.repeat(64)}` }),
      evaluated(1, continueVerdict),
      stepEnded(1),
      stepStarted(2),
      contextBuilt(2),
      modelResponded(2, { toolCalls: [call('c2')] }),
      toolFinished('c2', { shown: `sha256:${'a'.repeat(64)}` }),
    ])
    expect(stepFacts(state, { now: 1_100 }).newInformation).toBe(false)
  })

  it('hashes a call without input like a call with null input', () => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [{ id: 'c1', name: 'search', input: undefined }] }),
      toolFinished('c1'),
    ])
    const [fact] = stepFacts(state, { now: 1_100 }).toolCalls
    expect(fact).toMatchObject({ inputHash: inputHash(null), inputPreview: 'null' })
  })

  it('computes time and cost pressure, including side model calls', () => {
    const state = fold([
      runStarted({
        task: { fingerprint: 't', budget: { maxTotalMs: 1_000, finalizeReserveMs: 0, maxCost: 1 } },
      }),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      {
        t: 'external_call',
        source: 'engine:advisor/supervision:advise',
        kind: 'model',
        request: 'sha256:a',
        response: 'sha256:b',
        usage: { input: 250_000, output: 0, cacheRead: 0, cacheWrite: 0 },
        startedAt: 0,
        durationMs: 1,
      },
    ])
    const facts = stepFacts(state, { now: 1_500, price: { input: 0.5, output: 1 } })
    expect(facts.pressure.time).toBeCloseTo(0.5)
    expect(facts.pressure.cost).toBeCloseTo(0.625)
    expect(facts.usage.input).toBe(1_000_000)
  })
})

describe('stepFacts guard facts (F18)', () => {
  it('AC-002 marks the error class of failed calls and intent tool calls', () => {
    const state = fold([
      runStarted({ capabilities: [intentsCapability] }),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, {
        toolCalls: [call('c1'), call('c2'), call('c3', 'submit')],
      }),
      toolFinished('c1', { isError: true, errorCode: 'INVALID_INPUT' }),
      toolFinished('c2'),
      toolFinished('c3'),
    ])
    const [failed, ok, intent] = stepFacts(state, { now: 1_100 }).toolCalls
    expect(failed!.errorClass).toBe('deterministic')
    expect(ok!.errorClass).toBeUndefined()
    expect(ok!.intentTool).toBeUndefined()
    expect(intent!.intentTool).toBe(true)
  })

  it('takes the error class a tool declared over the default one', () => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1'), call('c2')] }),
      toolFinished('c1', {
        isError: true,
        errorCode: 'ORDER_NOT_FOUND',
        errorClass: 'deterministic',
      }),
      toolFinished('c2', { isError: true, errorCode: 'INVALID_INPUT', errorClass: 'transient' }),
    ])
    expect(stepFacts(state, { now: 1_100 }).toolCalls.map((c) => c.errorClass)).toEqual([
      'deterministic',
      'transient',
    ])
  })

  it('AC-002 treats a failed call without an error code as transient', () => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1')] }),
      toolFinished('c1', { isError: true }),
    ])
    expect(stepFacts(state, { now: 1_100 }).toolCalls[0]!.errorClass).toBe('transient')
  })

  it('marks failed side effects that may have run, and nothing else', () => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1'), call('c2'), call('c3'), call('c4')] }),
      toolFinished('c1', { effect: 'side_effect', isError: true, errorCode: 'TOOL_TIMEOUT' }),
      toolFinished('c2', {
        effect: 'side_effect',
        isError: true,
        errorCode: 'TOOL_EXCEPTION',
        possiblyExecuted: true,
      }),
      toolFinished('c3', { effect: 'side_effect', isError: true, errorCode: 'INVALID_INPUT' }),
      toolFinished('c4', { effect: 'none', isError: true, errorCode: 'TOOL_TIMEOUT' }),
    ])
    expect(stepFacts(state, { now: 1_100 }).toolCalls.map((c) => c.possiblyExecuted)).toEqual([
      true,
      true,
      undefined,
      undefined,
    ])
  })

  it('AC-003 does not treat a truncated text-only step as a final candidate', () => {
    const at = (finishReason: 'length' | 'stop') =>
      stepFacts(
        fold([
          runStarted(),
          stepStarted(1),
          contextBuilt(1),
          modelResponded(1, { text: 'partial', finishReason }),
        ]),
        { now: 1_100 },
      ).isFinalCandidate
    expect(at('length')).toBe(false)
    expect(at('stop')).toBe(true)
  })

  it('AC-004 reports token pressure against maxInputTokens', () => {
    const at = (budget: { maxInputTokens?: number }) =>
      stepFacts(
        fold([
          runStarted({ task: { fingerprint: 't', budget } }),
          stepStarted(1),
          contextBuilt(1),
          modelResponded(1, { usage: { input: 900, output: 0, cacheRead: 0, cacheWrite: 0 } }),
        ]),
        { now: 1_100 },
      ).pressure
    expect(at({ maxInputTokens: 1000 }).tokens).toBeCloseTo(0.9)
    expect(at({}).tokens).toBe(0)
    expect(at({})).not.toHaveProperty('supervision')
  })

  it('AC-004 counts cached input toward token pressure', () => {
    const state = fold([
      runStarted({ task: { fingerprint: 't', budget: { maxInputTokens: 1000 } } }),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { usage: { input: 100, output: 50, cacheRead: 600, cacheWrite: 200 } }),
    ])
    expect(stepFacts(state, { now: 1_100 }).pressure.tokens).toBeCloseTo(0.9)
  })

  it('measures time pressure against the time left before the finalize reserve', () => {
    const at = (budget: { maxTotalMs: number; finalizeReserveMs?: number }, now: number) =>
      stepFacts(
        fold([
          runStarted({ task: { fingerprint: 't', budget } }),
          stepStarted(1),
          contextBuilt(1),
          modelResponded(1),
        ]),
        { now },
      ).pressure.time
    // 运行在 1_000 开始；总时长 1_000、预留 200：可用 800，已用 400。
    expect(at({ maxTotalMs: 1_000, finalizeReserveMs: 200 }, 1_400)).toBeCloseTo(0.5)
    // 预留不小于总时长（默认预留 120 秒）：一开始就到了收尾线。
    expect(at({ maxTotalMs: 1_000 }, 1_000)).toBe(1)
  })

  it('counts the admission queue toward the time used (§5.3)', () => {
    const state = fold([
      runStarted({
        task: { fingerprint: 't', budget: { maxTotalMs: 1_000, finalizeReserveMs: 200 } },
        queuedMs: 400,
      }),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1),
    ])
    // run_started 在 1_000，排队 400：运行从 600 算起，到 1_000 已用 400，可用 800。
    expect(stepFacts(state, { now: 1_000 }).pressure.time).toBeCloseTo(0.5)
  })
})

describe('stepFacts previews (F8)', () => {
  it('adds input and output previews, the repeatable flag and the remaining steps', () => {
    const state = fold([
      runStarted({
        task: { fingerprint: 't', budget: { maxSteps: 5 } },
        capabilities: [
          {
            capability: 'tools',
            kind: 'tool',
            version: '1',
            fingerprint: 'fp',
            tools: [
              { name: 'poll', schemaHash: 'h', effect: 'none', repeatable: true },
              { name: 'search', schemaHash: 'h' },
            ],
          },
        ],
      }),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, {
        toolCalls: [call('c1', 'poll', { id: 1 }), call('c2', 'search', { q: 'x'.repeat(300) })],
      }),
      toolFinished('c1'),
      toolFinished('c2'),
    ])
    const facts = stepFacts(state, { now: 1_100, previews: new Map([['c1', 'pending']]) })
    expect(facts.stepsLeft).toBe(4)
    expect(facts.toolCalls[0]).toMatchObject({
      inputPreview: '{"id":1}',
      outputPreview: 'pending',
      repeatable: true,
    })
    expect(facts.toolCalls[1]!.inputPreview).toHaveLength(200)
    expect(facts.toolCalls[1]).not.toHaveProperty('outputPreview')
    expect(facts.toolCalls[1]).not.toHaveProperty('repeatable')
  })
})

describe('matchBlock and costOf', () => {
  it('AC-027 matches only the same tool and input hash within the block range', () => {
    const block = {
      tool: 'search',
      inputHash: 'h1',
      code: 'repeat',
      reason: 'r',
      source: 'engine:roadblock',
      since: 2,
      until: Infinity,
    }
    expect(matchBlock([block], 1_000, 'search', 'h1')).toBe(block)
    expect(matchBlock([block], 1, 'search', 'h1')).toBeUndefined()
    expect(matchBlock([block], 3, 'search', 'h2')).toBeUndefined()
    expect(matchBlock([block], 3, 'fetch', 'h1')).toBeUndefined()
  })

  it.each([
    ['without a price', undefined, 0],
    ['with cache prices', { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }, 4.35],
    // 价格表没写缓存价时按输入价计，宁可高估也不漏算。
    ['pricing cache at the input price when omitted', { input: 1, output: 2 }, 5],
  ])('costOf %s', (_name, price, expected) => {
    const usage = {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    }
    expect(costOf(usage, price)).toBeCloseTo(expected)
  })
})
