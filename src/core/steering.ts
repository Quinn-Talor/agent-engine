// 纠偏消息（方案 §4.2）：每步最多一条，由核心渲染。目标、发现、封路、剩余预算、复盘要求与出口，
// 让模型知道哪里偏了、哪些路不通、还剩多少、可以怎么收。纯函数，重放时可以重算。
// 每条封路带着自己的原因和建议列在封路清单里，发现里不再重复。

import type { CallBlock } from '../contracts/component.js'

export const MAX_STEERING_CHARS = 2000

/** 单条发现的上限：一个守卫的长文本（例如 hook 的 stderr）不能挤掉其他守卫的发现。 */
const MAX_FINDING_CHARS = 400
const MAX_GOAL_CHARS = 200
const MAX_REASON_CHARS = 80
const MAX_BLOCK_LINES = 5
/** 依赖环境状态的封路的行尾说明（F25）。 */
const LIFTS_ON_CHANGE = '（写操作成功后解除）'

export interface SteeringInput {
  step: number
  goal?: string
  /** 已渲染的发现，见 `renderFinding`。 */
  findings: string[]
  blocks: CallBlock[]
  stepsLeft?: number
  timeLeftMs?: number
  /** 本次运行可用的等待输入意图工具。 */
  askTool?: string
  /** 本次运行可用的停止意图工具。 */
  stopTool?: string
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

export function renderFinding(
  warn: { problem: string; suggest?: string },
  detail?: string,
): string {
  return clip(
    `- ${warn.problem}${detail ? `（${detail}）` : ''}${warn.suggest ? `\n  建议：${warn.suggest}` : ''}`,
    MAX_FINDING_CHARS,
  )
}

export function renderSteering(input: SteeringInput): string {
  const lines = [`[纠偏 · 第 ${input.step} 步]`]
  if (input.goal) lines.push(`目标：${input.goal.slice(0, MAX_GOAL_CHARS)}`)
  lines.push('发现：', ...input.findings)
  if (input.blocks.length > 0) {
    lines.push('已封住（再调用将收尾）：')
    for (const b of input.blocks.slice(0, MAX_BLOCK_LINES)) {
      const suggest = b.suggest ? `；建议：${b.suggest.slice(0, MAX_REASON_CHARS)}` : ''
      const lift = b.clearOnChange ? LIFTS_ON_CHANGE : ''
      lines.push(`- ${b.tool}：${b.reason.slice(0, MAX_REASON_CHARS)}${suggest}${lift}`)
    }
    if (input.blocks.length > MAX_BLOCK_LINES) {
      lines.push(`- 另有 ${input.blocks.length - MAX_BLOCK_LINES} 个`)
    }
  }
  // 剩余预算、复盘要求与出口总是完整保留；超长时截的是前面的正文。
  const tail: string[] = []
  if (input.stepsLeft !== undefined) {
    const time =
      input.timeLeftMs !== undefined && input.timeLeftMs > 0
        ? `，时间 ${Math.floor(input.timeLeftMs / 1000)} 秒`
        : ''
    tail.push(`剩余：步数 ${input.stepsLeft}${time}`)
  }
  tail.push('继续之前，请先用一两句话写明：已经确认了什么、还缺什么、下一步打算怎么做。')
  tail.push(
    '出口：现有信息已经足够就直接给出结果' +
      (input.askTool ? `；缺少关键信息可以用 ${input.askTool} 询问委托人` : '') +
      (input.stopTool ? `；确实无法完成，用 ${input.stopTool} 说明原因` : '') +
      '。',
  )
  const end = tail.join('\n')
  return `${clip(lines.join('\n'), MAX_STEERING_CHARS - end.length - 1)}\n${end}`
}
