// 跑一遍全部场景，打印办案记录和结果。先构建再运行（Node ≥ 22.18 直接执行 TypeScript）：
//   npm run demo:legal

import { retrospect, retrospective, supervisionStats } from '@talor/agent-engine'
import type { Opinion } from './domain.ts'
import { createLegalPlatform } from './platform.ts'
import { SCENARIOS } from './scenarios.ts'

const only = process.argv[2]

for (const scenario of SCENARIOS.filter((s) => !only || s.id === only)) {
  const p = await createLegalPlatform()
  try {
    console.log(`\n══ ${scenario.title}（${scenario.id}）`)
    console.log(`   演示：${scenario.shows.join('、')}\n`)
    const runs = await scenario.run(p)
    for (const line of p.audit) console.log(line)

    const last = runs.at(-1)!
    const { result } = last
    console.log(`\n结果：${result.status}${result.code ? `（${result.code}）` : ''}`)
    const opinion = result.output as Opinion | undefined
    if (opinion) {
      console.log(`意见：${opinion.summary}`)
      for (const a of opinion.analysis) console.log(`  · ${a.issue}：${a.citations.join('、')}`)
      if (opinion.compensation) console.log(`  · 经济补偿：${opinion.compensation.amount} 元`)
      console.log(`  · 下一步：${opinion.nextSteps.join('；')}`)
    } else if (result.text && (result.status !== 'stopped' || result.code === 'notice_blocked')) {
      console.log(`答复：${result.text}`)
    }
    if (result.status === 'awaiting_input' && result.intent) {
      console.log(`等待委托人：${JSON.stringify(result.intent.input)}`)
    }
    for (const l of p.outbox) console.log(`已发律师函：${l.recipient}，${l.amount} 元`)
    for (const r of p.reviews)
      console.log(`律师复核：${r.reviewer} ${r.approved ? '批准' : '驳回'} ${r.tool}`)
    const stats = supervisionStats(last.events)
    console.log(
      `用量：${result.steps} 步，${result.toolCalls} 次工具调用，费用 $${(result.cost ?? 0).toFixed(4)}`,
    )
    const warns = Object.entries(stats.warns).map(([source, n]) => `${source} ${n} 次`)
    console.log(
      `监督：告知 ${warns.join('、') || '无'}；纠偏消息 ${stats.steering} 条；验收退回 ${stats.checks.returned} 次；导出 span ${p.spans.length} 个`,
    )
    if (result.status !== 'completed') {
      console.log(`\n复盘（下次运行可以带上）：\n${retrospect.brief(retrospective(last.events))}`)
    }
  } finally {
    await p.shutdown()
  }
}
