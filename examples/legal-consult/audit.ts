// 审计订阅者：把运行日志翻译成律所能看懂的办案记录。运行日志是唯一的事实来源，
// 这里只做投影，不改运行；订阅时传 { children: true } 一并收到子运行（委托的案例检索）。

import type { RunEvent, RunSubscriber, Verdict } from 'agent-engine'

const clip = (s: string, n = 60) => {
  const line = s.replace(/\s*\n\s*/g, ' ')
  return line.length > n ? `${line.slice(0, n)}…` : line
}

const verdictOf = (v: Verdict): string =>
  'continue' in v
    ? '继续'
    : 'complete' in v
      ? '完成'
      : 'awaitInput' in v
        ? `等待委托人（${v.awaitInput.code}）`
        : 'finalize' in v
          ? `收尾（${v.finalize.code}）`
          : `停止（${v.stop.code}）`

export function auditTrail(lines: string[]): RunSubscriber {
  const toolNames = new Map<string, string>()
  let root: string | undefined
  return {
    onEvent(e: RunEvent, run) {
      root ??= run.runId
      const indent = run.runId === root ? '' : '    [子运行] '
      const add = (line: string) => lines.push(indent + line)
      switch (e.t) {
        case 'run_started':
          add(`▶ 开始：${e.agent.id}，模型 ${e.model}`)
          break
        case 'model_responded': {
          const { text, toolCalls } = e.response
          for (const c of toolCalls) toolNames.set(c.id, c.name)
          const calls = toolCalls.map((c) => c.name).join('、')
          add(
            `第 ${e.step} 步 模型：${clip(text) || '（无文本）'}${calls ? ` → 调用 ${calls}` : ''}`,
          )
          break
        }
        case 'permission_decided': {
          const v = e.verdict
          const name = toolNames.get(e.callId) ?? e.callId
          if (v === 'allow') break
          add(
            'deny' in v
              ? `  权限：${name} 被 ${e.source} 拒绝：${v.deny}`
              : `  权限：${name} 需要审批（${e.source}）`,
          )
          break
        }
        case 'approval_answered':
          add(`  审批：${toolNames.get(e.callId) ?? e.callId} ${e.approved ? '已批准' : '被驳回'}`)
          break
        case 'tool_finished':
          if (e.isError)
            add(`  工具：${toolNames.get(e.callId) ?? e.callId} 出错 ${e.errorCode ?? ''}`)
          break
        case 'evaluated': {
          for (const o of e.opinions) {
            const op = o.opinion
            if (!op) continue
            if ('continue' in op) {
              // 告知：干预里的提示进纠偏消息，封路封住同样的调用。
              for (const i of op.continue.interventions ?? []) {
                add(
                  'hint' in i
                    ? `  监督：${o.source} 告知：${clip(i.hint.text.replace(/^-\s*/, ''), 40)}`
                    : `  监督：${o.source} 封路：${i.block.tool}（${clip(i.block.reason, 30)}）`,
                )
              }
            } else add(`  监督：${o.source} → ${verdictOf({ ...op, sources: [] })}`)
          }
          if (!('continue' in e.verdict)) add(`  判定：${verdictOf(e.verdict)}`)
          break
        }
        case 'delivery_checked': {
          const failed = [
            ...(e.output.ok ? [] : [`输出：${(e.output.issues ?? []).join('；')}`]),
            ...e.checks
              .filter((c) => !c.pass)
              .map((c) => `${c.source}：${(c.issues ?? []).join('；')}`),
          ]
          add(
            `  交付第 ${e.attempt} 次（${e.path === 'normal' ? '正常' : '兜底'}）→ ${e.outcome}` +
              (failed.length ? `，问题：${clip(failed.join(' | '), 120)}` : ''),
          )
          break
        }
        case 'run_ended':
          add(`■ 结束：${e.result.status}${e.result.code ? `（${e.result.code}）` : ''}`)
          break
      }
    },
  }
}
