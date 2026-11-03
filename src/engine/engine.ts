// 引擎装配（设计 §1.2、§2）：平台服务与运行机制、执行环境、运行登记、健康状态、关闭与中断补齐、
// 会话的预览与删除（会话方案 §4、§13）。
// 默认组件由调用方给出（方案 D10）：`index.ts` 的 createEngine 用标准组件补齐。

import type { Deliverable } from '../contracts/agent.js'
import type { Clock, Logger } from '../contracts/common.js'
import type { Exposure, Fallback, Guard, Memory } from '../contracts/component.js'
import type { Engine, EngineConfig, EngineHealth } from '../contracts/engine.js'
import type { Environment, EnvironmentConfig } from '../contracts/environment.js'
import { DefinitionError, toolError } from '../contracts/errors.js'
import type { ArchiveStore, RunEvent } from '../contracts/events.js'
import type { RunResult, RunSummary } from '../contracts/run.js'
import {
  engineFingerprint,
  environmentFingerprint,
  isNoticeProvider,
} from '../core/definition/fingerprint.js'
import { freezeList, frozenCopy } from '../core/definition/freeze.js'
import { foldState } from '../core/log/projections.js'
import { estimateMessages } from '../core/run/estimate.js'
import { apply } from '../core/run/state.js'
import { normalizeOutput } from '../executor/act/exec.js'
import { createAdmission } from '../services/admission.js'
import { systemClock } from '../services/clock.js'
import { delegationHost } from '../services/hosts/delegation-host.js'
import { memoryArchive } from '../services/memory-archive.js'
import { deriveWindow } from '../services/session-log.js'
import { skillHost } from '../services/hosts/skill-host.js'
import {
  startRun,
  type EngineRuntime,
  type EnvironmentRuntime,
  type StartedRun,
} from './run/run-driver.js'

export interface EngineDefaults {
  memory: Memory
  guards: Guard[]
  deliverable: Deliverable & { fallback: Fallback }
  exposure: Exposure
  logger: Logger
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const id of ids) (seen.has(id) ? dup : seen).add(id)
  return [...dup]
}

const isPositiveInteger = (v: number) => Number.isInteger(v) && v > 0

function environmentIssues(config: EnvironmentConfig): string[] {
  const issues: string[] = []
  if (typeof config.name !== 'string' || config.name.length === 0)
    issues.push('name 必须是非空字符串')
  const ids: Array<[string, Array<{ id: string }>]> = [
    ['权限规则', config.permissions ?? []],
    ['守卫', config.guards ?? []],
    ['强制验收', config.checks ?? []],
    ['须知生成器', (config.notice ?? []).filter(isNoticeProvider)],
  ]
  for (const [label, list] of ids) {
    for (const id of duplicates(list.map((c) => c.id))) issues.push(`${label} id 重复：${id}`)
  }
  const caps = config.caps ?? {}
  const integers: Array<[string, number | undefined]> = [
    ['toolConcurrency', caps.toolConcurrency],
    ['maxConcurrentRuns', caps.maxConcurrentRuns],
    ['delegation.depth', caps.delegation?.depth],
    ['delegation.perAgent', caps.delegation?.perAgent],
    ['delegation.concurrency', caps.delegation?.concurrency],
  ]
  for (const [name, v] of integers) {
    if (v !== undefined && !isPositiveInteger(v)) issues.push(`caps.${name} 必须是正整数`)
  }
  const numbers: Array<[string, number | undefined]> = [
    ['approvalTimeoutMs', caps.approvalTimeoutMs],
    ['childDeliveryWaitMs', caps.childDeliveryWaitMs],
    ...Object.entries(caps.budget ?? {}).map(([k, v]): [string, number | undefined] => [
      `budget.${k}`,
      v,
    ]),
  ]
  for (const [name, v] of numbers) {
    if (v !== undefined && !(Number.isFinite(v) && v > 0)) issues.push(`caps.${name} 必须是正数`)
  }
  return issues
}

