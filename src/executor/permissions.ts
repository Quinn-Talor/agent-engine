// 工具流水线 e 环节（设计 §9.10）：权限规则的组合与委托人审批。
// 任一拒绝即拒绝；没有拒绝但有询问时合并成一次审批；联系不上或没有审批时询问按拒绝；规则出错按拒绝。

import type { Clock } from '../contracts/common.js'
import type {
  Approver,
  AskRequest,
  ComponentCtx,
  PermissionRule,
  PermitResult,
  RunInfo,
} from '../contracts/component.js'
import { toolError, type ToolErrorEnvelope } from '../contracts/errors.js'
import type { RunEventBody } from '../contracts/events.js'
import type { ToolCallView } from '../contracts/tool.js'
import { permitResultIssue } from '../core/component-results.js'
import { callComponent, failureDetail } from './call-component.js'
import type { Mutex } from './mutex.js'

export interface PermissionDeps {
  rules: readonly PermissionRule[]
  approver?: Approver
  principalReachable: boolean
  approvalTimeoutMs: number
  run: RunInfo
  ctxFor(source: string): ComponentCtx
  clock: Clock
  approvals: Mutex
  componentTimeoutMs?: number
  /** 运行的取消信号：取消后等待中与排队中的审批立即结束（设计 §3.14）。 */
  signal?: AbortSignal
}

export type PermissionOutcome = { events: RunEventBody[] } & (
  { allowed: true } | { allowed: false; error: ToolErrorEnvelope }
)

// 规则或委托人拒绝后不能引导"换个做法"：实测模型据此用 bash 写了 hook 禁止的文件（F24）。
const POLICY_DENIED_HINT =
  '这是规则的限制：不要重试，也不要换工具或换写法去做同一件事；向委托人说明被拒绝的原因，或只做不受限制的部分'
const USER_DENIED_HINT =
  '委托人拒绝了这个操作：不要重试，也不要换工具或换写法去做同一件事；改做其他部分，或向委托人说明'
const APPROVAL_FAILED_HINT =
  '这个操作没有得到审批：不要反复请求，改用其他做法，或说明需要委托人审批'

function mergeAsks(asks: AskRequest[]): AskRequest {
  const paths = [...new Set(asks.flatMap((a) => a.detail?.paths ?? []))]
  const reasons = asks.map((a) => a.detail?.reason).filter((r): r is string => !!r)
  const input = asks.find((a) => a.detail?.input !== undefined)?.detail?.input
  const detail: NonNullable<AskRequest['detail']> = {}
  if (paths.length > 0) detail.paths = paths
  if (reasons.length > 0) detail.reason = reasons.join('；')
  if (input !== undefined) detail.input = input
  const merged: AskRequest = {
    summary: asks.map((a) => a.summary).join('；'),
    risk: asks.some((a) => a.risk === 'high') ? 'high' : 'low',
  }
  if (Object.keys(detail).length > 0) merged.detail = detail
  return merged
}

export async function checkPermission(
  call: ToolCallView,
  deps: PermissionDeps,
): Promise<PermissionOutcome> {
  const events: RunEventBody[] = []
  const denies: Array<{ reason: string; unavailable: boolean }> = []
  const asks: AskRequest[] = []

  for (const rule of deps.rules) {
    const ctx = deps.ctxFor(`permission:${rule.id}`)
    const outcome = await callComponent(() => rule.permit(call, deps.run, ctx), {
      clock: deps.clock,
      timeoutMs: deps.componentTimeoutMs,
      validate: permitResultIssue,
    })
    // 出错与返回值不合格同样处理（设计 §4.4）：拒绝，按规则没能判断的暂时性故障报。
    let verdict: PermitResult
    if (outcome.ok) {
      verdict = outcome.value
    } else {
      const reason = `权限规则 ${rule.id} 出错`
      const why = outcome.invalid ? `：返回值不合格：${outcome.invalid.issue}` : ''
      ctx.log('warn', `${reason}${why}`, failureDetail(outcome))
      verdict = { deny: reason, unavailable: true }
    }
    const shadow = rule.mode === 'shadow'
    events.push({
      t: 'permission_decided',
      callId: call.callId,
      verdict,
      source: shadow ? `shadow:${rule.id}` : rule.id,
    })
    if (shadow || verdict === 'allow') continue
    if ('deny' in verdict) denies.push({ reason: verdict.deny, unavailable: !!verdict.unavailable })
    else asks.push(verdict.ask)
  }

  if (denies.length > 0) {
    // 有明确的拒绝就按拒绝报；全是规则没能判断的，按暂时性故障报（不第一次就封路）。
    const firm = denies.find((d) => !d.unavailable)
    return {
      events,
      allowed: false,
      error: firm
        ? toolError('PERMISSION_DENIED', `权限拒绝：${firm.reason}`, POLICY_DENIED_HINT)
        : toolError('PERMISSION_UNAVAILABLE', `权限拒绝：${denies[0]!.reason}`),
    }
  }
  if (asks.length === 0) return { events, allowed: true }
  const approver = deps.approver
  if (!deps.principalReachable || !approver) {
    return {
      events,
      allowed: false,
      error: toolError('PERMISSION_DENIED', '需要委托人审批，但委托人联系不上或没有配置审批'),
    }
  }

  const request = { ...mergeAsks(asks), callId: call.callId, toolName: call.toolName }
  return deps.approvals.run(async () => {
    const start = deps.clock.now()
    const outcome = await callComponent(() => approver.approve(request, deps.run), {
      clock: deps.clock,
      timeoutMs: deps.approvalTimeoutMs,
      ...(deps.signal ? { signal: deps.signal } : {}),
    })
    const waitedMs = deps.clock.now() - start
    if (!outcome.ok) {
      events.push({ t: 'approval_answered', callId: call.callId, approved: false, waitedMs })
      // 取消：排在后面的审批不再发给委托人，按取消的调用处理。
      if (deps.signal?.aborted) {
        return { events, allowed: false, error: toolError('TOOL_ABORTED', '运行已取消') }
      }
      // 没有回应、审批服务出错都不是委托人拒绝，按暂时性故障报。
      return {
        events,
        allowed: false,
        error: outcome.timedOut
          ? toolError('APPROVAL_TIMEOUT', '委托人没有在时限内回应审批', APPROVAL_FAILED_HINT)
          : toolError(
              'APPROVAL_UNAVAILABLE',
              `审批出错：${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
              APPROVAL_FAILED_HINT,
            ),
      }
    }
    const answer = outcome.value
    events.push({
      t: 'approval_answered',
      callId: call.callId,
      approved: answer.approved,
      ...(answer.remember ? { remember: answer.remember } : {}),
      waitedMs,
    })
    return answer.approved
      ? { events, allowed: true }
      : {
          events,
          allowed: false,
          error: toolError('USER_DENIED', '委托人拒绝了这个操作', USER_DENIED_HINT),
        }
  })
}
