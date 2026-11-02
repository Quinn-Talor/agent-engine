// 指纹（设计 §6.4）：Agent、任务、执行环境、引擎；能力快照指纹由各能力在准备环节产出。

import type { AgentDef, Deliverable } from '../../contracts/agent.js'
import type { JsonValue } from '../../contracts/common.js'
import type { Check, Component, Guard, NoticeProvider } from '../../contracts/component.js'
import type { EnvironmentConfig } from '../../contracts/environment.js'
import type { TaskDef } from '../../contracts/task.js'
import { hashOf } from './hash.js'

interface Identifiable {
  id: string
  version: string
  mode?: string
  config?: JsonValue
}

export type ComponentIdentity = { id: string; version: string; mode: string; config: string }

/** 组件身份：id、版本、模式与配置哈希（方案 D14）。 */
export function componentIdentity(c: Identifiable): ComponentIdentity {
  return {
    id: c.id,
    version: c.version,
    mode: c.mode ?? 'active',
    config: hashOf(c.config ?? null),
  }
}

function guardIdentity(g: Guard): JsonValue {
  return { ...componentIdentity(g), onError: g.onError ?? 'ignore' }
}

function checkIdentity(c: Check): JsonValue {
  return { ...componentIdentity(c), maxAttempts: c.maxAttempts ?? null }
}

function deliverableIdentity(d: Deliverable): JsonValue {
  return {
    output: {
      ...componentIdentity(d.output),
      kind: d.output.kind,
      maxRepairs: d.output.maxRepairs ?? null,
    },
    checks: (d.checks ?? []).map(checkIdentity),
    fallback: d.fallback ? hashOf(d.fallback) : null,
  }
}

/** Agent 指纹：`version` 只是业务标签，不参与。 */
export function agentFingerprint(def: AgentDef): string {
  return hashOf({
    id: def.id,
    instructions: hashOf(def.instructions),
    capabilities: (def.capabilities ?? []).map((c) => ({
      id: c.id,
      kind: c.kind,
      version: c.version,
      config: hashOf(c.config ?? null),
    })),
    exposure: def.toolbox?.exposure ? componentIdentity(def.toolbox.exposure) : 'default',
    deliverable: def.deliverable ? deliverableIdentity(def.deliverable) : 'default',
    model: { prefer: def.model?.prefer ?? null, requires: def.model?.requires ?? null },
  })
}

/** 任务指纹：做的是什么；不含易变信息与归属。 */
export function taskFingerprint(def: TaskDef): string {
  return hashOf({
    input: hashOf(def.input),
    history: hashOf(def.history ?? []),
    context: def.context ?? null,
    deliverable: def.deliverable ? deliverableIdentity(def.deliverable) : null,
    goal: def.goal ?? null,
    guards: (def.guards ?? []).map(guardIdentity),
    budget: def.budget ?? null,
    scope: def.scope ?? null,
  })
}

/** 须知项是生成器（有 provide 方法），否则是固定片段。 */
export function isNoticeProvider(n: unknown): n is NoticeProvider {
  return typeof (n as { provide?: unknown }).provide === 'function'
}

/** 执行环境指纹：规矩本身；审批由应用实现，不参与。 */
export function environmentFingerprint(config: EnvironmentConfig): string {
  return hashOf({
    name: config.name,
    principalReachable: config.principal.reachable,
    notice: (config.notice ?? []).map((n) =>
      isNoticeProvider(n) ? { provider: componentIdentity(n) } : { segment: hashOf(n) },
    ),
    permissions: (config.permissions ?? []).map(componentIdentity),
    guards: (config.guards ?? []).map(guardIdentity),
    checks: (config.checks ?? []).map(checkIdentity),
    caps: config.caps ?? null,
  })
}

/**
 * 引擎指纹：记忆与守卫，以及引擎替 Agent 补上的默认交付物和工具呈现（Agent 指纹里只记
 * `default`）。默认交付物换了（例如加上完成审查），指纹就跟着变。
 */
export function engineFingerprint(m: {
  memory: Component
  guards: readonly Guard[]
  deliverable?: Deliverable
  exposure?: Component
}): string {
  return hashOf({
    memory: componentIdentity(m.memory),
    guards: m.guards.map(guardIdentity),
    ...(m.deliverable ? { deliverable: deliverableIdentity(m.deliverable) } : {}),
    ...(m.exposure ? { exposure: componentIdentity(m.exposure) } : {}),
  })
}
