// 引用核对（设计 §10.6、§11 文本处理）：引号内 ≥ 20 字节的引文和实体名，在语料中找不到就算无法核实。
// 比较前规范化数字（千分位、小数位、百分号）和单位（万、亿等）。groundingCheck 与 sanitize 共用这里的核对。

import type { Corpus } from '../../sdk.js'

const MIN_QUOTE_BYTES = 20
const QUOTE = /"([^"\n]+)"|“([^”\n]+)”|「([^」\n]+)」|`([^`\n]+)`/g
const UNITS: Record<string, number> = { 万亿: 12, 千万: 7, 百万: 6, 亿: 8, 万: 4, 千: 3 }
const NUMBER_WITH_UNIT = /(\d+(?:\.\d+)?)(万亿|千万|百万|亿|万|千)/g
/** 实体名只取高置信度形式：证券代码、绝对路径、书名号内的名称。 */
const ENTITY_PATTERNS: ReadonlyArray<{ pattern: RegExp; group: number }> = [
  {
    pattern: /\b\d{6}\.(?:SH|SZ|BJ)\b|\b\d{4,5}\.HK\b|\$[A-Z]{1,5}\b|\b[A-Z]{1,5}\.(?:US|N|O)\b/g,
    group: 0,
  },
  { pattern: /(?<![\w./])\/(?:[\w.-]+\/)+[\w.-]+/g, group: 0 },
  { pattern: /《([^》\n]{2,50})》/g, group: 1 },
]

const encoder = new TextEncoder()

/** 按字符串移动小数点：value × 10^exp，不经过浮点。 */
function scale(value: string, exp: number): string {
  const [int = '', frac = ''] = value.split('.')
  const digits = int + frac
  const point = int.length + exp
  const shifted =
    point >= digits.length
      ? digits + '0'.repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`
  return shifted.replace(/^0+(?=\d)/, '')
}

function normalize(text: string): string {
  let s = text.normalize('NFKC').replace(/\s+/g, '')
  let previous: string
  do {
    previous = s
    s = s.replace(/(\d),(\d{3})(?!\d)/g, '$1$2')
  } while (s !== previous)
  s = s.replace(NUMBER_WITH_UNIT, (_m, value: string, unit: string) => scale(value, UNITS[unit]!))
  return s.replace(/(\d+)\.(\d+)/g, (_m, int: string, frac: string) => {
    const trimmed = frac.replace(/0+$/, '')
    return trimmed ? `${int}.${trimmed}` : int
  })
}

const innerOf = (groups: Array<string | undefined>) => groups.find((g) => g !== undefined) ?? ''

function quotes(text: string): string[] {
  return [...text.matchAll(QUOTE)]
    .map((m) => innerOf(m.slice(1)))
    .filter((q) => encoder.encode(q).length >= MIN_QUOTE_BYTES)
}

function entities(text: string): string[] {
  const found: Array<{ index: number; text: string }> = []
  for (const { pattern, group } of ENTITY_PATTERNS) {
    for (const m of text.matchAll(pattern)) found.push({ index: m.index, text: m[group]! })
  }
  found.sort((a, b) => a.index - b.index)
  return [...new Set(found.map((f) => f.text))]
}

function unverified(
  text: string,
  corpus: Corpus,
): Array<{ kind: 'quote' | 'entity'; text: string }> {
  const source = normalize(corpus.sources.map((s) => s.text).join('\n'))
  const missing = (s: string) => !source.includes(normalize(s))
  const items: Array<{ kind: 'quote' | 'entity'; text: string }> = quotes(text)
    .filter(missing)
    .map((q) => ({ kind: 'quote', text: q }))
  // 没有工具输出时没有事实来源，实体核对不适用（Talor quote-verifier 的同一取舍）。
  const hasToolOutput = corpus.sources.some((s) => s.origin === 'tool' && s.text.trim() !== '')
  if (hasToolOutput) {
    for (const e of entities(text).filter(missing)) items.push({ kind: 'entity', text: e })
  }
  return items
}

function sanitize(text: string, corpus: Corpus): string {
  const bad = unverified(text, corpus)
  if (bad.length === 0) return text
  const badQuotes = new Set(bad.filter((b) => b.kind === 'quote').map((b) => b.text))
  const unquoted = text.replace(QUOTE, (match, ...groups: Array<string | undefined>) =>
    badQuotes.has(innerOf(groups.slice(0, 4))) ? '⟨unverifiable⟩' : match,
  )

  // 长实体优先占位，短实体与已选区间重叠时跳过，避免替换进占位符里。
  const ranges: Array<{ start: number; end: number; entity: string }> = []
  const ungrounded = bad
    .filter((b) => b.kind === 'entity')
    .map((b) => b.text)
    .sort((a, b) => b.length - a.length)
  for (const entity of ungrounded) {
    for (
      let at = unquoted.indexOf(entity);
      at !== -1;
      at = unquoted.indexOf(entity, at + entity.length)
    ) {
      const end = at + entity.length
      if (!ranges.some((r) => at < r.end && end > r.start)) ranges.push({ start: at, end, entity })
    }
  }
  ranges.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const r of ranges) {
    out += `${unquoted.slice(cursor, r.start)}⟨ungrounded:${r.entity}⟩`
    cursor = r.end
  }
  return out + unquoted.slice(cursor)
}

export const grounding = { normalize, unverified, sanitize }
