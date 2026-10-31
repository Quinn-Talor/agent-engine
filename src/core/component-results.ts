// 组件返回值的形状校验（设计 §4.4）：返回值不合格即视为组件出错，由调用方按该组件的出错方式降级。
// 每个函数返回问题描述；合格时返回 undefined。testing/conformance.ts 用同一套规则断言守卫意见与权限结果。

const ROLES = new Set(['user', 'assistant', 'system', 'tool'])
const NOTICE_ROLES = new Set(['system', 'user'])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isOptional = (v: unknown, test: (x: unknown) => boolean) => v === undefined || test(v)
const isStringList = (v: unknown) => Array.isArray(v) && v.every(isString)

function blockIssue(b: unknown): string | undefined {
  const ok =
    isObject(b) &&
    isString(b.tool) &&
    isString(b.inputHash) &&
    isString(b.code) &&
    isString(b.reason) &&
    isOptional(b.suggest, isString)
  return ok ? undefined : '封路需要 tool、inputHash、code、reason，suggest 只能是字符串'
}

/** 守卫意见：告知（可带封路）、等待输入、终止三者之一，另可带 detail。 */
export function guardOpinionIssue(value: unknown): string | undefined {
  if (!isObject(value)) return '意见必须是对象'
  const { detail, ...rest } = value
  if (!isOptional(detail, isString)) return 'detail 必须是字符串'
  const keys = Object.keys(rest)
  if (keys.length !== 1) return '意见只能是告知、等待输入或终止之一'
  if ('warn' in rest) {
    const warn = rest.warn
    if (!isObject(warn) || !isString(warn.problem) || warn.problem.length === 0) {
      return '告知需要非空的 problem'
    }
    if (!isOptional(warn.suggest, isString)) return 'suggest 必须是字符串'
    if (warn.block === undefined) return undefined
    if (!Array.isArray(warn.block)) return 'block 必须是数组'
    for (const b of warn.block) {
      const issue = blockIssue(b)
      if (issue) return issue
    }
    return undefined
  }
  if ('awaitInput' in rest) {
    return isObject(rest.awaitInput) && isString(rest.awaitInput.code)
      ? undefined
      : 'awaitInput 需要 code'
  }
  if ('end' in rest) {
    const end = rest.end
    return isObject(end) && (end.as === 'finalize' || end.as === 'stop') && isString(end.code)
      ? undefined
      : 'end 需要 as（finalize 或 stop）与 code'
  }
  return `未知的意见：${keys[0]}`
}

/** 验收结果：pass 为布尔，issues 为字符串数组，hint 为字符串。 */
export function checkResultIssue(value: unknown): string | undefined {
  if (!isObject(value)) return '验收结果必须是对象'
  if (typeof value.pass !== 'boolean') return 'pass 必须是布尔值'
  if (!isOptional(value.issues, isStringList)) return 'issues 必须是字符串数组'
  if (!isOptional(value.hint, isString)) return 'hint 必须是字符串'
  return undefined
}

const messagesIssue = (list: unknown, name: string): string | undefined => {
  if (!Array.isArray(list)) return `${name} 必须是数组`
  const bad = list.findIndex((m) => !isObject(m) || !ROLES.has(m.role as string))
  return bad >= 0 ? `${name}[${bad}] 需要 user、assistant、system 或 tool 的 role` : undefined
}

/** 记忆视图：history 与 transcript 为消息数组；compaction 可选。 */
export function memoryViewIssue(value: unknown): string | undefined {
  if (!isObject(value)) return '记忆视图必须是对象'
  const issue =
    messagesIssue(value.history, 'history') ?? messagesIssue(value.transcript, 'transcript')
  if (issue) return issue
  const c = value.compaction
  if (c === undefined) return undefined
  const ok =
    isObject(c) &&
    Array.isArray(c.replaced) &&
    c.replaced.length === 2 &&
    c.replaced.every((n) => typeof n === 'number') &&
    isString(c.summary) &&
    typeof c.anchorsKept === 'number'
  return ok ? undefined : 'compaction 需要 replaced（两个数字）、summary 与 anchorsKept'
}

/** 权限裁决：'allow'、`{ deny, unavailable? }` 或 `{ ask }`。 */
export function permitResultIssue(value: unknown): string | undefined {
  if (value === 'allow') return undefined
  if (!isObject(value)) return "权限结果只能是 'allow'、{ deny } 或 { ask }"
  if ('deny' in value) {
    if (!isString(value.deny)) return 'deny 必须是字符串'
    return isOptional(value.unavailable, (v) => v === true) ? undefined : 'unavailable 只能是 true'
  }
  if ('ask' in value) {
    const ask = value.ask
    if (!isObject(ask) || !isString(ask.summary)) return 'ask 需要 summary'
    if (ask.risk !== 'low' && ask.risk !== 'high') return 'risk 只能是 low 或 high'
    const d = ask.detail
    if (d === undefined) return undefined
    const ok =
      isObject(d) &&
      isOptional(d.paths, isStringList) &&
      isOptional(d.reason, isString) &&
      isOptional(d.input, isString)
    return ok ? undefined : 'detail 的 paths 为字符串数组，reason、input 为字符串'
  }
  return "权限结果只能是 'allow'、{ deny } 或 { ask }"
}

/** 工具呈现：本步可见的工具名。 */
export function visibleToolsIssue(value: unknown): string | undefined {
  return isStringList(value) ? undefined : '可见工具必须是字符串数组'
}

/** 须知生成：Segment 数组，或 `{ block }` 拦下运行。 */
export function noticeResultIssue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const bad = value.findIndex(
      (s) => !isObject(s) || !NOTICE_ROLES.has(s.role as string) || !Array.isArray(s.parts),
    )
    return bad >= 0 ? `须知必须是 Segment 数组（第 ${bad} 项不合格）` : undefined
  }
  if (isObject(value) && isString(value.block)) return undefined
  return '须知必须是 Segment 数组或 { block }'
}
