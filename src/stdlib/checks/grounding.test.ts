import { describe, expect, it } from 'vitest'
import type { Corpus } from '../../api.js'
import { grounding } from './grounding.js'

const corpus = (tool: string, input = '分析贵州茅台'): Corpus => ({
  sources: [
    { origin: 'input', text: input },
    ...(tool ? [{ origin: 'tool' as const, text: tool, callId: 'c1' }] : []),
  ],
})

describe('grounding.normalize', () => {
  it.each([
    ['thousands, trailing zeros and units', '营收 1,234.50 万元', '营收1234.5万元'],
    ['yi against wan', '市值 1.2亿', '市值12000万'],
    ['full width and percent spacing', '增长１２.５０ %', '增长12.5%'],
    ['wan yi', '0.5万亿', '5000亿'],
  ])('AC-001 treats %s as the same', (_name, a, b) => {
    expect(grounding.normalize(a)).toBe(grounding.normalize(b))
  })

  it('keeps different numbers different', () => {
    expect(grounding.normalize('1.2亿')).not.toBe(grounding.normalize('1.3亿'))
    expect(grounding.normalize('12.05')).toBe('12.05')
    expect(grounding.normalize('3.000')).toBe('3')
  })
})

describe('grounding.unverified', () => {
  const tool = '公司公告：2024年营业收入为1,234.5亿元，同比增长15.2%。股票代码600519.SH。'

  it('AC-002 reports long quotes missing from the corpus and ignores short ones', () => {
    const text = [
      '公告称“2024年营业收入为 1234.50 亿元”。',
      '管理层表示“明年将继续保持百分之二十以上的增长”。',
      '他说“很好”。',
    ].join('')
    expect(grounding.unverified(text, corpus(tool))).toEqual([
      { kind: 'quote', text: '明年将继续保持百分之二十以上的增长' },
    ])
  })

  it('AC-002 checks quotes of exactly 20 bytes', () => {
    const twenty = 'abcdefghijklmnopqrst'
    expect(grounding.unverified(`"${twenty}"`, corpus(tool))).toEqual([
      { kind: 'quote', text: twenty },
    ])
    expect(grounding.unverified(`"${twenty.slice(1)}"`, corpus(tool))).toEqual([])
    expect(grounding.unverified(`\`${twenty}\` 与 「${twenty}」`, corpus(tool))).toHaveLength(2)
  })

  it('AC-003 reports entities without a source when tools produced output', () => {
    const text = '见 600519.SH 与 000858.SZ，数据在 /data/report.csv，参考《年度报告》和 $NVDA。'
    expect(grounding.unverified(text, corpus(tool))).toEqual([
      { kind: 'entity', text: '000858.SZ' },
      { kind: 'entity', text: '/data/report.csv' },
      { kind: 'entity', text: '年度报告' },
      { kind: 'entity', text: '$NVDA' },
    ])
    expect(grounding.unverified(text, corpus(''))).toEqual([])
  })
})

describe('grounding.sanitize', () => {
  it('AC-004 replaces unverifiable quotes and ungrounded entities without nesting', () => {
    const tool = '路径 /data 下有文件；代码 600519.SH'
    const text =
      '他说“明年将继续保持百分之二十以上的增长”，数据见 /data/report.csv 和 /data/report.csv.bak，代码 600519.SH。'
    expect(grounding.sanitize(text, corpus(tool))).toBe(
      '他说⟨unverifiable⟩，数据见 ⟨ungrounded:/data/report.csv⟩ 和 ⟨ungrounded:/data/report.csv.bak⟩，代码 600519.SH。',
    )
  })

  it('returns the text unchanged when everything is grounded', () => {
    expect(grounding.sanitize('代码 600519.SH', corpus('600519.SH'))).toBe('代码 600519.SH')
  })
})
