// hook 进程适配器（设计 §5.5）：hook 在独立进程里执行，只通过标准输入输出交互；带超时，
// 超时或取消时先 SIGTERM、1 秒后 SIGKILL，结束整个进程组；输出各保留前 1MB。
// 环境变量只给白名单（与 stdio MCP 一致），宿主进程里的凭据不会传给 hook 命令。

import { spawn } from 'node:child_process'
import { abortError } from '../../sdk.js'
import type { HookExec } from '../../sdk.js'

const MAX_OUTPUT_BYTES = 1_048_576
const KILL_GRACE_MS = 1000
// 与 MCP SDK 给 stdio 服务器的默认白名单一致（sudo 的做法）。
const INHERITED_ENV = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']

function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of INHERITED_ENV) {
    const value = process.env[key]
    if (value !== undefined && !value.startsWith('()')) env[key] = value
  }
  return env
}

function collector() {
  const chunks: Buffer[] = []
  let size = 0
  return {
    push(chunk: Buffer) {
      if (size >= MAX_OUTPUT_BYTES) return
      const kept = chunk.subarray(0, MAX_OUTPUT_BYTES - size)
      chunks.push(kept)
      size += kept.length
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  }
}

export const processExec: HookExec = (command, input, opts) =>
  new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(abortError())
    // detached：子进程成为进程组组长，结束时连同 sh -c 派生的子进程一起结束。
    const child = spawn(command, {
      shell: true,
      detached: true,
      env: safeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    })
    const stdout = collector()
    const stderr = collector()
    let timedOut = false
    let aborted = false
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        // 进程组已经结束。
      }
    }
    const terminate = () => {
      killGroup('SIGTERM')
      killTimer ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
    }
    const onAbort = () => {
      aborted = true
      terminate()
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, opts.timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', (code) => {
      cleanup()
      if (aborted) return reject(abortError())
      resolve({ exitCode: code, stdout: stdout.text(), stderr: stderr.text(), timedOut })
    })
  })
