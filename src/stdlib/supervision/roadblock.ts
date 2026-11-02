// 封路（方案 §3.2）：同一个调用（工具名 + 输入哈希）不会再有不同结果时封住它。
// 确定性错误一次就封；有副作用且结果未知（可能已经执行）的一次就封；瞬时错误第 2 次失败才封；相同输入两次返回相同结果封；
// 有副作用的操作以相同输入第 2 次成功后封（比方案原文收紧，见 F18 规格 §B.2）。
// 轮询类工具、意图工具（交付退回后会以相同输入再调）与撞上封路的调用不记账。

import type { CallBlock, Guard, GuardOpinion } from '../../contracts/component.js'

interface CallRecord {
  failures: number
  lastOutput?: string
  successes: number
  blocked: boolean
}

/** 按错误给建议：参数错就修参数，被拒绝或没权限就别重试、也别换做法绕过，暂时不可用就别用相同输入重试。 */
function failureSuggest(code: string, deterministic: boolean): string {
  if (code === 'INVALID_INPUT') return '按错误信息修正参数后再调用：输入不同就不受封路影响'
  if (code === 'PERMISSION_DENIED')
    return '被规则拒绝：不要重试，也不要换工具或换写法去做同一件事；向委托人说明原因，或只做不受限制的部分'
  if (code === 'USER_DENIED')
    return '委托人拒绝了这个操作：不要重试，也不要换工具或换写法去做同一件事；改做其他部分，或询问委托人'
  if (code.startsWith('SPAWN_')) return '子任务无法启动；自己完成，或调整委托方式'
  return deterministic
    ? '换一种做法，或改用其他工具'
    : '暂时不可用，不要用相同输入重试；改用其他工具，或基于已有信息作答'
}

function failureCode(code: string): string {
  if (code === 'USER_DENIED') return 'user_denied'
  if (code.startsWith('SPAWN_')) return 'spawn_failed'
  if (code === 'TOOL_UNAVAILABLE') return 'external_failure'
  return 'failure_streak'
}

export function roadblock(): Guard {
  return {
    id: 'roadblock',
    version: '3',
    start() {
      const calls = new Map<string, CallRecord>()
      return {
        check(facts): GuardOpinion | undefined {
          const dead: CallBlock[] = []
          for (const c of facts.toolCalls) {
            if (c.blocked || c.repeatable || c.intentTool) continue
            const key = `${c.name}|${c.inputHash}`
            const r = calls.get(key) ?? { failures: 0, successes: 0, blocked: false }
            calls.set(key, r)
            if (r.blocked) continue
            let block: Omit<CallBlock, 'tool' | 'inputHash'> | undefined
            if (!c.ok) {
              r.failures += 1
              const code = c.errorCode ?? ''
              if (c.possiblyExecuted) {
                // 副作用可能已经执行：相同输入再调一次可能重复执行（I15）。
                block = {
                  code: failureCode(code),
                  reason: `结果未知（${code}），可能已经执行`,
                  suggest: '先核实是否已经执行（例如查询状态），不要用相同输入重试',
                }
              } else if (c.errorClass === 'deterministic') {
                block = {
                  code: failureCode(code),
                  reason: `确定性错误 ${code}，同样的输入会得到同样的结果`,
                  suggest: failureSuggest(code, true),
                }
              } else if (r.failures >= 2) {
                block = {
                  code: failureCode(code),
                  reason: `已失败 ${r.failures} 次（${code}）`,
                  suggest: failureSuggest(code, false),
                }
              }
            } else {
              r.successes += 1
              if (c.effect === 'side_effect' && r.successes >= 2) {
                block = {
                  code: 'repeat',
                  reason: '有副作用的操作已用相同输入成功执行 2 次',
                  suggest: '不要重复执行；需要结果时引用上一次的输出',
                }
              } else if (r.lastOutput === c.outputHash) {
                block = {
                  code: 'repeat',
                  reason: '连续 2 次返回相同结果',
                  suggest: '结果没有变化，不要再用相同输入调用；基于已有结果决定下一步',
                }
              }
              r.lastOutput = c.outputHash
            }
            if (block) {
              r.blocked = true
              dead.push({ tool: c.name, inputHash: c.inputHash, ...block })
            }
          }
          if (dead.length === 0) return undefined
          return {
            warn: {
              problem: `${dead.length} 个调用不会再有不同结果，已封住`,
              suggest: [...new Set(dead.map((b) => b.suggest))].join('；'),
              block: dead,
            },
            detail: dead.map((b) => `${b.tool}: ${b.reason}`).join('；'),
          }
        },
      }
    },
  }
}
