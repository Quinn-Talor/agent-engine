// hook 适配（设计 §9.10）：把 Claude Code 格式的 hook 翻译成须知、权限、守卫和强制验收。
// SessionStart、UserPromptSubmit → 须知（UserPromptSubmit 可以拦下运行）；PreToolUse → 权限；
// PostToolUse → 成功调用后的"继续 + 提示"；Stop → 根运行的强制验收（gate）；SubagentStop → 子运行的强制验收；
// PreCompact、Notification 交还应用。MCP 工具按 Claude Code 的命名 `mcp__<服务器>__<工具>` 匹配与上报；
// 应用可以用 toolView 把工具名与输入映射成 hook 期望的形状（例如 Claude Code 的 `Write`、`file_path`）。
// 每次执行都经 ctx.record(…, { kind: 'hook' }) 留痕（方案 D12）。

import type {
  Check,
  ComponentCtx,
  Guard,
  HookResult,
  HookRunner,
  HookSpec,
  NoticeProvider,
  PermissionRule,
  RunInfo,
} from '../../api.js'

const DEFAULT_TIMEOUT_MS = 10_000
const INPUT_CHARS = 2000
const CONTINUE_HINT = 'hook 要求继续'
const BLOCKED = 'hook 拦下了这次运行'

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const stringOf = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const specificOf = (r: HookResult): Record<string, unknown> =>
  isObject(r.json?.hookSpecificOutput) ? r.json.hookSpecificOutput : {}

/** 预览完整时按 JSON 解析，被截断或不是 JSON 时原样作为字符串。 */
function previewValue(preview: string | undefined): unknown {
  if (preview === undefined) return ''
  try {
    return JSON.parse(preview) as unknown
  } catch {
    return preview
  }
}

/** hook 看到的工具名：MCP 能力（`mcp:<服务器>`）的工具按 Claude Code 命名为 `mcp__<服务器>__<工具>`。 */
function hookToolName(capability: string, name: string): string {
  if (!capability.startsWith('mcp:')) return name
  const server = capability.slice('mcp:'.length)
  return name.startsWith(`${server}__`) ? `mcp__${name}` : `mcp__${server}__${name}`
}

/** hook 看到的工具名与输入。 */
export interface HookToolView {
  toolName: string
  input: unknown
}

type ToolView = (view: HookToolView) => HookToolView

/** 经应用的映射得到 hook 看到的视图；映射出错时按原名与原输入执行并记警告。 */
function viewOf(
  base: HookToolView,
  toolView: ToolView | undefined,
  ctx: ComponentCtx,
): HookToolView {
  if (!toolView) return base
  try {
    return toolView(base)
  } catch (error) {
    ctx.log('warn', 'hook 工具视图出错，按原名执行', {
      error: error instanceof Error ? error.message : String(error),
    })
    return base
  }
}

/** matcher 缺省、空或 `*` 匹配全部；否则为锚定正则，不合法时按字面全等。 */
function matches(matcher: string | undefined, name: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(name)
  } catch {
    return matcher === name
  }
}

function identity(spec: HookSpec, index: number) {
  return {
    id: `hook:${spec.event}:${index}`,
    version: '1',
    config: {
      command: spec.command,
      matcher: spec.matcher ?? null,
      timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      source: spec.source ?? null,
    },
  }
}

