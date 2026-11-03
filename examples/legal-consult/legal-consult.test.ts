// 法务咨询平台的场景测试：每个场景断言它演示的组件确实生效；自定义组件另外跑一致性测试，
// 再用回归重放确认"改了组件之后，旧日志上的裁决不变"。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { regressionReplay, standardGuards, type RunEvent } from 'agent-engine'
import { assertInvariants, conformance, sessionLogIssues } from 'agent-engine/testing'
import { citationsGrounded, legalOpinion } from './deliverable.ts'
import type { Opinion } from './domain.ts'
import { clientConsentRule, disclaimerRequired, noOutcomePromise } from './firm-rules.ts'
import {
  REVIEWER_MODEL,
  createLegalPlatform,
  noRepeatedResearch,
  type LegalPlatform,
} from './platform.ts'
import { SCENARIOS } from './scenarios.ts'
import { stagedExposure } from './toolbox.ts'

let p: LegalPlatform
beforeEach(async () => {
  p = await createLegalPlatform()
})
afterEach(() => p.shutdown())

const play = (id: string) => SCENARIOS.find((s) => s.id === id)!.run(p)
const ofType = <T extends RunEvent['t']>(events: RunEvent[], t: T) =>
  events.filter((e): e is Extract<RunEvent, { t: T }> => e.t === t)
const toolCalls = (events: RunEvent[]) =>
  ofType(events, 'model_responded').flatMap((e) => e.response.toolCalls.map((c) => c.name))
const deniedBy = (events: RunEvent[]) =>
  ofType(events, 'permission_decided').flatMap((e) =>
    typeof e.verdict === 'object' && 'deny' in e.verdict
      ? [{ source: e.source, reason: e.verdict.deny }]
      : [],
  )

