// 复盘说明（设计 §10.8）：由复盘确定性地生成一段文本——上次试了什么、卡在哪里、已执行的副作用，
// 供应用追加到重跑任务的输入里。

import type { RunRetrospective } from '../../sdk.js'

const RECENT_STEPS = 10
const SIGNAL_NAMES = { warn: '告知', end: '终止', awaitInput: '等待输入' } as const

function toolsLine(tools: RunRetrospective['steps'][number]['tools']): string {
  if (tools.length === 0) return '只回复了文本'
  const groups: Array<{ name: string; count: number; failures: string[] }> = []
  for (const t of tools) {
    let group = groups.find((g) => g.name === t.name)
    if (!group) {
      group = { name: t.name, count: 0, failures: [] }
      groups.push(group)
    }
    group.count += 1
    if (!t.ok) group.failures.push(t.errorCode ?? '出错')
  }
  return groups
    .map((g) => {
      const name = g.count > 1 ? `${g.name} ×${g.count}` : g.name
      return g.failures.length > 0 ? `${name}（失败：${g.failures.join('、')}）` : name
    })
    .join('、')
}

function brief(retro: RunRetrospective): string {
  const end = retro.end
  const outcome = end ? `${end.status}${end.code ? `（${end.code}）` : ''}` : '未结束'
  const lines = [
    '【上次运行的复盘】',
    `结局：${outcome}；${retro.steps.length} 步，${retro.toolCalls} 次工具调用。`,
    '试过的做法：',
    ...retro.steps.slice(-RECENT_STEPS).map((s) => `- 第 ${s.step} 步：${toolsLine(s.tools)}`),
    '卡住的地方：',
  ]
  const lastSignal = new Map<
    string,
    Extract<RunRetrospective['timeline'][number], { kind: 'signal' }>
  >()
  for (const entry of retro.timeline) {
    if (entry.kind !== 'signal') continue
    lastSignal.delete(entry.source)
    lastSignal.set(entry.source, entry)
  }
  if (lastSignal.size === 0) lines.push('- 没有守卫发出信号')
  for (const t of lastSignal.values()) {
    lines.push(
      `- ${t.source}（第 ${t.step} 步，${SIGNAL_NAMES[t.signal]}）${t.detail ? `：${t.detail}` : ''}`,
    )
  }
  lines.push('已执行的副作用：')
  if (retro.sideEffects.length === 0) lines.push('- 无')
  for (const s of retro.sideEffects) {
    const note = s.status === 'possibly_executed' ? '（可能已执行）' : ''
    lines.push(`- ${s.toolName} ${JSON.stringify(s.input)}${note}`)
  }
  lines.push('接着做时先核实"可能已执行"的操作，不要重复已经完成的副作用。')
  return lines.join('\n')
}

export const retrospect = { brief }