function runHook(
  ctx: ComponentCtx,
  spec: HookSpec,
  run: RunInfo,
  fields: Record<string, unknown>,
): Promise<HookResult> {
  const workspace = run.task.scope?.workspace
  const input = {
    session_id: run.task.subject ?? run.runId,
    transcript_path: '',
    cwd: workspace ?? process.cwd(),
    hook_event_name: spec.event,
    ...fields,
  }
  return ctx.record(
    `hook:${spec.event}`,
    () =>
      // 运行取消时 hook 进程随之终止，不等超时（设计 §3.1）。
      ctx.host<HookRunner>('hook').run(spec, input, {
        ...(workspace ? { cwd: workspace } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
    { kind: 'hook' },
  )
}

function noticeProvider(spec: HookSpec, index: number): NoticeProvider {
  return {
    ...identity(spec, index),
    async provide(run, ctx) {
      const fields =
        spec.event === 'SessionStart' ? { source: 'startup' } : { prompt: run.task.input ?? '' }
      // Claude Code 语义：只有 UserPromptSubmit 能用 exit 2 或 decision: block 拦下；continue: false 都生效。
      const canBlock = spec.event === 'UserPromptSubmit'
      // 拦截类 hook 没能给出判断（跑不起来、超时、被结束）时拦下，和 PreToolUse 的拒绝一致；
      // SessionStart 只提供须知，跑不起来只记日志。
      let r: HookResult
      try {
        r = await runHook(ctx, spec, run, fields)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (canBlock) return { block: `UserPromptSubmit hook 没能运行，拦下这次运行：${message}` }
        ctx.log('warn', `hook ${spec.event} 没能运行：${message}`)
        return []
      }
      if (canBlock && r.timedOut) return { block: 'UserPromptSubmit hook 超时，拦下这次运行' }
      if (canBlock && r.exitCode === null) {
        return { block: 'UserPromptSubmit hook 没有正常结束，拦下这次运行' }
      }
      if (canBlock && r.exitCode === 2) return { block: r.stderr.trim() || BLOCKED }
      if (r.exitCode !== 0) {
        ctx.log('warn', `hook ${spec.event} 退出码 ${r.exitCode}`, { stderr: r.stderr })
        return []
      }
      if (r.json) {
        if (r.json.continue === false) return { block: stringOf(r.json.stopReason) || BLOCKED }
        if (canBlock && r.json.decision === 'block') {
          return { block: stringOf(r.json.reason) || BLOCKED }
        }
      }
      // JSON 输出只取 additionalContext；纯文本输出整段作为须知。
      const text = r.json ? stringOf(specificOf(r).additionalContext)?.trim() : r.stdout.trim()
      return text ? [{ role: 'system', parts: [{ type: 'text', text }] }] : []
    },
  }
}

function permissionRule(spec: HookSpec, index: number, toolView?: ToolView): PermissionRule {
  return {
    ...identity(spec, index),
    async permit(call, run, ctx) {
      const view = viewOf(
        { toolName: hookToolName(call.capability, call.toolName), input: call.input },
        toolView,
        ctx,
      )
      if (!matches(spec.matcher, view.toolName)) return 'allow'
      // 权限规则出错按拒绝处理（设计 §4.4）：进程起不来、超时或被信号结束都拒绝。
      let r: HookResult
      try {
        r = await runHook(ctx, spec, run, { tool_name: view.toolName, tool_input: view.input })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { deny: `hook 执行失败，拒绝 ${call.toolName}：${message}`, unavailable: true }
      }
      // hook 没能给出判断：照样拒绝，但按暂时性故障处理。
      if (r.timedOut) return { deny: `hook 超时，拒绝 ${call.toolName}`, unavailable: true }
      if (r.exitCode === null) {
        return { deny: `hook 没有正常结束，拒绝 ${call.toolName}`, unavailable: true }
      }
      const refused = `hook 拒绝了 ${call.toolName}`
      if (r.exitCode === 2) return { deny: r.stderr.trim() || refused }
      // 其他退出码是 Claude Code 的非阻断错误：放行并记警告。
      if (r.exitCode !== 0) {
        ctx.log('warn', `hook ${spec.event} 退出码 ${r.exitCode}`, { stderr: r.stderr })
        return 'allow'
      }
      const specific = specificOf(r)
      const decision = stringOf(specific.permissionDecision)
      const reason = stringOf(specific.permissionDecisionReason) ?? stringOf(r.json?.reason)
      if (decision === 'deny' || r.json?.decision === 'block') return { deny: reason || refused }
      if (decision === 'ask') {
        return {
          ask: {
            summary: reason || `${call.toolName} 需要确认`,
            risk: 'high',
            detail: { input: JSON.stringify(call.input ?? null).slice(0, INPUT_CHARS) },
          },
        }
      }
      return 'allow'
    },
  }
}

function processGuard(spec: HookSpec, index: number, toolView?: ToolView): Guard {
  return {
    ...identity(spec, index),
    start: (run, ctx) => ({
      async check(facts) {
        const hints: string[] = []
        // Claude Code 只在工具成功后触发 PostToolUse。
        for (const call of facts.toolCalls.filter((c) => c.ok)) {
          const view = viewOf(
            {
              toolName: hookToolName(call.capability, call.name),
              input: previewValue(call.inputPreview),
            },
            toolView,
            ctx,
          )
          if (!matches(spec.matcher, view.toolName)) continue
          const r = await runHook(ctx, spec, run, {
            tool_name: view.toolName,
            tool_input: view.input,
            tool_response: previewValue(call.outputPreview),
          })
          if (r.exitCode === 2) hints.push(r.stderr.trim())
          else if (r.exitCode === 0 && r.json?.decision === 'block') {
            hints.push(stringOf(r.json.reason) ?? CONTINUE_HINT)
          } else if (r.exitCode === 0) {
            const context = stringOf(specificOf(r).additionalContext)
            if (context) hints.push(context)
          }
        }
        const problem = hints.filter(Boolean).join('\n')
        return problem ? { warn: { problem } } : undefined
      },
    }),
  }
}

function stopCheck(spec: HookSpec, index: number): Check {
  return {
    ...identity(spec, index),
    mode: 'gate',
    start: (run, ctx) => {
      // Stop 只约束根运行，SubagentStop 只约束子运行。
      const applies = (spec.event === 'SubagentStop') === (run.parentRunId !== undefined)
      // 本次运行里已经拦过一次后，stop_hook_active 为 true，hook 据此避免无限续跑。
      let blockedBefore = false
      return {
        async accept(candidate) {
          if (!applies) return { pass: true }
          const r = await runHook(ctx, spec, run, {
            stop_hook_active: blockedBefore,
            last_message: candidate.text ?? '',
          })
          const reason =
            r.exitCode === 2
              ? r.stderr.trim()
              : r.exitCode === 0 && r.json?.decision === 'block'
                ? (stringOf(r.json.reason) ?? '')
                : undefined
          if (reason === undefined) return { pass: true }
          blockedBefore = true
          const text = reason || CONTINUE_HINT
          return { pass: false, issues: [text], hint: text }
        },
      }
    },
  }
}

export function adaptHooks(
  specs: HookSpec[],
  opts: { toolView?: (view: HookToolView) => HookToolView } = {},
): {
  notice: NoticeProvider[]
  permissions: PermissionRule[]
  guards: Guard[]
  checks: Check[]
  /** PreCompact、Notification：只作为通知交给应用。 */
  notifications: HookSpec[]
} {
  const counts = new Map<HookSpec['event'], number>()
  const adapted = {
    notice: [] as NoticeProvider[],
    permissions: [] as PermissionRule[],
    guards: [] as Guard[],
    checks: [] as Check[],
    notifications: [] as HookSpec[],
  }
  for (const spec of specs) {
    const index = counts.get(spec.event) ?? 0
    counts.set(spec.event, index + 1)
    switch (spec.event) {
      case 'SessionStart':
      case 'UserPromptSubmit':
        adapted.notice.push(noticeProvider(spec, index))
        break
      case 'PreToolUse':
        adapted.permissions.push(permissionRule(spec, index, opts.toolView))
        break
      case 'PostToolUse':
        adapted.guards.push(processGuard(spec, index, opts.toolView))
        break
      case 'Stop':
      case 'SubagentStop':
        adapted.checks.push(stopCheck(spec, index))
        break
      case 'PreCompact':
      case 'Notification':
        adapted.notifications.push(spec)
        break
    }
  }
  return adapted
}