describe('legal consultation scenarios', () => {
  it('standard: delivers a cited opinion after one repair, with precedents from the MCP case library', async () => {
    const [run] = await play('standard')
    expect(run!.result).toMatchObject({ status: 'completed', code: 'submit' })
    const opinion = run!.result.output as Opinion
    expect(opinion.analysis.every((a) => a.citations.length > 0)).toBe(true)
    expect(opinion.compensation).toEqual({ months: 4.5, amount: 54000 })
    expect(opinion.precedents).toHaveLength(2)
    expect(opinion.disclaimer).toContain('不构成正式法律意见')
    // 第一稿漏写依据被领域校验退回，补上后交付。
    expect(ofType(run!.events, 'delivery_checked').map((e) => e.outcome)).toEqual([
      'returned',
      'delivered',
    ])
    // 按阶段呈现：检索法规之前看不到 submit。
    const visible = ofType(run!.events, 'context_built').map((e) => e.tools)
    expect(visible[0]).not.toContain('submit')
    expect(visible.at(-1)).toContain('submit')
    expect(toolCalls(run!.events)).toEqual(
      expect.arrayContaining([
        'activate_skill',
        'update_plan',
        'read_dossier',
        'search_statutes',
        'delegate',
        'calc_compensation',
      ]),
    )
    assertInvariants(run!.events)
  })

  it('keeps the case-law token out of every run log and diagnostic log', async () => {
    const [run] = await play('standard')
    const childRunIds = ofType(run!.events, 'tool_finished').flatMap((e) =>
      e.childRunId ? [e.childRunId] : [],
    )
    expect(childRunIds).toHaveLength(1)
    const logs = [run!.events]
    for (const id of childRunIds) {
      const child: RunEvent[] = []
      for await (const e of p.archive.read(id)) child.push(e)
      expect(child.at(-1)).toMatchObject({ t: 'run_ended', result: { status: 'completed' } })
      logs.push(child)
    }
    expect(JSON.stringify([logs, p.logs])).not.toContain('demo-case-law-token')
  })

  it('follow-up: asks for missing facts, then continues as the next turn of the session', async () => {
    const [first, second] = await play('follow-up')
    expect(first!.result).toMatchObject({ status: 'awaiting_input', code: 'ask_user' })
    expect(first!.result.intent?.tool).toBe('ask_user')
    expect(second!.result).toMatchObject({ status: 'completed', code: 'submit' })
    const started = second!.events.find((e) => e.t === 'run_started')
    expect(started?.t === 'run_started' && started.session).toMatchObject({
      id: 'walk-in-follow-up',
      turn: 2,
      continues: { runId: first!.runId },
    })
    // 每一轮冻结的窗口都能从接续点的日志重新推导出来（I17）。
    expect(await sessionLogIssues(p.archive, 'walk-in-follow-up')).toEqual([])
    // 上一轮已经激活了 skill：这一轮直接检索，不重复激活。
    expect(toolCalls(second!.events)[0]).toBe('search_statutes')
    expect(toolCalls(second!.events)).not.toContain('activate_skill')
  })

  it('conflict: a notice provider blocks the consultation before any model call', async () => {
    const [run] = await play('conflict')
    expect(run!.result).toMatchObject({ status: 'stopped', code: 'notice_blocked', steps: 0 })
    expect(run!.result.text).toContain('利益冲突')
  })

  it('letter: the hook rejects a letter without a recipient, the lawyer approves the corrected one', async () => {
    const [run] = await play('letter')
    expect(run!.result).toMatchObject({ status: 'completed' })
    expect(deniedBy(run!.events)).toEqual([
      {
        source: expect.stringMatching(/^hook:PreToolUse/),
        reason: '律师函必须写明收件人（对方单位全称）',
      },
    ])
    expect(p.reviews).toEqual([
      expect.objectContaining({ tool: 'send_demand_letter', approved: true, reviewer: '李律师' }),
    ])
    expect(p.outbox).toEqual([
      expect.objectContaining({ recipient: '星河科技有限公司', amount: 90000 }),
    ])
    expect((run!.result.output as Opinion).nextSteps).toContain('律所已向公司发出催告律师函')
  })

  it('letter without consent: the consent rule refuses and the opinion asks for authorisation', async () => {
    const [run] = await play('letter-without-consent')
    expect(run!.result).toMatchObject({ status: 'completed' })
    expect(deniedBy(run!.events)[0]).toEqual({
      source: 'client-consent',
      reason: '客户尚未书面授权以律所名义发函，请先取得授权。',
    })
    expect(p.outbox).toEqual([])
    expect(p.reviews).toEqual([])
    expect((run!.result.output as Opinion).nextSteps).toContain(
      '如需律所以律所名义发函，请先签署书面授权',
    )
  })

  it('promise: the environment guard warns about promising an outcome and the opinion drops it', async () => {
    const [run] = await play('promise')
    const warned = ofType(run!.events, 'evaluated').flatMap((e) =>
      e.opinions.filter(
        (o) =>
          o.source === 'environment:no-outcome-promise' && o.opinion && 'continue' in o.opinion,
      ),
    )
    expect(warned).toHaveLength(1)
    const opinion = run!.result.output as Opinion
    expect(run!.result.status).toBe('completed')
    expect(opinion.summary).toContain('取决于')
    expect(JSON.stringify(opinion)).not.toMatch(/保证胜诉|一定能赢/)
  })

  it('stale dossier: the capability guard warns first, then stops the run', async () => {
    const [run] = await play('stale-dossier')
    expect(run!.result).toMatchObject({ status: 'stopped', code: 'stale_dossier' })
    const sources = ofType(run!.events, 'evaluated').map(
      (e) => e.opinions.find((o) => o.source === 'capability:stale-dossier')?.opinion,
    )
    expect(sources.filter(Boolean).map((o) => Object.keys(o!)[0])).toEqual(['continue', 'stop'])
  })

  it('quick answer: the task overrides the deliverable and the step budget ends in a fallback', async () => {
    const [run] = await play('quick-answer')
    expect(run!.result).toMatchObject({ status: 'finalized', code: 'max_steps', steps: 3 })
    expect(run!.result.text).toMatch(/^阶段性意见：根据《劳动合同法》第三十八条/)
    expect(ofType(run!.events, 'fallback_generated')).toHaveLength(1)
  })

  it('sandbox: reading the firm’s internal files is denied, the consultation still completes', async () => {
    const [run] = await play('sandbox')
    expect(deniedBy(run!.events)[0]).toEqual({
      source: 'workspace-sandbox',
      reason: expect.stringContaining('敏感路径不可访问'),
    })
    expect(run!.result.status).toBe('completed')
  })

  it('records an audit trail and exports spans for the whole delegation tree', async () => {
    await play('letter')
    expect(p.audit).toEqual(
      expect.arrayContaining([
        expect.stringContaining('审批：send_demand_letter 已批准'),
        expect.stringContaining('[子运行] ▶ 开始：case-researcher'),
      ]),
    )
    expect(p.spans.length).toBeGreaterThan(0)
  })

  it('replays the standard consultation with the same components and reaches the same verdicts', async () => {
    const [run] = await play('standard')
    const report = await regressionReplay({
      events: run!.events,
      getBlob: async (ref) => {
        const data = await p.archive.getBlob(ref)
        return typeof data === 'string' ? data : new TextDecoder().decode(data)
      },
      guards: {
        task: [noRepeatedResearch],
        environment: [noOutcomePromise],
        engine: standardGuards(),
      },
      deliverable: legalOpinion(REVIEWER_MODEL) as Parameters<
        typeof regressionReplay
      >[0]['deliverable'],
      environmentChecks: [disclaimerRequired],
    })
    expect(report.steps.every((s) => s.same)).toBe(true)
    expect(report.deliveries.every((d) => d.same)).toBe(true)
  })
})

describe('custom components pass the conformance suites', () => {
  for (const c of [
    ...conformance.guard(noOutcomePromise),
    ...conformance.check(citationsGrounded),
    ...conformance.check(disclaimerRequired),
    ...conformance.permission(clientConsentRule),
    ...conformance.exposure(stagedExposure),
  ]) {
    it(c.name, () => c.run())
  }
})
