// 取消随时生效（设计 §3.1）：运行取消时，正在执行的 hook 收到取消信号，运行不等 hook 超时。

import { describe, expect, it } from 'vitest'
import {
  adaptHooks,
  createEngine,
  defineAgent,
  defineTask,
  fakeModel,
  modelHub,
  type HookResult,
  type HookRunner,
} from './index.js'

describe('cancellation reaches components', () => {
  it('AC-015 aborts a running hook when the run is cancelled', async () => {
    let seen: AbortSignal | undefined
    let calls = 0
    const runner: HookRunner = {
      kind: 'hook',
      run: (_spec, _input, opts) =>
        new Promise<HookResult>((resolve) => {
          calls += 1
          seen = opts?.signal
          const done = () => resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false })
          if (opts?.signal?.aborted) done()
          opts?.signal?.addEventListener('abort', done, { once: true })
        }),
    }
    const model = fakeModel({ model: 'main', replies: [{ text: '答案' }] })
    const engine = createEngine({
      services: {
        models: modelHub({ providers: [model], default: model.ref }),
        hosts: [runner],
        logger: { log: () => {} },
      },
    })
    const hooks = adaptHooks([{ event: 'Stop', command: 'verify.sh', timeoutMs: 60_000 }])
    const run = engine
      .environment({ name: 'e', principal: { reachable: true }, checks: hooks.checks })
      .start(
        defineAgent({
          id: 'a',
          instructions: [{ role: 'system', parts: [{ type: 'text', text: 'x' }] }],
        }),
        defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text: '你好' }] }] }),
      )
    for (let i = 0; i < 100 && calls === 0; i++) await new Promise((r) => setTimeout(r, 5))
    expect(calls).toBe(1)
    expect(seen).toBeDefined()
    const startedAt = Date.now()
    run.abort('user')
    const result = await run.result
    expect(result).toMatchObject({ status: 'aborted', code: 'user' })
    expect(seen!.aborted).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})