/** 中断补齐（设计 §3.12）：为没有 run_ended 的运行补上 TOOL_INTERRUPTED 结果与 run_ended。 */
async function recoverInterrupted(
  archive: ArchiveStore,
  clock: Clock,
  logger: Logger,
): Promise<RunSummary[]> {
  try {
    const open = (await archive.query({})).filter((s) => s.status === undefined)
    for (const summary of open) {
      const events: RunEvent[] = []
      for await (const e of archive.read(summary.runId)) events.push(e)
      const state = foldState(events)
      const last = events.at(-1)
      let seq = last?.seq ?? 0
      const at = Math.max(clock.now(), last?.at ?? 0)
      // 只看最后一次模型回复之后的结果：提供方可能跨步复用调用 id（与不变量 I2 按步检查一致）。
      const respondedAt = events.findLastIndex((e) => e.t === 'model_responded')
      const responded = events[respondedAt]
      const finished = new Set(
        events.slice(respondedAt + 1).flatMap((e) => (e.t === 'tool_finished' ? [e.callId] : [])),
      )
      const pending =
        responded?.t === 'model_responded'
          ? responded.response.toolCalls.filter((c) => !finished.has(c.id))
          : []
      const added: RunEvent[] = []
      if (pending.length > 0) {
        const { shown } = normalizeOutput(
          {
            error: toolError(
              'TOOL_INTERRUPTED',
              '进程中断，调用结果未知；如有副作用，可能已经执行',
            ),
          },
          undefined,
          (text) => text,
        )
        const ref = await archive.putBlob(shown)
        for (const c of pending) {
          const meta = state.tools[c.name]
          added.push({
            t: 'tool_finished',
            callId: c.id,
            capability: meta?.capability ?? '',
            effect: meta?.effect ?? 'side_effect',
            shown: ref,
            isError: true,
            errorCode: 'TOOL_INTERRUPTED',
            startedAt: at,
            durationMs: 0,
            seq: ++seq,
            at,
          })
        }
      }
      const after = added.reduce(apply, state)
      const result: RunResult = {
        runId: summary.runId,
        status: 'aborted',
        code: 'interrupted',
        model: after.model ?? summary.model,
        usage: after.usage,
        steps: after.step,
        toolCalls: after.toolCallCount,
      }
      added.push({ t: 'run_ended', result, seq: ++seq, at })
      await archive.append(summary.runId, added)
    }
    const ids = new Set(open.map((s) => s.runId))
    return (await archive.query({})).filter((s) => ids.has(s.runId))
  } catch (error) {
    logger.log({ level: 'error', message: '补齐中断运行失败', detail: { error: String(error) } })
    return []
  }
}

/**
 * 执行环境"长期、不可变"（设计 §1.1、I14）：复制一份再冻结，之后改动传入的配置不影响运行。
 * 数据（须知片段、上限）逐层冻结；组件列表冻结一层；委托人的审批方与各组件对象原样保留。
 */
export function freezeEnvironment(config: EnvironmentConfig): EnvironmentConfig {
  const notice = config.notice?.map((item) => (isNoticeProvider(item) ? item : frozenCopy(item)))
  return Object.freeze({
    ...config,
    principal: Object.freeze({ ...config.principal }),
    ...(notice ? { notice: freezeList(notice) } : {}),
    ...(config.permissions ? { permissions: freezeList(config.permissions) } : {}),
    ...(config.guards ? { guards: freezeList(config.guards) } : {}),
    ...(config.checks ? { checks: freezeList(config.checks) } : {}),
    ...(config.caps ? { caps: frozenCopy(config.caps) } : {}),
  })
}

