// 标准兜底（设计 §11）：各收尾 code 的说明，分委托人联系得上和联系不上两个版本（设计 §3.11）。

import type { Fallback } from '../../contracts/component.js'

/** 结局为 finalized 的收尾 code（设计 §3.12）。 */
export const FINALIZE_CODES = [
  'repeat',
  'failure_streak',
  'stall',
  'no_progress',
  'max_steps',
  'timeout',
  'empty_output',
  'user_denied',
  'spawn_failed',
  'external_failure',
  'truncated',
] as const

const REASONS: Record<(typeof FINALIZE_CODES)[number] | '*', string> = {
  repeat: '运行反复执行相同的操作，没有进展。',
  failure_streak: '工具连续失败。',
  stall: '连续多步没有获得新信息。',
  no_progress: '计划项长时间没有推进。',
  max_steps: '步数已用完。',
  timeout: '时间即将用完。',
  empty_output: '没有给出有效的交付内容。',
  user_denied: '委托人拒绝了关键操作。',
  spawn_failed: '委托的子任务失败。',
  external_failure: '依赖的外部服务不可用。',
  truncated: '回答多次超出长度被截断，请精简篇幅，只写结论和关键依据。',
  '*': '任务没有完成。',
}

const REACHABLE =
  '请总结已经完成的部分和卡点，最后向委托人提出一个能让工作继续的具体问题，以问号结尾。'
const UNREACHABLE = '请报告已经完成的部分、卡点，以及已执行的操作。'

export function standardFallback(): Fallback {
  return {
    instructions: Object.fromEntries(
      Object.entries(REASONS).map(([code, reason]) => [
        code,
        { reachable: reason + REACHABLE, unreachable: reason + UNREACHABLE },
      ]),
    ),
    fixedText: '任务未能完成，已停止。请查看运行记录了解已完成的部分和已执行的操作。',
  }
}
