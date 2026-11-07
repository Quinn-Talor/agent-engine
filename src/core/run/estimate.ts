// 全局唯一的 token 估算器（设计 §8.6）：超限检查、记忆和监督开销上限共用。

import type { ModelMessage } from '../../contracts/common.js'
import type { ModelCapabilities, ModelToolSpec } from '../../contracts/model.js'
import { fileTokens, imageTokens } from './media-tokens.js'

// 中日韩字符的码点区间：CJK 标点、假名、扩展 A、基本汉字、韩文音节、兼容汉字、全角形式。
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x303f],
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
]
const CJK_WEIGHT = 0.67
const OTHER_WEIGHT = 0.25
const MIN_CALIBRATION = 0.5
const MAX_CALIBRATION = 2

const isCjk = (cp: number): boolean => CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)

// 浮点累加的微小误差不应让向上取整多出 1；结果不出现 -0。
const roundUp = (raw: number): number => Math.max(0, Math.ceil(raw - 1e-9))

function rawText(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (isCjk(ch.codePointAt(0) ?? 0)) cjk += 1
    else other += 1
  }
  return cjk * CJK_WEIGHT + other * OTHER_WEIGHT
}

function rawMessage(message: ModelMessage): number {
  if (typeof message.content === 'string') return rawText(message.content)
  let total = 0
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
      case 'reasoning':
        total += rawText(part.text)
        break
      case 'image':
        total += imageTokens(part.image)
        break
      case 'file':
        total += fileTokens(part, rawText)
        break
      case 'tool-call':
        total += rawText(part.toolName + JSON.stringify(part.input))
        break
      case 'tool-result':
        total += rawText(part.output)
        for (const image of part.images ?? []) total += imageTokens(image.image)
        break
    }
  }
  return total
}

export function estimateText(text: string): number {
  return roundUp(rawText(text))
}

export function estimateMessages(messages: readonly ModelMessage[]): number {
  return roundUp(messages.reduce((sum, m) => sum + rawMessage(m), 0))
}

export function estimateTools(tools: readonly ModelToolSpec[]): number {
  return roundUp(
    tools.reduce(
      (sum, t) => sum + rawText(t.name + t.description + JSON.stringify(t.inputSchema)),
      0,
    ),
  )
}

/** 用上一次的实际输入量校准，系数限定在 0.5–2 之间。 */
export function nextCalibration(prev: number, estimate: number, actual: number): number {
  if (actual <= 0 || estimate <= 0) return prev
  return Math.min(MAX_CALIBRATION, Math.max(MIN_CALIBRATION, (prev * actual) / estimate))
}

/** 输出预留：模型声明的输出上限，最多取窗口的一半（设计 §3.5）；输入上限 = 窗口 − 输出预留。 */
export function outputReserveOf(
  caps: Pick<ModelCapabilities, 'contextLimit' | 'maxOutputTokens'>,
): number {
  return Math.min(caps.maxOutputTokens, Math.floor(caps.contextLimit / 2))
}
