// 标准守卫（方案 §3.2）：封路、失败连击、无新信息、截断、静默推进。阈值由方案 §7 实验校准。

import type { Guard } from '../../contracts/component.js'
import { roadblock } from './roadblock.js'
import { thresholdGuard } from './threshold-guard.js'

export interface GuardThresholds {
  failureStreak: [number, number]
  noNewInfo: [number, number]
  truncation: [number, number]
  /** false 关闭静默推进。 */
  silentProgress: number | false
}

export const DEFAULT_GUARD_THRESHOLDS: GuardThresholds = {
  failureStreak: [2, 3],
  noNewInfo: [3, 8],
  truncation: [1, 3],
  silentProgress: 5,
}

/** 连续若干步工具调用全部失败；子运行失败计 2。 */
export function failureStreak([warn, end] = DEFAULT_GUARD_THRESHOLDS.failureStreak): Guard {
  return thresholdGuard({
    id: 'failure-streak',
    version: '2',
    warn,
    end,
    count: () => (facts) => {
      if (facts.allToolsFailed === null) return 0
      if (!facts.allToolsFailed) return 'reset'
      return facts.toolCalls.some((c) => c.errorCode?.startsWith('SUBAGENT_')) ? 2 : 1
    },
    code: (facts) => {
      const failed = facts.toolCalls.filter((c) => !c.ok)
      const unavailable = failed.filter((c) => c.errorCode === 'TOOL_UNAVAILABLE').length
      return unavailable * 2 > failed.length ? 'external_failure' : 'failure_streak'
    },
    problem: (facts, n) =>
      `连续 ${n} 步工具调用全部失败（${facts.toolCalls
        .filter((c) => !c.ok)
        .map((c) => `${c.name}: ${c.errorCode ?? ''}`)
        .join('，')}）`,
    suggest: (facts) =>
      facts.toolCalls.some((c) => !c.ok && c.errorClass === 'deterministic')
        ? '按错误信息修正参数或前提条件后再调用，或改用其他工具'
        : '依赖暂时不可用：不要用相同输入反复重试，改用其他工具，或基于已有信息作答',
  })
}

/**
 * 连续若干步有调用却没有获得新信息；只调用轮询类工具的步不计。成功执行的副作用算进展：
 * 批量写入每次都返回相同的确认，不是原地打转。
 */
export function noNewInfo([warn, end] = DEFAULT_GUARD_THRESHOLDS.noNewInfo): Guard {
  return thresholdGuard({
    id: 'no-new-info',
    version: '2',
    warn,
    end,
    count: () => (facts) => {
      if (!facts.toolCalls.some((c) => !c.repeatable)) return 0
      const wrote = facts.toolCalls.some((c) => c.ok && c.effect !== 'none')
      return facts.newInformation || wrote ? 'reset' : 1
    },
    code: () => 'stall',
    problem: (_facts, n) => `连续 ${n} 步没有获得新信息`,
    suggest: '换一种查询方式、用 search_tool 找其他工具，或基于已有信息作答',
  })
}

/** 输出连续被截断；到终止阈值收尾，由兜底要一份精简的结果。 */
export function truncation([warn, end] = DEFAULT_GUARD_THRESHOLDS.truncation): Guard {
  return thresholdGuard({
    id: 'truncation',
    version: '2',
    warn,
    end,
    count: () => (facts) => (facts.finishReason === 'length' ? 1 : 'reset'),
    code: () => 'truncated',
    problem: (_facts, n) => `输出连续 ${n} 次被截断`,
    suggest: '大段内容改用写文件的工具输出；精简推理过程；把任务拆成几步完成',
  })
}

/** 连续若干步只调用工具、没有说明进展；只告知。 */
export function silentProgress(at = 5): Guard {
  return thresholdGuard({
    id: 'silent-progress',
    warn: at,
    count: () => (facts) => {
      if (facts.text.trim() !== '') return 'reset'
      return facts.toolCalls.length > 0 ? 1 : 0
    },
    problem: (_facts, n) => `连续 ${n} 步只调用工具、没有说明进展`,
    suggest:
      '先用一两句话说明目前掌握的情况；互不依赖的调用在一次回复里并行发出；信息已经足够就直接作答',
  })
}

export function standardGuards(opts: { thresholds?: Partial<GuardThresholds> } = {}): Guard[] {
  const t: GuardThresholds = { ...DEFAULT_GUARD_THRESHOLDS, ...opts.thresholds }
  return [
    roadblock(),
    failureStreak(t.failureStreak),
    noNewInfo(t.noNewInfo),
    truncation(t.truncation),
    ...(t.silentProgress === false ? [] : [silentProgress(t.silentProgress)]),
  ]
}
