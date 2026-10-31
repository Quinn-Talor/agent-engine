import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Candidate, ComponentCtx, Observation } from '../../contracts/component.js'
import type { ToolCtx } from '../../contracts/tool.js'
import { structured, text } from './output-contracts.js'

const observation = (patch: Partial<Observation> = {}): Observation => ({
  step: 1,
  text: '',
  toolCalls: [],
  allToolsFailed: null,
  isFinalCandidate: true,
  newInformation: false,
  finishReason: 'stop',
  interventions: { applied: [], violated: [] },
  pressure: { context: 0, steps: 0, time: 0, tokens: 0, cost: 0 },
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ...patch,
})
const candidate = (patch: Partial<Candidate> = {}): Candidate => ({
  step: 1,
  observation: observation(),
  ...patch,
})
const ctx = {} as ComponentCtx

describe('text', () => {
  const contract = text()

  it('AC-001 accepts non-empty text', async () => {
    expect(await contract.validate(candidate({ text: 'answer' }), ctx)).toEqual({ ok: true })
  })

  it('AC-001 rejects blank text', async () => {
    expect(await contract.validate(candidate({ text: '  \n' }), ctx)).toEqual({
      ok: false,
      issues: ['交付文本为空'],
      hint: '请直接给出完整的回答文本',
    })
  })

  it('AC-001 accepts empty text when the run completed through an intent', async () => {
    const obs = observation({ intent: { tool: 'finish', kind: 'complete', code: 'finish' } })
    expect(await contract.validate(candidate({ text: '', observation: obs }), ctx)).toEqual({
      ok: true,
    })
  })

  it('identifies itself and keeps an optional sanitizer', () => {
    expect(contract).toMatchObject({
      id: 'text',
      version: '1',
      kind: 'text',
      config: { sanitize: null },
    })
    expect(contract.sanitize).toBeUndefined()
    const clean = text({
      sanitize: function strip(t) {
        return t.trim()
      },
    })
    expect(clean.sanitize?.(' x ', { sources: [] })).toBe('x')
    expect(clean.config).toEqual({ sanitize: 'strip' })
  })
})

describe('structured', () => {
  const schema = z.object({ score: z.number() })
  const contract = structured(schema, {
    maxRepairs: 2,
    validate: async (output) =>
      output.score >= 0
        ? { ok: true }
        : { ok: false, issues: ['score 不能为负'], hint: '修正 score' },
  })

  it('AC-002 provides a submit tool that completes the run', async () => {
    expect(contract.tools).toHaveLength(1)
    const submit = contract.tools![0]!
    expect(submit).toMatchObject({
      name: 'submit',
      execution: { effect: 'none' },
      semantics: { intent: { kind: 'complete', code: 'submit' } },
    })
    expect(submit.inputSchema).toBe(schema)
    expect(await submit.execute({ score: 1 }, {} as ToolCtx)).toBe('已提交，等待校验')
  })

  it.each([
    ['AC-002 a valid output', { score: 5 }, { ok: true }],
    [
      'AC-002 a domain violation',
      { score: -1 },
      { ok: false, issues: ['score 不能为负'], hint: '修正 score' },
    ],
    [
      'AC-002 a missing submit',
      undefined,
      {
        ok: false,
        issues: ['没有调用 submit 提交结果'],
        hint: '调用 submit 提交符合 schema 的结果',
      },
    ],
  ])('validates %s', async (_name, output, expected) => {
    expect(await contract.validate(candidate(output === undefined ? {} : { output }), ctx)).toEqual(
      expected,
    )
  })

  it('accepts any submitted output without a domain validator and defaults repairs to 3', async () => {
    const plain = structured(schema)
    expect(await plain.validate(candidate({ output: { score: -1 } }), ctx)).toEqual({ ok: true })
    expect(plain.maxRepairs).toBe(3)
    expect(plain.config).toMatchObject({ validate: null, maxRepairs: 3 })
    expect(contract.maxRepairs).toBe(2)
    expect(contract.schema).toBe(schema)
    expect(contract.config).toMatchObject({ schema: { type: 'object' }, validate: 'validate' })
  })
})
