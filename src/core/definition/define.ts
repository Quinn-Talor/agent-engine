// 定义函数：校验 Agent 与任务定义，计算指纹（设计 §2、§3.3、§4.3）。
// 校验收集全部问题后一次性报告（BR-002）。

import type { Agent, AgentDef, Deliverable } from '../../contracts/agent.js'
import type { ModelMessage, Segment } from '../../contracts/common.js'
import type { Guard } from '../../contracts/component.js'
import { DefinitionError } from '../../contracts/errors.js'
import type { Task, TaskDef } from '../../contracts/task.js'
import { agentFingerprint, taskFingerprint } from './fingerprint.js'
import { freezeList, frozenCopy } from './freeze.js'
import { canonicalJson } from './hash.js'

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/
const SEGMENT_ROLES = new Set(['system', 'user'])
const PART_TYPES = new Set(['text', 'image', 'file'])
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool'])
const OUTPUT_KINDS = new Set(['text', 'structured'])
const CHECK_MODES = new Set(['gate', 'annotate', 'shadow'])

type Issues = string[]

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isFunction = (v: unknown): boolean => typeof v === 'function'
const isInteger = (v: unknown, min: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= min
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!isObject(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function duplicates(ids: unknown[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string') continue
    if (seen.has(id)) dup.add(id)
    seen.add(id)
  }
  return [...dup]
}

function requireFields(
  value: unknown,
  label: string,
  fields: Array<[string, 'string' | 'function']>,
  issues: Issues,
): boolean {
  if (!isObject(value)) {
    issues.push(`${label} 不是对象`)
    return false
  }
  for (const [field, kind] of fields) {
    const ok = kind === 'string' ? isNonEmptyString(value[field]) : isFunction(value[field])
    if (!ok) issues.push(`${label} 缺少 ${field}`)
  }
  return true
}

function checkSegments(segments: unknown, label: string, issues: Issues): void {
  if (!Array.isArray(segments)) {
    issues.push(`${label} 必须是数组`)
    return
  }
  segments.forEach((seg: Segment, i) => {
    const at = `${label}[${i}]`
    if (!isObject(seg)) {
      issues.push(`${at} 不是对象`)
      return
    }
    if (!SEGMENT_ROLES.has(seg.role)) issues.push(`${at} role 不合法`)
    if (!Array.isArray(seg.parts) || seg.parts.length === 0) {
      issues.push(`${at} parts 不能为空`)
      return
    }
    seg.parts.forEach((part, j) => {
      if (!isObject(part) || !PART_TYPES.has(part.type)) {
        issues.push(`${at}.parts[${j}] 类型不合法`)
      } else if (part.type === 'text' && typeof part.text !== 'string') {
        issues.push(`${at}.parts[${j}] text 必须是字符串`)
      }
    })
  })
}

function checkDeliverable(d: Deliverable, label: string, issues: Issues): void {
  if (!isObject(d)) {
    issues.push(`${label} 不是对象`)
    return
  }
  const output = `${label}.output`
  if (
    requireFields(
      d.output,
      output,
      [
        ['id', 'string'],
        ['version', 'string'],
        ['validate', 'function'],
      ],
      issues,
    )
  ) {
    if (!OUTPUT_KINDS.has(d.output.kind)) issues.push(`${output}.kind 不合法`)
    if (d.output.maxRepairs !== undefined && !isInteger(d.output.maxRepairs, 0)) {
      issues.push(`${output}.maxRepairs 必须是 ≥ 0 的整数`)
    }
  }
  const checks = d.checks ?? []
  checks.forEach((c, i) => {
    const at = `${label}.checks[${i}]`
    if (
      requireFields(
        c,
        at,
        [
          ['id', 'string'],
          ['version', 'string'],
          ['start', 'function'],
        ],
        issues,
      )
    ) {
      if (!CHECK_MODES.has(c.mode)) issues.push(`${at}.mode 不合法`)
      if (c.maxAttempts !== undefined && !isInteger(c.maxAttempts, 1)) {
        issues.push(`${at}.maxAttempts 必须是 ≥ 1 的整数`)
      }
    }
  })
  for (const id of duplicates(checks.map((c) => (isObject(c) ? c.id : undefined)))) {
    issues.push(`验收 id 重复：${id}`)
  }
  if (d.fallback !== undefined) {
    const fb = `${label}.fallback`
    if (!isNonEmptyString(d.fallback.fixedText)) issues.push(`${fb}.fixedText 必须是非空字符串`)
    for (const [code, text] of Object.entries(d.fallback.instructions ?? {})) {
      if (typeof text?.reachable !== 'string' || typeof text?.unreachable !== 'string') {
        issues.push(`${fb}.instructions.${code} 必须含 reachable 与 unreachable`)
      }
    }
  }
}

export function defineAgent(def: AgentDef): Agent {
  const issues: Issues = []
  if (typeof def.id !== 'string' || !AGENT_ID.test(def.id)) issues.push('id 不合法')
  if (def.version !== undefined && !isNonEmptyString(def.version)) {
    issues.push('version 必须是非空字符串')
  }
  if (!Array.isArray(def.instructions) || def.instructions.length === 0) {
    issues.push('instructions 不能为空')
  } else {
    checkSegments(def.instructions, 'instructions', issues)
  }
  const capabilities = def.capabilities ?? []
  capabilities.forEach((c, i) =>
    requireFields(
      c,
      `capabilities[${i}]`,
      [
        ['id', 'string'],
        ['version', 'string'],
        ['kind', 'string'],
        ['prepare', 'function'],
      ],
      issues,
    ),
  )
  for (const id of duplicates(capabilities.map((c) => (isObject(c) ? c.id : undefined)))) {
    issues.push(`能力 id 重复：${id}`)
  }
  if (def.toolbox?.exposure !== undefined) {
    requireFields(
      def.toolbox.exposure,
      'toolbox.exposure',
      [
        ['id', 'string'],
        ['version', 'string'],
        ['start', 'function'],
      ],
      issues,
    )
  }
  if (def.deliverable !== undefined) checkDeliverable(def.deliverable, 'deliverable', issues)
  const minContext = def.model?.requires?.minContext
  if (minContext !== undefined && !isInteger(minContext, 1)) {
    issues.push('model.requires.minContext 必须是正整数')
  }
  const temperature = def.model?.settings?.temperature
  if (
    temperature !== undefined &&
    !(Number.isFinite(temperature) && temperature >= 0 && temperature <= 2)
  ) {
    issues.push('model.settings.temperature 必须是 0 到 2 之间的数')
  }
  const topP = def.model?.settings?.topP
  if (topP !== undefined && !(Number.isFinite(topP) && topP > 0 && topP <= 1)) {
    issues.push('model.settings.topP 必须大于 0、不超过 1')
  }

  let fingerprint = ''
  if (issues.length === 0) {
    try {
      fingerprint = agentFingerprint(def)
    } catch (error) {
      issues.push(`配置不可序列化：${(error as Error).message}`)
    }
  }
  if (issues.length > 0) throw new DefinitionError('invalid_agent', issues)
  // 复制一份再冻结（I14）：之后改动传入的数组不影响 Agent；能力等组件对象本身不冻结。
  return Object.freeze({
    ...def,
    instructions: frozenCopy(def.instructions),
    ...(def.capabilities ? { capabilities: freezeList(def.capabilities) } : {}),
    ...(def.toolbox ? { toolbox: Object.freeze({ ...def.toolbox }) } : {}),
    ...(def.deliverable ? { deliverable: frozenDeliverable(def.deliverable) } : {}),
    ...(def.model ? { model: frozenCopy(def.model) } : {}),
    fingerprint,
  })
}

/** 交付物：外层复制后冻结，验收列表冻结一层；输出契约与兜底是组件，原样保留。 */
const frozenDeliverable = (d: Deliverable): Deliverable =>
  Object.freeze({ ...d, ...(d.checks ? { checks: freezeList(d.checks) } : {}) })

function checkHistory(history: ModelMessage[], issues: Issues): void {
  let pending = new Set<string>()
  const flush = () => {
    if (pending.size > 0) issues.push(`工具调用 ${[...pending].join(', ')} 缺少结果`)
    pending = new Set()
  }
  history.forEach((message, i) => {
    if (!isObject(message) || !MESSAGE_ROLES.has(message.role)) {
      issues.push(`history[${i}] role 不合法`)
      return
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      flush()
      for (const part of message.content) {
        if (part.type === 'tool-call') pending.add(part.toolCallId)
      }
    } else if (message.role === 'tool') {
      for (const part of message.content) {
        if (pending.has(part.toolCallId)) pending.delete(part.toolCallId)
        else issues.push(`多余的工具结果：${part.toolCallId}`)
      }
    } else {
      flush()
    }
  })
  flush()
  try {
    canonicalJson(history)
  } catch {
    issues.push('history 含非 JSON 值')
  }
}

function checkBudget(budget: NonNullable<TaskDef['budget']>, issues: Issues): void {
  const { maxSteps, maxTotalMs, finalizeReserveMs, maxInputTokens, maxCost } = budget
  if (maxSteps !== undefined && !isInteger(maxSteps, 1)) {
    issues.push('budget.maxSteps 必须是 ≥ 1 的整数')
  }
  if (maxInputTokens !== undefined && !isInteger(maxInputTokens, 1)) {
    issues.push('budget.maxInputTokens 必须是 ≥ 1 的整数')
  }
  if (maxTotalMs !== undefined && !(isFiniteNumber(maxTotalMs) && maxTotalMs > 0)) {
    issues.push('budget.maxTotalMs 必须是 > 0 的有限数')
  }
  if (maxCost !== undefined && !(isFiniteNumber(maxCost) && maxCost > 0)) {
    issues.push('budget.maxCost 必须是 > 0 的有限数')
  }
  if (
    finalizeReserveMs !== undefined &&
    !(isFiniteNumber(finalizeReserveMs) && finalizeReserveMs >= 0)
  ) {
    issues.push('budget.finalizeReserveMs 必须是 ≥ 0 的有限数')
  }
  if (
    isFiniteNumber(maxTotalMs) &&
    isFiniteNumber(finalizeReserveMs) &&
    finalizeReserveMs >= maxTotalMs
  ) {
    issues.push('budget.finalizeReserveMs 必须小于 maxTotalMs')
  }
}

/** 守卫：必填字段、onError 取值、id 不重复（执行环境与引擎复用）。 */
export function checkGuards(guards: readonly Guard[], issues: Issues): void {
  guards.forEach((g, i) => {
    requireFields(
      g,
      `guards[${i}]`,
      [
        ['id', 'string'],
        ['version', 'string'],
        ['start', 'function'],
      ],
      issues,
    )
    const onError = isObject(g) ? (g as { onError?: unknown }).onError : undefined
    if (onError !== undefined && onError !== 'ignore' && onError !== 'stop') {
      issues.push(`guards[${i}].onError 必须是 ignore 或 stop`)
    }
  })
  for (const id of duplicates(guards.map((g) => (isObject(g) ? g.id : undefined)))) {
    issues.push(`守卫 id 重复：${id}`)
  }
}

export function defineTask(def: TaskDef): Task {
  const issues: Issues = []
  if (!Array.isArray(def.input) || def.input.length === 0) {
    issues.push('input 不能为空')
  } else {
    checkSegments(def.input, 'input', issues)
  }
  if (def.history !== undefined) checkHistory(def.history, issues)
  if (def.volatile !== undefined) checkSegments(def.volatile, 'volatile', issues)
  const workspace = def.scope?.workspace
  if (
    workspace !== undefined &&
    !(typeof workspace === 'string' && ABSOLUTE_PATH.test(workspace))
  ) {
    issues.push('workspace 必须是绝对路径')
  }
  if (def.context !== undefined) {
    let ok = isPlainObject(def.context)
    if (ok) {
      try {
        canonicalJson(def.context)
      } catch {
        ok = false
      }
    }
    if (!ok) issues.push('context 必须是 JSON 对象')
  }
  if (def.deliverable !== undefined) checkDeliverable(def.deliverable, 'deliverable', issues)
  if (def.goal !== undefined && !isNonEmptyString(def.goal)) {
    issues.push('goal 必须是非空字符串')
  }
  if (def.guards !== undefined) checkGuards(def.guards, issues)
  if (def.budget !== undefined) checkBudget(def.budget, issues)
  if (def.subject !== undefined && !isNonEmptyString(def.subject)) {
    issues.push('subject 必须是非空字符串')
  }
  for (const [key, value] of Object.entries(def.tags ?? {})) {
    if (typeof value !== 'string') issues.push(`tags.${key} 必须是字符串`)
  }

  let fingerprint = ''
  if (issues.length === 0) {
    try {
      fingerprint = taskFingerprint(def)
    } catch (error) {
      issues.push(`配置不可序列化：${(error as Error).message}`)
    }
  }
  if (issues.length > 0) throw new DefinitionError('invalid_task', issues)
  // 复制一份再冻结（I14）：数据逐层冻结，守卫列表冻结一层。
  return Object.freeze({
    ...def,
    input: frozenCopy(def.input),
    ...(def.history ? { history: frozenCopy(def.history) } : {}),
    ...(def.volatile ? { volatile: frozenCopy(def.volatile) } : {}),
    ...(def.scope ? { scope: frozenCopy(def.scope) } : {}),
    ...(def.context ? { context: frozenCopy(def.context) } : {}),
    ...(def.deliverable ? { deliverable: frozenDeliverable(def.deliverable) } : {}),
    ...(def.guards ? { guards: freezeList(def.guards) } : {}),
    ...(def.budget ? { budget: frozenCopy(def.budget) } : {}),
    ...(def.tags ? { tags: frozenCopy(def.tags) } : {}),
    fingerprint,
  })
}
