import { describe, expect, it } from 'vitest'
import type { Candidate, ComponentCtx, Corpus } from '../../sdk.js'
import { runInfo } from '../capabilities/prepare.fixture.js'
import { obs } from '../supervision/observations.fixture.js'
import { groundingCheck } from './grounding-check.js'

const corpus: Corpus = {
  sources: [
    { origin: 'input', text: '分析' },
    { origin: 'tool', text: '营业收入为1234.5亿元', callId: 'c1' },
  ],
}
const candidate = (text: string): Candidate => ({ step: 3, text, observation: obs(3) })
const accept = (text: string, opts?: Parameters<typeof groundingCheck>[0]) =>
  groundingCheck(opts)
    .start(runInfo(), {} as ComponentCtx)
    .accept(candidate(text), corpus)

describe('groundingCheck', () => {
  it('AC-022 identifies itself and defaults to shadow mode', () => {
    expect(groundingCheck()).toMatchObject({
      id: 'grounding',
      version: '1',
      mode: 'shadow',
      config: { threshold: 2 },
    })
    expect(groundingCheck({ mode: 'gate', maxAttempts: 2, threshold: 1 })).toMatchObject({
      mode: 'gate',
      maxAttempts: 2,
      config: { threshold: 1 },
    })
    expect(groundingCheck()).not.toHaveProperty('maxAttempts')
  })

  it('AC-005 passes a single unverifiable item', async () => {
    expect(await accept('他说“明年将继续保持百分之二十以上的增长”')).toEqual({ pass: true })
  })

  it('AC-005 fails at two unverifiable items and lists them', async () => {
    const text = '他说“明年将继续保持百分之二十以上的增长”，代码 000858.SZ'
    expect(await accept(text)).toEqual({
      pass: false,
      issues: ['引文无法核实：明年将继续保持百分之二十以上的增长', '实体找不到出处：000858.SZ'],
      hint: '以下内容在资料中找不到出处，请修正或删除：\n- 明年将继续保持百分之二十以上的增长\n- 000858.SZ',
    })
    expect((await accept('代码 000858.SZ', { threshold: 1 })).pass).toBe(false)
  })
})