export function assembleEngine(config: EngineConfig, defaults: EngineDefaults): Engine {
  const { services } = config
  const memory = config.memory ?? defaults.memory
  // 复制一份再冻结（I14）：之后改动传入的守卫列表不影响引擎。
  const guards = freezeList(config.guards ?? defaults.guards)
  // 总带 skill 宿主和委托调度（设计 §2）；传入的宿主加在后面，同一种类的替换默认的。
  // 只传了 MCP 连接池时，skill 与委托不会因此悄悄失效。
  const given = services.hosts ?? []
  const defaultsKept = [skillHost(), delegationHost()].filter(
    (h) => !given.some((g) => g.kind === h.kind),
  )
  const hostList = [...defaultsKept, ...given]

  const issues = [
    ...duplicates(guards.map((g) => g.id)).map((id) => `守卫 id 重复：${id}`),
    ...duplicates(hostList.map((h) => h.kind)).map((kind) => `能力宿主重复：${kind}`),
  ]
  if (issues.length > 0) throw new DefinitionError('invalid_engine', issues)

  const clock = services.clock ?? systemClock()
  const archive = services.archive ?? memoryArchive({ clock })
  const logger = services.logger ?? defaults.logger
  const admission = createAdmission({ ...services.admission, clock })
  const fingerprint = engineFingerprint({
    memory,
    guards,
    deliverable: defaults.deliverable,
    exposure: defaults.exposure,
  })
  const environments = new WeakMap<Environment, EnvironmentRuntime>()
  const active = new Set<StartedRun>()
  let closed = false

  const recovery = recoverInterrupted(archive, clock, logger)
  const runtime: EngineRuntime = {
    hub: services.models,
    archive,
    clock,
    logger,
    admission,
    hosts: new Map(hostList.map((h) => [h.kind, h])),
    ...(services.vault ? { vault: services.vault } : {}),
    memory,
    guards,
    defaults: { deliverable: defaults.deliverable, exposure: defaults.exposure },
    fingerprint,
    environmentOf: (e) => environments.get(e),
    sessions: new Map(),
    recovered: recovery,
  }
  const health = (): EngineHealth => ({
    breakers: [...services.models.health(), ...hostList.flatMap((h) => h.health?.() ?? [])],
    admission: admission.status(),
  })

  return {
    fingerprint,
    environment(envInput) {
      const envConfig = freezeEnvironment(envInput)
      const envIssues = environmentIssues(envConfig)
      if (envIssues.length > 0) throw new DefinitionError('invalid_environment', envIssues)
      const envFingerprint = environmentFingerprint(envConfig)
      const handle: Environment = {
        name: envConfig.name,
        fingerprint: envFingerprint,
        start(agent, task, assignment) {
          const started = startRun(runtime, env, {
            agent,
            task,
            ...(assignment ? { assignment } : {}),
            ...(closed ? { refuse: { code: 'engine_error', message: '引擎已关闭' } } : {}),
          })
          active.add(started)
          void started.run.result.then(() => active.delete(started))
          return started.run
        },
      }
      const env: EnvironmentRuntime = { config: envConfig, fingerprint: envFingerprint, handle }
      environments.set(handle, env)
      return handle
    },
    interrupted: () => recovery,
    async previewWindow(q) {
      // 正在运行的轮还没有结局，从它推导出的窗口不是下一轮真正会带入的。
      if (runtime.sessions.has(q.session)) {
        return { ok: false, code: 'session_busy', message: `会话 ${q.session} 有一轮正在运行` }
      }
      await recovery
      const r = await deriveWindow(archive, q)
      if (!r.ok) return { ok: false, code: 'invalid_task', message: r.message }
      const d = r.derived
      return {
        ok: true,
        turn: d.turn,
        ...(d.continues ? { continues: d.continues.runId } : {}),
        messages: d.window.messages,
        ...(d.window.summary !== undefined ? { summary: d.window.summary } : {}),
        ledger: d.ledger,
        ledgerOmitted: d.omitted,
        tokens: estimateMessages(d.window.messages),
      }
    },
    async deleteSession(session) {
      // 占住会话再删：正在受理的轮还没有写进档案，档案自己看不到它。
      if (runtime.sessions.has(session)) {
        return { ok: false, code: 'session_busy', message: `会话 ${session} 有一轮正在运行` }
      }
      runtime.sessions.set(session, `delete:${session}`)
      try {
        await recovery
        return { ok: true, ...(await archive.deleteSession(session)) }
      } catch (error) {
        // 档案拒绝删除：会话里有没结束的运行（例如 run_ended 没写进档案）。
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('没结束')) throw error
        return { ok: false, code: 'session_open', message }
      } finally {
        runtime.sessions.delete(session)
      }
    },
    health,
    onHealth(fn) {
      const notify = () => fn(health())
      const offs = [
        services.models.onHealth(notify),
        ...hostList.flatMap((h) => (h.onHealth ? [h.onHealth(notify)] : [])),
      ]
      return () => {
        for (const off of offs) off()
      }
    },
    async shutdown() {
      closed = true
      const running = [...active]
      for (const r of running) r.stop('shutdown')
      await Promise.all(running.map((r) => r.run.result))
      for (const host of hostList) await host.shutdown?.()
    },
  }
}
