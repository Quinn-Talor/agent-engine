// 风险审批（设计 §11）：auto 只记审计；ask-high 询问 high 级工具，并对 low 级工具的参数做兜底正则检查，
// 命中就升级为询问；ask-all 询问全部调用。high 级工具确认摘要为空时直接拒绝。
// 正则对参数里的每个原始字符串逐一检查（不对 JSON 文本检查，换行转义成 `\n` 会让 `\b` 失效）；
// 全是字符串的数组（argv）另外按空格拼起来检查。

import type { PermissionRule } from '../../sdk.js'

const SUMMARY_CHARS = 200
const INPUT_CHARS = 2000
const EMPTY_INPUTS = new Set(['', '{}', '[]', 'null'])

/** 兜底的危险模式：命中即升级为 high 级询问。 */
const DANGEROUS: readonly RegExp[] = [
  /\brm\s+-[a-z]*[rf][a-z]*\b/i,
  /\bsudo\b/,
  /\bmkfs(?:\.\w+)?\b/,
  /\bdd\s+if=/,
  /\bchmod\s+(?:-R\s+)?777\b/,
  /\b(?:curl|wget)\b[^|]*\|\s*(?:ba|z)?sh\b/,
  /\bdrop\s+(?:table|database)\b/i,
  /\btruncate\s+table\b/i,
  /\bgit\s+push\b.*--force\b/,
  /\b(?:shutdown|reboot)\b/,
  />\s*\/dev\/sd[a-z]/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
]

/** 参数里要检查的文本：每个字符串值，以及全是字符串的数组拼成的命令行。 */
function texts(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) {
    if (value.length > 0 && value.every((v) => typeof v === 'string')) out.push(value.join(' '))
    for (const v of value) texts(v, out)
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) texts(v, out)
  }
  return out
}

export function riskApproval(opts: { mode: 'auto' | 'ask-high' | 'ask-all' }): PermissionRule {
  const { mode } = opts
  return {
    id: 'risk-approval',
    version: '1',
    config: { mode },
    async permit(call, _run, ctx) {
      const preview = call.input === undefined ? '' : JSON.stringify(call.input)
      const summary = `${call.toolName} ${preview.slice(0, SUMMARY_CHARS)}`.trim()
      const input = preview.slice(0, INPUT_CHARS)
      if (mode === 'auto') {
        ctx.log('info', `审计：${summary}`)
        return 'allow'
      }
      if (call.risk === 'high') {
        if (EMPTY_INPUTS.has(preview)) return { deny: '高风险调用缺少可确认的参数' }
        return { ask: { summary, risk: 'high', detail: { input } } }
      }
      const values = texts(call.input)
      const hit = DANGEROUS.find((re) => values.some((v) => re.test(v)))
      if (hit) {
        return {
          ask: {
            summary,
            risk: 'high',
            detail: { input, reason: `参数命中危险模式：${hit.source}` },
          },
        }
      }
      if (mode === 'ask-all') return { ask: { summary, risk: 'low', detail: { input } } }
      return 'allow'
    },
  }
}
