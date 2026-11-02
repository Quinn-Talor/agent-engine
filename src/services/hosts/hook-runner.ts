// hook 执行器（设计 §8.3、§5.5）：按 Claude Code hook 协议执行 hook 命令——输入为 JSON，
// 退出码 0 成功（stdout 可为 JSON 对象），2 为阻断，其他为非阻断错误；默认超时 10 秒。
// 进程由端口 HookExec 执行，进程适配器由包入口装配（方案 D10）。

import type { CapabilityHost, HookExec, HookExecResult } from '../../contracts/capability.js'
import type { HookSpec } from '../../contracts/component.js'

const DEFAULT_TIMEOUT_MS = 10_000

export interface HookResult extends HookExecResult {
  /** 退出码 0 且 stdout 是 JSON 对象时的解析结果。 */
  json?: Record<string, unknown>
}

export interface HookRunner extends CapabilityHost {
  readonly kind: 'hook'
  run(
    spec: HookSpec,
    input: Record<string, unknown>,
    opts?: { signal?: AbortSignal; cwd?: string },
  ): Promise<HookResult>
}

function jsonOf(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim()
  if (!text.startsWith('{')) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export function createHookRunner(opts: { exec: HookExec }): HookRunner {
  return {
    kind: 'hook',
    async run(spec, input, runOpts = {}) {
      const result = await opts.exec(spec.command, JSON.stringify(input), {
        timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(runOpts.signal ? { signal: runOpts.signal } : {}),
        ...(runOpts.cwd ? { cwd: runOpts.cwd } : {}),
      })
      const json = result.exitCode === 0 ? jsonOf(result.stdout) : undefined
      return json ? { ...result, json } : result
    },
  }
}
