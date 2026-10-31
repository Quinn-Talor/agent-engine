import { describe, expect, it, vi } from 'vitest'
import { defineAgent, delegationHost, type Environment } from '../../api.js'
import { prepareCtx } from './prepare.fixture.js'
import { subagent } from './subagent.js'

const researcher = defineAgent({
  id: 'researcher',
  instructions: [
    { role: 'system', parts: [{ type: 'text', text: `负责查资料。${'细节'.repeat(150)}` }] },
  ],
})

describe('subagent', () => {
  it('AC-014 identifies itself by name and the child fingerprint', () => {
    expect(subagent(researcher)).toMatchObject({
      id: 'subagent:researcher',
      version: '1',
      kind: 'subagent',
      config: {
        name: 'researcher',
        agent: 'researcher',
        fingerprint: researcher.fingerprint,
        budget: null,
      },
    })
    expect(
      subagent(researcher, { name: 'peer_finder', budget: { maxTotalMs: 60_000 } }),
    ).toMatchObject({
      id: 'subagent:peer_finder',
      config: { name: 'peer_finder', budget: { maxTotalMs: 60_000 } },
    })
  })

  it('AC-007 registers with the delegation host before its first await', async () => {
    const host = delegationHost()
    const register = vi.spyOn(host, 'register')
    const environment = { name: 'strict' } as Environment
    const pending = subagent(researcher, { description: '查可比公司', environment }).prepare(
      prepareCtx({ host: <T>(kind: string) => (kind === 'delegation' ? host : undefined) as T }),
    )
    expect(register).toHaveBeenCalledWith('r1', {
      name: 'researcher',
      description: '查可比公司',
      agent: researcher,
      environment,
    })
    const prepared = await pending
    expect(prepared.tools.map((t) => t.name)).toEqual(['delegate'])
    expect(prepared.snapshot).toEqual({ fingerprint: researcher.fingerprint })
    expect(prepared.description).toEqual([
      {
        role: 'system',
        parts: [
          { type: 'text', text: '可委托的子 agent：researcher — 查可比公司。用 delegate 委托。' },
        ],
      },
    ])
    expect(typeof prepared.release).toBe('function')
  })

  it('describes itself with the first 200 characters of its instructions by default', async () => {
    const host = delegationHost()
    const register = vi.spyOn(host, 'register')
    await subagent(researcher).prepare(prepareCtx({ host: <T>() => host as T }))
    const description = register.mock.calls[0]![1].description
    expect(description).toHaveLength(200)
    expect(description.startsWith('负责查资料。')).toBe(true)
  })
})
